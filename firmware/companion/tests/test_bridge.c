/* Includes production bridge to exercise its real static scheduler and RX path.
 * Only hardware/RTOS I/O is stubbed. No alternate state machine is implemented. */
#include "../main/bridge.c"
ai_state_t ai_state;
int64_t host_mono_ms=1000;
static int ack_revision[32],ack_count,completed_count,rejected_count;
static char ack_status[32][16];
void ai_lock(void){}
void ai_unlock(void){}
int64_t ai_now_ms(void){return 1800000000000LL+host_mono_ms;}
bool ai_clock_valid(void){return true;}
bool ai_network_send(cJSON *m){
    cJSON *t=cJSON_GetObjectItemCaseSensitive(m,"type");
    if(cJSON_IsString(t)&&!strcmp(t->valuestring,"presets_ack")){
        assert(ack_count<32);ack_revision[ack_count]=cJSON_GetObjectItemCaseSensitive(m,"revision")->valueint;
        snprintf(ack_status[ack_count++],16,"%s",cJSON_GetObjectItemCaseSensitive(m,"status")->valuestring);
    }cJSON_Delete(m);return true;
}
void ai_network_ack(const char *id,const char *status,const char *reason){(void)id;(void)reason;if(!strcmp(status,"completed"))++completed_count;if(!strcmp(status,"rejected"))++rejected_count;}
void ai_media_cancel(const char *reason){(void)reason;}
bool ai_request_recheck_command(const char *id,int64_t expires){(void)id;(void)expires;return false;}
static cJSON *presets(int revision){
    cJSON *m=cJSON_Parse("{\"type\":\"presets\",\"presets\":[{\"id\":\"one\",\"pan_deg\":55,\"tilt_deg\":90,\"roi\":{\"x\":0.1,\"y\":0.1,\"w\":0.4,\"h\":0.4}},{\"id\":\"two\",\"pan_deg\":125,\"tilt_deg\":90,\"roi\":{\"x\":0.2,\"y\":0.2,\"w\":0.4,\"h\":0.4}}]}");
    assert(m);cJSON_AddNumberToObject(m,"revision",revision);return m;
}
static void tick(void){host_mono_ms+=10;last_status_at=host_mono_ms;bridge_tick(host_mono_ms);}
static void accepted(void){assert(awaiting_ack);ai_uart_frame_t ack={pending.frame.seq,101,pending.frame.type,0};receive(&ack);}
static void sync_two(int revision){
    const int types[]={3,10,11,13};
    for(unsigned i=0;i<4;++i){tick();assert(awaiting_ack&&pending.frame.type==types[i]);if(types[i]==13)assert(pending.frame.a==2);accepted();}
    assert(!sync_pending&&ai_state.presets_installed&&ai_state.preset_count==2&&ai_state.preset_revision==revision);
}
int main(void){
    ai_bridge_start();uart_synced=true;last_status_at=host_mono_ms;ai_state.active=-1;strcpy(ai_state.mode,"paused");
    char error[96];cJSON *move=cJSON_Parse("{\"pan_deg\":90,\"tilt_deg\":90}"),*patrol=cJSON_Parse("{\"mode\":\"patrol\"}");
    assert(ai_local_command("move",move,error,sizeof error));assert(commands->count==1);
    cJSON *first=presets(7);ai_bridge_presets(first);cJSON_Delete(first);
    assert(commands->count==0&&sync_pending&&!ai_state.presets_installed);
    assert(!ai_local_command("move",move,error,sizeof error));
    cJSON *busy=presets(8);ai_bridge_presets(busy);cJSON_Delete(busy);
    assert(sync_revision==7&&ack_revision[0]==8&&!strcmp(ack_status[0],"rejected"));
    sync_two(7);assert(ack_revision[ack_count-1]==7&&!strcmp(ack_status[ack_count-1],"applied"));
    tick();assert(!awaiting_ack&&commands->count==0); /* old BLE move stayed discarded */
    assert(ai_local_command("mode",patrol,error,sizeof error));assert(commands->count==1);
    ai_uart_frame_t reject={tx_seq,101,4,2};receive(&reject);
    assert(!uart_synced&&!ai_state.presets_installed&&commands->count==0);
    assert(!ai_local_command("mode",patrol,error,sizeof error));
    ai_uart_frame_t reset_status={0,102,900,900};receive(&reset_status);
    assert(uart_synced&&sync_pending&&!ai_state.presets_installed);
    assert(!ai_local_command("mode",patrol,error,sizeof error));
    sync_two(7);assert(ai_local_command("mode",patrol,error,sizeof error));
    /* A queued move whose generation changed is rejected by the actual dispatcher. */
    xQueueReset(commands);queued_t old={.frame={.type=1,.a=900,.b=900},.expires=ai_now_ms()+1000,.generation=control_generation-1};strcpy(old.id,"old-session");xQueueSend(commands,&old,0);tick();assert(!awaiting_ack&&rejected_count==1);
    cJSON *huge=cJSON_Parse("{\"pan_deg\":429496819.6,\"tilt_deg\":90}");assert(!ai_local_command("move",huge,error,sizeof error));
    cJSON_Delete(huge);cJSON_Delete(move);cJSON_Delete(patrol);
    assert(completed_count==0);
    puts("PASS production bridge: immutable busy revision; two-point pause/coordinates/type13 ACK transaction; old BLE queue discarded; patrol blocked during sync; standalone MCU ACK2 reset reinstalls configuration; stale generation and huge angle rejected.");
    free(commands->bytes);free(commands);return 0;
}
