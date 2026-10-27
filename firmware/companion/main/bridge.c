#include "app.h"
#include "driver/uart.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_timer.h"
#include "esp_log.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <time.h>

typedef struct { ai_uart_frame_t frame; char id[64]; int64_t expires; char mode[12]; int target_preset; uint32_t generation; } queued_t;
static QueueHandle_t commands;
static uint16_t tx_seq;
static ai_replay_t replay;
static queued_t pending;
static bool awaiting_ack, awaiting_pose;
static int64_t pending_at;
static bool sync_pending;
static ai_preset_t sync_presets[3]; static unsigned sync_count, sync_step;
static int sync_revision;
static bool uart_synced, stop_requested;
static int64_t last_status_at;
static uint16_t last_status_seq;
static uint32_t control_generation;

static void reject_queued(const char *reason){
    queued_t old;
    while(commands&&xQueueReceive(commands,&old,0)==pdTRUE)
        if(old.id[0])ai_network_ack(old.id,"rejected",reason);
}

/* A cloud session must never carry its queued motion into a later session. */
void ai_bridge_disconnect(void) {
    ai_media_cancel("cloud_session_closed");
    ai_lock();
    if (commands) xQueueReset(commands);
    ++control_generation;ai_state.presets_installed=false;
    stop_requested=true;
    sync_pending=false;
    awaiting_ack=awaiting_pose=false;
    memset(&pending,0,sizeof pending);
    ai_state.active=-1;
    ++ai_state.observation_epoch;
    strcpy(ai_state.mode,"paused");
    ai_unlock();
}

