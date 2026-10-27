#include "app.h"
#include "esp_hosted.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/ble_uuid.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_random.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

/* UUID 在 NimBLE 中为 little endian byte array。UUID 与前端合同一致。 */
static const ble_uuid128_t svc=BLE_UUID128_INIT(0x01,0x00,0x00,0xc5,0x9c,0xbb,0x79,0x9d,0x95,0x4f,0xc5,0x72,0x01,0x00,0x77,0x9c);
static const ble_uuid128_t rx_uuid=BLE_UUID128_INIT(0x01,0x00,0x00,0xc5,0x9c,0xbb,0x79,0x9d,0x95,0x4f,0xc5,0x72,0x02,0x00,0x77,0x9c);
static const ble_uuid128_t tx_uuid=BLE_UUID128_INIT(0x01,0x00,0x00,0xc5,0x9c,0xbb,0x79,0x9d,0x95,0x4f,0xc5,0x72,0x03,0x00,0x77,0x9c);
static uint16_t tx_handle,conn=BLE_HS_CONN_HANDLE_NONE;
static uint8_t own_addr_type;
static ai_line_buffer_t input;
static char response[512]="{\"ok\":true,\"data\":{\"protocol\":1}}\n";
static char token[33];static int64_t window_until;static bool synced;
static bool window_open(void){return esp_timer_get_time()/1000<window_until;}
static bool token_matches(const char *s){if(!s||strlen(s)!=32)return false;unsigned diff=0;for(unsigned i=0;i<32;++i)diff|=(unsigned)(s[i]^token[i]);return diff==0;}
static void reply(cJSON *r){
    char *s=cJSON_PrintUnformatted(r);cJSON_Delete(r);if(!s)return;
    snprintf(response,sizeof response,"%s\n",s);free(s);
    if(conn!=BLE_HS_CONN_HANDLE_NONE){size_t n=strlen(response),offset=0;uint16_t mtu=ble_att_mtu(conn);size_t fragment=mtu>3?mtu-3:20;
        while(offset<n){size_t part=n-offset;if(part>fragment)part=fragment;struct os_mbuf *om=ble_hs_mbuf_from_flat(response+offset,part);if(!om||ble_gatts_notify_custom(conn,tx_handle,om))break;offset+=part;}}
}
static void request(uint16_t handle,const char *line){
    cJSON *q=cJSON_Parse(line),*r=cJSON_CreateObject();
    cJSON *id=cJSON_GetObjectItemCaseSensitive(q,"id"),*op=cJSON_GetObjectItemCaseSensitive(q,"op"),*args=cJSON_GetObjectItemCaseSensitive(q,"args"),*t=cJSON_GetObjectItemCaseSensitive(q,"token");
    if(id)cJSON_AddItemToObject(r,"id",cJSON_Duplicate(id,true));
    bool ok=false;const char *error="invalid_request";char why[96]="invalid_args";
    if(cJSON_IsString(op)&&!strcmp(op->valuestring,"info")){
        cJSON *d=cJSON_CreateObject();cJSON_AddNumberToObject(d,"protocol",1);cJSON_AddStringToObject(d,"device_id",CONFIG_AI_DEVICE_ID);cJSON_AddBoolToObject(d,"pairing_window",window_open());cJSON_AddStringToObject(d,"hardware_status","unverified");cJSON_AddBoolToObject(d,"uart_enabled",CONFIG_AI_UART_ENABLE);cJSON_AddItemToObject(r,"data",d);ok=true;
    }else if(cJSON_IsString(op)){
        struct ble_gap_conn_desc desc;bool encrypted=ble_gap_conn_find(handle,&desc)==0&&desc.sec_state.encrypted;
        if(!encrypted)error="encrypted_link_required";
        else if(!window_open())error="physical_pairing_window_closed";
        else if(!cJSON_IsString(t)||!token_matches(t->valuestring))error="invalid_session_token";
        else if(!strcmp(op->valuestring,"wifi_config")){
            cJSON *s=cJSON_GetObjectItemCaseSensitive(args,"ssid"),*p=cJSON_GetObjectItemCaseSensitive(args,"password");
            if(cJSON_IsString(s)&&cJSON_IsString(p))ok=ai_wifi_configure(s->valuestring,p->valuestring);
            error="wifi_configuration_rejected";
        }else if(!strcmp(op->valuestring,"move")||!strcmp(op->valuestring,"mode")){ok=ai_local_command(op->valuestring,args,why,sizeof why);error=why;
            if(ok){cJSON *d=cJSON_CreateObject();cJSON_AddStringToObject(d,"status","queued");cJSON_AddItemToObject(r,"data",d);}}
        else error="unsupported_operation";
    }
    cJSON_AddBoolToObject(r,"ok",ok);if(!ok)cJSON_AddStringToObject(r,"error",error);reply(r);cJSON_Delete(q);
}
static int access_cb(uint16_t handle,uint16_t attr,struct ble_gatt_access_ctxt *ctxt,void *arg){
    (void)attr;(void)arg;
    if(ctxt->op==BLE_GATT_ACCESS_OP_READ_CHR)return os_mbuf_append(ctxt->om,response,strlen(response))?BLE_ATT_ERR_INSUFFICIENT_RES:0;
    if(ctxt->op!=BLE_GATT_ACCESS_OP_WRITE_CHR)return BLE_ATT_ERR_UNLIKELY;
    uint16_t n=OS_MBUF_PKTLEN(ctxt->om);if(n>512)return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    uint8_t bytes[512];if(ble_hs_mbuf_to_flat(ctxt->om,bytes,sizeof bytes,NULL))return BLE_ATT_ERR_UNLIKELY;
    for(unsigned i=0;i<n;++i){int status=ai_line_feed(&input,bytes[i]);if(status==1){request(handle,input.bytes);input.used=0;}else if(status<0){cJSON *e=cJSON_CreateObject();cJSON_AddBoolToObject(e,"ok",false);cJSON_AddStringToObject(e,"error","line_too_long");reply(e);}}
    return 0;
}
static const struct ble_gatt_svc_def services[]={
    {.type=BLE_GATT_SVC_TYPE_PRIMARY,.uuid=&svc.u,.characteristics=(struct ble_gatt_chr_def[]){
        {.uuid=&rx_uuid.u,.access_cb=access_cb,.flags=BLE_GATT_CHR_F_WRITE},
        {.uuid=&tx_uuid.u,.access_cb=access_cb,.flags=BLE_GATT_CHR_F_READ|BLE_GATT_CHR_F_NOTIFY,.val_handle=&tx_handle},{0}}},{0}};
