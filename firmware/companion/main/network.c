#include "app.h"
#include "event_record.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_crt_bundle.h"
#include "esp_websocket_client.h"
#include "esp_sntp.h"
#include "esp_random.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static esp_websocket_client_handle_t ws;
static SemaphoreHandle_t send_mutex, event_mutex;
static uint32_t sequence, boot_id, event_counter;
static bool connected, hello_accepted;
static char auth[256], rx[8192]; static size_t rx_used;
typedef struct { char id[64]; char json[640]; } stored_event_t;
typedef struct { uint32_t version; unsigned count; unsigned dropped; stored_event_t items[16]; } outbox_t;
static outbox_t outbox;
static nvs_handle_t store;

static void save_outbox(void){
    esp_err_t e=nvs_set_blob(store,"outbox",&outbox,sizeof outbox);
    if(e==ESP_OK)e=nvs_commit(store);
    if(e!=ESP_OK)ESP_LOGE("outbox","Persistence failed: %s",esp_err_to_name(e));
}
bool ai_network_send(cJSON *msg){
    if(!msg)return false;
    xSemaphoreTake(send_mutex,portMAX_DELAY);bool ok=false;
    if(connected&&hello_accepted){cJSON_AddNumberToObject(msg,"seq",++sequence);char *data=cJSON_PrintUnformatted(msg);
        if(data){ok=esp_websocket_client_send_text(ws,data,strlen(data),pdMS_TO_TICKS(1000))>=0;free(data);}}
    xSemaphoreGive(send_mutex);cJSON_Delete(msg);return ok;
}
void ai_network_ack(const char *id,const char *status,const char *reason){
    cJSON *m=cJSON_CreateObject();cJSON_AddStringToObject(m,"type","ack");cJSON_AddStringToObject(m,"command_id",id);cJSON_AddStringToObject(m,"status",status);if(reason)cJSON_AddStringToObject(m,"reason",reason);ai_network_send(m);
}
void ai_network_event(const char *kind,const char *preset_id,const ai_observation_t *o){
    char id[64];snprintf(id,sizeof id,"%08lx-%08lx",(unsigned long)boot_id,(unsigned long)++event_counter);
    ai_lock();int revision=ai_state.preset_revision;ai_unlock();
    ai_network_event_evidence(id,kind,preset_id,revision,ai_now_ms(),o,NULL);
}
void ai_network_event_evidence(const char *id,const char *kind,const char *preset_id,int revision,int64_t observed_ms,const ai_observation_t *o,const char *evidence_url){
    char stamp[32]="";
    if(observed_ms>1700000000000LL){time_t observed=(time_t)(observed_ms/1000);struct tm tm;gmtime_r(&observed,&tm);strftime(stamp,sizeof stamp,"%Y-%m-%dT%H:%M:%SZ",&tm);}
    cJSON *e=ai_build_event_record(id,kind,preset_id,revision,stamp[0]?stamp:NULL,o,evidence_url);
    char *raw=cJSON_PrintUnformatted(e);cJSON_Delete(e);if(!raw)return;
    xSemaphoreTake(event_mutex,portMAX_DELAY);
    if(strlen(raw)<sizeof outbox.items[0].json){
        if(outbox.count>=16){memmove(outbox.items,outbox.items+1,15*sizeof outbox.items[0]);outbox.count=15;++outbox.dropped;}
        stored_event_t *entry=&outbox.items[outbox.count++];snprintf(entry->id,sizeof entry->id,"%s",id);snprintf(entry->json,sizeof entry->json,"%s",raw);save_outbox();
    }xSemaphoreGive(event_mutex);free(raw);
}
static void event_ack(const char *id){
    xSemaphoreTake(event_mutex,portMAX_DELAY);
    for(unsigned i=0;i<outbox.count;++i)if(!strcmp(outbox.items[i].id,id)){memmove(outbox.items+i,outbox.items+i+1,(outbox.count-i-1)*sizeof outbox.items[0]);--outbox.count;save_outbox();break;}
    xSemaphoreGive(event_mutex);
}
static void message(const char *json){
    cJSON *m=cJSON_Parse(json);if(!m)return;cJSON *t=cJSON_GetObjectItemCaseSensitive(m,"type");
    if(cJSON_IsString(t)){
        if(!strcmp(t->valuestring,"hello_ack")){hello_accepted=true;ai_lock();ai_state.online=true;ai_unlock();}
        else if(hello_accepted&&!strcmp(t->valuestring,"command")){cJSON *cmd=cJSON_GetObjectItemCaseSensitive(m,"command"),*id=cJSON_GetObjectItemCaseSensitive(cmd,"command_id");char error[96]="invalid_command";
            if(!ai_bridge_command(cmd,error,sizeof error)&&cJSON_IsString(id))ai_network_ack(id->valuestring,"rejected",error);
        }else if(hello_accepted&&!strcmp(t->valuestring,"presets"))ai_bridge_presets(m);
        else if(!strcmp(t->valuestring,"event_ack")){cJSON *id=cJSON_GetObjectItemCaseSensitive(m,"event_id");if(cJSON_IsString(id))event_ack(id->valuestring);}
    }cJSON_Delete(m);
}
static void ws_event(void *arg,esp_event_base_t base,int32_t id,void *event){
    (void)arg;(void)base;esp_websocket_event_data_t *d=event;
    if(id==WEBSOCKET_EVENT_CONNECTED){sequence=0;rx_used=0;connected=true;hello_accepted=false;
        char hello[180];snprintf(hello,sizeof hello,"{\"type\":\"hello\",\"device_id\":\"%s\",\"protocol\":1,\"source\":\"hardware\"}",CONFIG_AI_DEVICE_ID);esp_websocket_client_send_text(ws,hello,strlen(hello),pdMS_TO_TICKS(1000));
    }else if(id==WEBSOCKET_EVENT_DISCONNECTED){connected=hello_accepted=false;ai_lock();ai_state.online=false;ai_unlock();
        ai_bridge_disconnect();
    }else if(id==WEBSOCKET_EVENT_DATA){
        if(d->op_code!=1&&d->op_code!=0)return;
        if(d->op_code==1&&d->payload_offset==0)rx_used=0;
        if(d->data_len<0||d->payload_len<0||(size_t)d->payload_len>=sizeof rx||rx_used+(size_t)d->data_len>=sizeof rx){rx_used=0;return;}
        memcpy(rx+rx_used,d->data_ptr,d->data_len);rx_used+=d->data_len;
        if(d->fin&&d->payload_offset+d->data_len==d->payload_len){rx[rx_used]=0;message(rx);rx_used=0;}
    }
}
bool ai_wifi_configure(const char *ssid,const char *password){
    if(!ssid||!password||!strlen(ssid)||strlen(ssid)>32||strlen(password)<8||strlen(password)>63)return false;
    wifi_config_t cfg={0};memcpy(cfg.sta.ssid,ssid,strlen(ssid));memcpy(cfg.sta.password,password,strlen(password));cfg.sta.threshold.authmode=WIFI_AUTH_WPA2_PSK;
    if(esp_wifi_set_config(WIFI_IF_STA,&cfg)!=ESP_OK)return false;
    /* WIFI_STORAGE_FLASH 由 IDF 保存；绝不把口令写进日志或遥测。 */
    esp_wifi_disconnect();return esp_wifi_connect()==ESP_OK;
}
static void wifi_event(void *arg,esp_event_base_t base,int32_t id,void *data){
    (void)arg;(void)data;if(base==IP_EVENT&&id==IP_EVENT_STA_GOT_IP){ai_lock();ai_state.wifi=true;ai_unlock();}
    else if(base==WIFI_EVENT&&id==WIFI_EVENT_STA_DISCONNECTED){ai_lock();ai_state.wifi=false;ai_unlock();}
}
static void telemetry(void){
    ai_lock();ai_state_t snapshot=ai_state;ai_unlock();
    cJSON *m=cJSON_CreateObject(),*s=cJSON_CreateObject(),*obs=cJSON_CreateArray(),*v=cJSON_CreateObject();cJSON_AddStringToObject(m,"type","telemetry");cJSON_AddItemToObject(m,"state",s);
    cJSON_AddNumberToObject(s,"pan_deg",snapshot.pan10/10.);cJSON_AddNumberToObject(s,"tilt_deg",snapshot.tilt10/10.);cJSON_AddStringToObject(s,"mode",snapshot.mode);
    cJSON_AddStringToObject(s,"position_source","commanded");
    if(snapshot.active>=0)cJSON_AddStringToObject(s,"active_preset",snapshot.presets[snapshot.active].id);else cJSON_AddNullToObject(s,"active_preset");
    for(unsigned i=0;i<snapshot.preset_count;++i){cJSON *o=cJSON_CreateObject();cJSON_AddStringToObject(o,"preset_id",snapshot.presets[i].id);const char *name=ai_led_name(snapshot.presets[i].observation.state);cJSON_AddStringToObject(o,"state",!strcmp(name,"uncertain")?"unknown":name);cJSON_AddNumberToObject(o,"confidence",snapshot.presets[i].observation.confidence);cJSON_AddItemToArray(obs,o);}
    cJSON_AddItemToObject(s,"observations",obs);cJSON_AddBoolToObject(v,"available",snapshot.video);cJSON_AddItemToObject(s,"video",v);ai_network_send(m);
}
static void network_task(void *arg){
    (void)arg;unsigned tick=0;
    for(;;){ai_lock();bool wifi=ai_state.wifi;ai_unlock();
        if(!wifi){wifi_config_t cfg;if(esp_wifi_get_config(WIFI_IF_STA,&cfg)==ESP_OK&&cfg.sta.ssid[0])esp_wifi_connect();}
        if(wifi&&ai_clock_valid()&&!ws&&strlen(ai_ws_url)&&strlen(ai_device_token)){
            if(strncmp(ai_ws_url,"wss://",6)!=0||strchr(ai_device_token,'\r')||strchr(ai_device_token,'\n')||strlen(ai_device_token)>200){ESP_LOGE("network","Unsafe endpoint/token configuration; cloud disabled");vTaskDelete(NULL);}
            snprintf(auth,sizeof auth,"Authorization: Bearer %s\r\n",ai_device_token);
            esp_websocket_client_config_t c={.uri=ai_ws_url,.headers=auth,.crt_bundle_attach=esp_crt_bundle_attach,.reconnect_timeout_ms=3000,.network_timeout_ms=5000,.buffer_size=4096,.task_stack=8192};
            ws=esp_websocket_client_init(&c);if(ws){esp_websocket_register_events(ws,WEBSOCKET_EVENT_ANY,ws_event,NULL);esp_websocket_client_start(ws);}
        }
        if(connected&&hello_accepted){telemetry();
            xSemaphoreTake(event_mutex,portMAX_DELAY);if(outbox.count){cJSON *m=cJSON_CreateObject();cJSON_AddStringToObject(m,"type","event");cJSON_AddItemToObject(m,"event",cJSON_Parse(outbox.items[0].json));ai_network_send(m);}xSemaphoreGive(event_mutex);
        }
        ++tick;(void)tick;vTaskDelay(pdMS_TO_TICKS(2000));
    }
}
void ai_network_start(void){
    setenv("TZ","UTC0",1);tzset();boot_id=esp_random();
    send_mutex=xSemaphoreCreateMutex();event_mutex=xSemaphoreCreateMutex();configASSERT(send_mutex&&event_mutex);
    ESP_ERROR_CHECK(nvs_open("inspection",NVS_READWRITE,&store));size_t size=sizeof outbox;
    if(nvs_get_blob(store,"outbox",&outbox,&size)!=ESP_OK||size!=sizeof outbox||outbox.version!=1||outbox.count>16)outbox=(outbox_t){.version=1};
    ESP_ERROR_CHECK(esp_netif_init());ESP_ERROR_CHECK(esp_event_loop_create_default());esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg=WIFI_INIT_CONFIG_DEFAULT();ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,wifi_event,NULL));ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,wifi_event,NULL));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_FLASH));ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));ESP_ERROR_CHECK(esp_wifi_start());
    esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);esp_sntp_setservername(0,"pool.ntp.org");esp_sntp_init();
    xTaskCreate(network_task,"device_network",8192,NULL,5,NULL);
}