static int64_t parse_iso(const cJSON *item) {
    if (!cJSON_IsString(item)) return 0;
    const char *s=item->valuestring; int y,m,d,h,min; double sec; char suffix;
    if (sscanf(s,"%d-%d-%dT%d:%d:%lf%c",&y,&m,&d,&h,&min,&sec,&suffix)!=7 || suffix!='Z' ||
        y<2024 || y>2099 || m<1 || m>12 || d<1 || d>31 || h<0 || h>23 || min<0 || min>59 || !isfinite(sec) || sec<0 || sec>=60) return 0;
    struct tm t={.tm_year=y-1900,.tm_mon=m-1,.tm_mday=d,.tm_hour=h,.tm_min=min,.tm_sec=(int)sec};
    return (int64_t)mktime(&t)*1000+(int)((sec-(int)sec)*1000+.5);
}
static bool number(const cJSON *args, const char *key, double *out) {
    const cJSON *v=cJSON_GetObjectItemCaseSensitive(args,key);
    if (!cJSON_IsNumber(v)||!isfinite(v->valuedouble)) return false;
    *out=v->valuedouble; return true;
}
static void uart_send(ai_uart_frame_t *f) {
    char buf[80]; f->seq=++tx_seq; int n=ai_uart_encode(f,buf,sizeof buf);
    if(n>0) uart_write_bytes(UART_NUM_1,buf,n);
}
static bool make_command(const char *op,const cJSON *args,queued_t *q,char *err,size_t cap) {
    if(sync_pending){snprintf(err,cap,"presets_sync_in_progress");return false;}
    q->generation=control_generation;
    q->target_preset=-1;
    if (!strcmp(op,"move")) { double p,t;
        if(!number(args,"pan_deg",&p)||!number(args,"tilt_deg",&t)||p<30||p>150||t<45||t>120||!ai_motion_valid((int)lround(p*10),(int)lround(t*10))) {snprintf(err,cap,"angle_out_of_range");return false;}
        q->frame=(ai_uart_frame_t){.type=1,.a=(int)lround(p*10),.b=(int)lround(t*10)};
    } else if(!strcmp(op,"mode")) {
        cJSON *m=cJSON_GetObjectItemCaseSensitive(args,"mode"); if(!cJSON_IsString(m))return false;
        int v=!strcmp(m->valuestring,"manual")?0:!strcmp(m->valuestring,"patrol")?1:!strcmp(m->valuestring,"paused")?2:-1;
        if(v<0)return false;
        q->frame=(ai_uart_frame_t){.type=3,.a=v}; snprintf(q->mode,sizeof q->mode,"%s",m->valuestring);
        if(v==1&&!ai_state.presets_installed){snprintf(err,cap,"presets_not_installed");return false;}
    } else if(!strcmp(op,"preset")) {
        if(!ai_state.presets_installed){snprintf(err,cap,"presets_not_installed");return false;}
        cJSON *id=cJSON_GetObjectItemCaseSensitive(args,"preset_id"); if(!cJSON_IsString(id))return false;
        ai_lock(); for(unsigned i=0;i<ai_state.preset_count;++i) if(!strcmp(ai_state.presets[i].id,id->valuestring))q->target_preset=(int)i; ai_unlock();
        if(q->target_preset<0){snprintf(err,cap,"unknown_preset");return false;}
        q->frame=(ai_uart_frame_t){.type=2,.a=q->target_preset};
    } else {snprintf(err,cap,"unsupported_command");return false;}
    return true;
}
bool ai_local_command(const char *op,const cJSON *args,char *err,size_t cap) {
    if(!CONFIG_AI_UART_ENABLE) {snprintf(err,cap,"hardware_not_enabled");return false;}
    if(!uart_synced) {snprintf(err,cap,"stm32_not_synchronized");return false;}
    ai_lock();
    queued_t q={.expires=ai_now_ms()+5000};
    if(!make_command(op,args,&q,err,cap)){ai_unlock();return false;}
    if(xQueueSend(commands,&q,0)!=pdTRUE){snprintf(err,cap,"busy");ai_unlock();return false;} ai_unlock();return true;
}
bool ai_bridge_command(const cJSON *cmd,char *err,size_t cap) {
    cJSON *id=cJSON_GetObjectItemCaseSensitive(cmd,"command_id"),*op=cJSON_GetObjectItemCaseSensitive(cmd,"type"),*args=cJSON_GetObjectItemCaseSensitive(cmd,"args");
    if(!cJSON_IsString(id)||!cJSON_IsString(op)){snprintf(err,cap,"invalid_command");return false;}
    int64_t expires=parse_iso(cJSON_GetObjectItemCaseSensitive(cmd,"expires_at"));
    ai_lock(); bool allowed=ai_command_admit(&replay,id->valuestring,parse_iso(cJSON_GetObjectItemCaseSensitive(cmd,"created_at")),expires,ai_now_ms(),ai_clock_valid()); ai_unlock();
    if(!allowed){snprintf(err,cap,"expired_replay_or_clock_unsynced");return false;}
    if(!strcmp(op->valuestring,"capture")||!strcmp(op->valuestring,"recheck")) {
        /* 此操作产生新的结构化观察；不伪造不存在的 JPEG evidence_url。 */
        if(!ai_request_recheck_command(id->valuestring,expires)){snprintf(err,cap,"camera_unavailable_or_preset_not_stable");return false;}
        return true;
    }
    if(!CONFIG_AI_UART_ENABLE){snprintf(err,cap,"hardware_not_enabled");return false;}
    if(!uart_synced){snprintf(err,cap,"stm32_not_synchronized");return false;}
    ai_lock();
    queued_t q={.expires=expires}; snprintf(q.id,sizeof q.id,"%s",id->valuestring);
    if(!make_command(op->valuestring,args,&q,err,cap)){ai_unlock();return false;}
    if(xQueueSend(commands,&q,0)!=pdTRUE){snprintf(err,cap,"busy");ai_unlock();return false;} ai_unlock();return true;
}
static void sync_ack(int revision,const char *status) {
    cJSON *m=cJSON_CreateObject();cJSON_AddStringToObject(m,"type","presets_ack");cJSON_AddNumberToObject(m,"revision",revision);cJSON_AddStringToObject(m,"status",status);ai_network_send(m);
}
void ai_bridge_presets(const cJSON *msg) {
    cJSON *items=cJSON_GetObjectItemCaseSensitive(msg,"presets"),*rev=cJSON_GetObjectItemCaseSensitive(msg,"revision");
    if(!cJSON_IsArray(items)||!cJSON_IsNumber(rev))return;
    unsigned n=(unsigned)cJSON_GetArraySize(items);if(n<1||n>3)return;
    ai_preset_t checked[3]={0};
    for(unsigned i=0;i<n;++i){cJSON *p=cJSON_GetArrayItem(items,(int)i),*id=cJSON_GetObjectItemCaseSensitive(p,"id"),*r=cJSON_GetObjectItemCaseSensitive(p,"roi");double pan,tilt,x,y,w,h;
        if(!cJSON_IsString(id)||strlen(id->valuestring)>=sizeof checked[i].id||!number(p,"pan_deg",&pan)||!number(p,"tilt_deg",&tilt)||!number(r,"x",&x)||!number(r,"y",&y)||!number(r,"w",&w)||!number(r,"h",&h))return;
        if(pan<30||pan>150||tilt<45||tilt>120||x<0||y<0||w<=0||h<=0||x+w>1||y+h>1)return;
        checked[i].pan10=(int)lround(pan*10);checked[i].tilt10=(int)lround(tilt*10);checked[i].roi=(ai_roi_t){x,y,w,h};
        if(!ai_motion_valid(checked[i].pan10,checked[i].tilt10)||!ai_roi_valid(checked[i].roi))return;
        snprintf(checked[i].id,sizeof checked[i].id,"%s",id->valuestring);
    }
    ai_lock();
    if(sync_pending||awaiting_ack||awaiting_pose){sync_ack(rev->valueint,"rejected");ai_unlock();return;}
    memcpy(sync_presets,checked,sizeof checked);sync_count=n;sync_revision=rev->valueint;sync_step=0;
    reject_queued("presets_changed");++control_generation;ai_state.presets_installed=false;
    ai_media_cancel("presets_changed");
    ++ai_state.observation_epoch;ai_state.active=-1;
    if(CONFIG_AI_UART_ENABLE&&uart_synced)sync_pending=true;
    else {sync_ack(sync_revision,"rejected");} /* 无 MCU ACK 就不能假装坐标已安装。 */
    ai_unlock();
}
static void finish(bool accepted,const char *reason){
    if(pending.id[0])ai_network_ack(pending.id,accepted?"completed":"rejected",reason);
    awaiting_ack=awaiting_pose=false;memset(&pending,0,sizeof pending);
}
static void receive(const ai_uart_frame_t *f){
    ai_lock();
    if(f->type==101&&f->b==2){
        /* Reject-2 on a heartbeat also matters: live status alone does not mean
         * this sender's sequence is accepted after an independent MCU reset. */
        if(awaiting_ack||awaiting_pose)finish(false,"stm32_sequence_rejected");
        if(sync_pending){sync_ack(sync_revision,"rejected");sync_pending=false;}
        else if(sync_count)sync_ack(sync_revision,"rejected");
        uart_synced=false;stop_requested=true;xQueueReset(commands);
        ++control_generation;ai_state.presets_installed=false;
        ai_state.active=-1;++ai_state.observation_epoch;strcpy(ai_state.mode,"paused");
        ai_media_cancel("stm32_sequence_reset");ai_unlock();return;
    }
    if((f->type==102&&ai_motion_valid(f->a,f->b))||
       (f->type==103&&f->a>=0&&f->a<=3&&(f->b==255||(f->b>=0&&f->b<3)))) {
        uint16_t advance=(uint16_t)(f->seq-last_status_seq);
        if(uart_synced&&advance>128) {
            /* A status discontinuity can indicate an independently reset MCU.
             * Its untrusted old targets are never resumed; re-establish paused. */
            if(awaiting_ack||awaiting_pose)finish(false,"stm32_sequence_discontinuity");
            if(sync_pending){sync_ack(sync_revision,"rejected");sync_pending=false;}
            uart_synced=false;
            ++control_generation;ai_state.presets_installed=false;
        }
        last_status_at=esp_timer_get_time()/1000;
        last_status_seq=f->seq;
        if(!uart_synced) {
            /* Only incoming valid status establishes last consumed sequence. */
            tx_seq=f->seq;uart_synced=true;stop_requested=true;
            xQueueReset(commands);sync_pending=false;awaiting_ack=awaiting_pose=false;
            /* The MCU lost preset RAM as well as seq. Reinstall the last desired
             * snapshot/count, and prevent preset/patrol until all ACKs arrive. */
            if(sync_count){sync_step=0;sync_pending=true;sync_ack(sync_revision,"rejected");}
            ESP_LOGI("bridge","STM32 sequence synchronized; request paused before new movement");
        }
    }
    if(f->type==102&&ai_motion_valid(f->a,f->b)){ai_state.pan10=f->a;ai_state.tilt10=f->b;}
    if(f->type==103&&f->a>=0&&f->a<=3){if(ai_state.phase!=f->a){ai_state.stationary_since=esp_timer_get_time()/1000;++ai_state.observation_epoch;}ai_state.phase=f->a;ai_state.active=f->b>=0&&f->b<(int)ai_state.preset_count?f->b:-1;}
    if(f->type==101&&awaiting_ack&&f->seq==pending.frame.seq&&f->a==pending.frame.type){
        if(f->b!=0){if(sync_pending){sync_ack(sync_revision,"rejected");sync_pending=false;}finish(false,"stm32_rejected");}
        else {awaiting_ack=false;
            if(sync_pending){++sync_step;if(sync_step>sync_count+1){memcpy(ai_state.presets,sync_presets,sizeof sync_presets);ai_state.preset_count=sync_count;ai_state.preset_revision=sync_revision;ai_state.presets_installed=true;strcpy(ai_state.mode,"paused");ai_state.active=-1;++ai_state.observation_epoch;sync_pending=false;sync_ack(sync_revision,"applied");}}
            else {if(pending.id[0])ai_network_ack(pending.id,"acknowledged",NULL);
                ai_media_cancel("motion_or_mode_changed");
                if(pending.frame.type==3){strcpy(ai_state.mode,pending.mode);++ai_state.observation_epoch;if(pending.frame.a==2)ai_state.active=-1;finish(true,NULL);}else {strcpy(ai_state.mode,"manual");ai_state.phase=1;++ai_state.observation_epoch;awaiting_pose=true;}}
        }
    }
    if(awaiting_pose&&(ai_state.phase==0||ai_state.phase==3)){
        int p=pending.frame.type==1?pending.frame.a:ai_state.presets[pending.target_preset].pan10;
        int t=pending.frame.type==1?pending.frame.b:ai_state.presets[pending.target_preset].tilt10;
        if(ai_state.pan10==p&&ai_state.tilt10==t)finish(true,NULL);
    }ai_unlock();
}
static int64_t last_hb;
/* One production scheduler step; host regression drives the same function. */
static void bridge_tick(int64_t now){
    ai_lock();
        /* Wi-Fi失联仍保留短时BLE维护；网络退出会排队paused，未启用 UART 时绝不写引脚。 */
        if(uart_synced&&now-last_status_at>1600) {
            uart_synced=false;stop_requested=true;
            ++control_generation;ai_state.presets_installed=false;
            if(sync_pending){sync_ack(sync_revision,"rejected");sync_pending=false;}
            if(awaiting_ack||awaiting_pose)finish(false,"stm32_status_lost");
            xQueueReset(commands);ai_state.active=-1;strcpy(ai_state.mode,"paused");
        }
        if(uart_synced&&now-last_hb>=400){ai_uart_frame_t hb={.type=4};uart_send(&hb);last_hb=now;}
        if((awaiting_ack&&now-pending_at>1000)||(awaiting_pose&&now-pending_at>8000)){
            if(sync_pending){sync_ack(sync_revision,"rejected");sync_pending=false;}finish(false,"stm32_timeout");
        }
        if(uart_synced&&!awaiting_ack&&!awaiting_pose){
            bool send=false;
            if(stop_requested){memset(&pending,0,sizeof pending);pending.frame=(ai_uart_frame_t){.type=3,.a=2};strcpy(pending.mode,"paused");stop_requested=false;send=true;}
            else if(sync_pending){memset(&pending,0,sizeof pending);
                if(sync_step==0)pending.frame=(ai_uart_frame_t){.type=3,.a=2};
                else if(sync_step<=sync_count)pending.frame=(ai_uart_frame_t){.type=(int)(9+sync_step),.a=sync_presets[sync_step-1].pan10,.b=sync_presets[sync_step-1].tilt10};
                else pending.frame=(ai_uart_frame_t){.type=13,.a=(int)sync_count};
                send=true;}
            else if(xQueueReceive(commands,&pending,0)==pdTRUE){
                if(pending.generation!=control_generation)finish(false,"configuration_or_session_changed");
                else if(pending.expires<=ai_now_ms())finish(false,"expired_before_uart");else send=true;
            }
            if(send){uart_send(&pending.frame);awaiting_ack=true;pending_at=now;}
        }ai_unlock();
}
static void bridge_task(void *arg){
    (void)arg;char rx[80];size_t used=0;bool discard=false;
    for(;;){bridge_tick(esp_timer_get_time()/1000);
        uint8_t c;while(uart_read_bytes(UART_NUM_1,&c,1,0)==1){
            if(c=='@'){used=0;discard=false;}
            if(used>=sizeof rx){discard=true;used=0;}
            if(!discard)rx[used++]=(char)c;
            if(c=='\n'){ai_uart_frame_t f;if(!discard&&ai_uart_decode(rx,used,&f))receive(&f);used=0;discard=false;}
        }vTaskDelay(pdMS_TO_TICKS(10));
    }
}
void ai_bridge_start(void){
    commands=xQueueCreate(4,sizeof(queued_t));configASSERT(commands);
    if(!CONFIG_AI_UART_ENABLE){ESP_LOGW("bridge","UART disabled pending board verification");return;}
    uart_config_t c={.baud_rate=115200,.data_bits=UART_DATA_8_BITS,.parity=UART_PARITY_DISABLE,.stop_bits=UART_STOP_BITS_1,.flow_ctrl=UART_HW_FLOWCTRL_DISABLE,.source_clk=UART_SCLK_DEFAULT};
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_1,1024,0,0,NULL,0));ESP_ERROR_CHECK(uart_param_config(UART_NUM_1,&c));
    ESP_ERROR_CHECK(uart_set_pin(UART_NUM_1,CONFIG_AI_UART_TX,CONFIG_AI_UART_RX,UART_PIN_NO_CHANGE,UART_PIN_NO_CHANGE));
    ai_state.uart_enabled=true;xTaskCreate(bridge_task,"stm32_bridge",6144,NULL,8,NULL);
}