static void advertise(void);
static int gap_event(struct ble_gap_event *e,void *arg){
    (void)arg;switch(e->type){
    case BLE_GAP_EVENT_CONNECT:if(e->connect.status==0){conn=e->connect.conn_handle;memset(&input,0,sizeof input);ble_gap_security_initiate(conn);}else advertise();break;
    case BLE_GAP_EVENT_DISCONNECT:conn=BLE_HS_CONN_HANDLE_NONE;memset(token,0,sizeof token);window_until=0;memset(&input,0,sizeof input);break;
    case BLE_GAP_EVENT_ADV_COMPLETE:if(window_open())advertise();break;
    default:break;}return 0;
}
static void advertise(void){
    if(!synced||!window_open()||conn!=BLE_HS_CONN_HANDLE_NONE)return;
    struct ble_hs_adv_fields f={0};const char *name="Inspect-P4";f.flags=BLE_HS_ADV_F_DISC_GEN|BLE_HS_ADV_F_BREDR_UNSUP;f.name=(uint8_t *)name;f.name_len=strlen(name);f.name_is_complete=1;
    f.uuids128=(ble_uuid128_t *)&svc;f.num_uuids128=1;f.uuids128_is_complete=1;
    /* UUID 放主广播，名称放 scan response，避免 31 字节限制。 */
    f.name=NULL;f.name_len=0;if(ble_gap_adv_set_fields(&f))return;struct ble_hs_adv_fields scan={.name=(uint8_t *)name,.name_len=10,.name_is_complete=1};ble_gap_adv_rsp_set_fields(&scan);
    struct ble_gap_adv_params p={.conn_mode=BLE_GAP_CONN_MODE_UND,.disc_mode=BLE_GAP_DISC_MODE_GEN};ble_gap_adv_start(own_addr_type,NULL,120000,&p,gap_event,NULL);
}
static void on_sync(void){if(ble_hs_id_infer_auto(0,&own_addr_type)==0){synced=true;advertise();}}
static void host_task(void *arg){(void)arg;nimble_port_run();nimble_port_freertos_deinit();}
static void pairing_task(void *arg){
    (void)arg;unsigned held=0;bool triggered=false;
    for(;;){if(gpio_get_level(CONFIG_AI_PAIRING_BUTTON)==0){if(held<30)++held;if(held==30&&!triggered){
        uint8_t random[16];esp_fill_random(random,sizeof random);for(unsigned i=0;i<16;++i)snprintf(token+2*i,3,"%02x",random[i]);window_until=esp_timer_get_time()/1000+120000;triggered=true;
        /* 仅物理 USB 控制台给操作者一次性维护令牌；不通过 BLE info 广播。 */
        printf("\nPhysical maintenance token (120 seconds, USB only): %s\n",token);advertise();}}
        else{held=0;triggered=false;}
        if(!window_open()){ble_gap_adv_stop();if(conn!=BLE_HS_CONN_HANDLE_NONE)ble_gap_terminate(conn,BLE_ERR_REM_USER_CONN_TERM);memset(token,0,sizeof token);}
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
void ai_ble_start(void){
    /* Wi-Fi启动后同一 Hosted SDIO transport 复用远端 C6。 */
    if(esp_hosted_connect_to_slave()!=ESP_OK||esp_hosted_bt_controller_init()!=ESP_OK||esp_hosted_bt_controller_enable()!=ESP_OK){ESP_LOGE("ble","Hosted controller unavailable");return;}
    if(nimble_port_init()!=ESP_OK){ESP_LOGE("ble","NimBLE init failed");return;}
    ble_hs_cfg.sync_cb=on_sync;ble_hs_cfg.sm_io_cap=BLE_HS_IO_NO_INPUT_OUTPUT;ble_hs_cfg.sm_bonding=0;ble_hs_cfg.sm_sc=1;
    /* Just Works提供链路加密，不宣称MITM保护；窗口+USB令牌另行约束写权限。 */
    ble_svc_gap_init();ble_svc_gatt_init();ble_svc_gap_device_name_set("Inspect-P4");
    if(ble_gatts_count_cfg(services)||ble_gatts_add_svcs(services)){ESP_LOGE("ble","GATT setup failed");return;}
    gpio_config_t button={.pin_bit_mask=1ULL<<CONFIG_AI_PAIRING_BUTTON,.mode=GPIO_MODE_INPUT,.pull_up_en=GPIO_PULLUP_ENABLE};ESP_ERROR_CHECK(gpio_config(&button));
    nimble_port_freertos_init(host_task);xTaskCreate(pairing_task,"physical_pairing",4096,NULL,4,NULL);
}
