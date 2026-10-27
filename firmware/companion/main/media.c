#include "app.h"
#include "esp_video_init.h"
#include "esp_capture_video_v4l2_src.h"
#include "esp_capture_sink.h"
#include "esp_video_enc_default.h"
#include "esp_webrtc.h"
#include "esp_webrtc_defaults.h"
#include "esp_peer_default.h"
#include "esp_peer_whip_signaling.h"
#include "media_lib_adapter.h"
#include "driver/jpeg_encode.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_random.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "esp_heap_caps.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

#define DETECT_W 320
#define DETECT_H 180
static esp_capture_handle_t capture;
static esp_capture_sink_handle_t roi_sink;
static esp_webrtc_handle_t rtc;
static jpeg_encoder_handle_t jpeg;
static uint8_t *jpeg_output;static size_t jpeg_capacity;
static ai_capture_request_t capture_request;
static uint32_t sampled_epoch;
static int sampled_revision;
static ai_led_state_t candidate[3],last_state[3];static unsigned votes[3];
static int64_t last_event_ms;
static bool rtc_failed;
typedef struct {
    char event_id[64], preset_id[40], kind[24];
    ai_observation_t observation;
    int revision;
    int64_t observed_ms;
    size_t size;
    uint8_t jpeg[];
} evidence_job_t;
static QueueHandle_t evidence_jobs;
static const ai_roi_config_t thresholds={.dark_max=.18f,.bright_min=.40f,.saturation_min=.40f,.dominant_fraction=.65f};

bool ai_request_recheck_command(const char *id,int64_t expires){
    ai_lock();int i=ai_state.active;bool ok=capture&&i>=0&&ai_state.phase==3;
    if(ok)ok=ai_capture_begin(&capture_request,id?id:"",ai_state.presets[i].id,ai_state.preset_revision,expires,ai_now_ms());
    if(ok){
        /* Serialize the ACK before making a request visible to the media task. */
        if(id&&*id)ai_network_ack(id,"acknowledged",NULL);}
    ai_unlock();return ok;
}
static void cancel_request(const char *expected_id,const char *reason){
    ai_lock();char id[64]="";
    if(capture_request.pending&&(!expected_id||!strcmp(expected_id,capture_request.id))){strcpy(id,capture_request.id);ai_capture_cancel(&capture_request);}ai_unlock();
    if(id[0])ai_network_ack(id,"rejected",reason);
}
void ai_media_cancel(const char *reason){cancel_request(NULL,reason);}
void ai_request_recheck(void){ai_request_recheck_command(NULL,ai_now_ms()+15000);}
void ai_media_frame_rgb(const uint8_t *rgb,size_t bytes,unsigned w,unsigned h,unsigned stride){
    ai_lock();int i=ai_state.active;uint32_t epoch=ai_state.observation_epoch;
    bool stable=i>=0&&ai_state.phase==3&&ai_state.pan10==ai_state.presets[i].pan10&&ai_state.tilt10==ai_state.presets[i].tilt10;
    ai_roi_t roi=stable?ai_state.presets[i].roi:(ai_roi_t){0};ai_unlock();
    ai_observation_t o;if(stable&&ai_roi_classify(rgb,bytes,w,h,stride,roi,&thresholds,&o)){ai_lock();if(ai_state.observation_epoch==epoch&&ai_state.active==i)ai_state.presets[i].observation=o;ai_unlock();}
}
static int rtc_event(esp_webrtc_event_t *e,void *ctx){
    (void)ctx;ai_lock();
    if(e->type==ESP_WEBRTC_EVENT_CONNECTED)ai_state.video=true;
    else if(e->type==ESP_WEBRTC_EVENT_CONNECT_FAILED||e->type==ESP_WEBRTC_EVENT_DISCONNECTED){ai_state.video=false;rtc_failed=true;}
    ai_unlock();return 0;
}
static esp_err_t camera_init(void){
    /* P4-NANO原理图及Waveshare相机例程：CSI SCCB SDA7/SCL8；非Function-EV板标签替换。 */
    esp_video_init_csi_config_t csi={.sccb_config={.init_sccb=true,.i2c_config={.port=0,.scl_pin=8,.sda_pin=7},.freq=100000},.reset_pin=-1,.pwdn_pin=-1};
    esp_video_init_config_t cfg={.csi=&csi};esp_err_t e=esp_video_init(&cfg);if(e!=ESP_OK)return e;
    esp_capture_video_v4l2_src_cfg_t video_cfg={.dev_name="/dev/video0",.buf_count=4};
    esp_capture_video_src_if_t *src=esp_capture_new_video_v4l2_src(&video_cfg);if(!src)return ESP_ERR_NO_MEM;
    esp_capture_cfg_t cap_cfg={.sync_mode=ESP_CAPTURE_SYNC_MODE_NONE,.video_src=src};
    if(esp_capture_open(&cap_cfg,&capture))return ESP_FAIL;
    esp_capture_sink_cfg_t video={.video_info={.format_id=ESP_CAPTURE_FMT_ID_H264,.width=1280,.height=720,.fps=15}};
    esp_capture_sink_handle_t main_sink;if(esp_capture_sink_setup(capture,0,&video,&main_sink))return ESP_FAIL;
    esp_capture_sink_cfg_t small={.video_info={.format_id=ESP_CAPTURE_FMT_ID_RGB565,.width=DETECT_W,.height=DETECT_H,.fps=2}};
    if(esp_capture_sink_setup(capture,1,&small,&roi_sink))return ESP_FAIL;
    if(esp_capture_sink_enable(roi_sink,ESP_CAPTURE_RUN_MODE_ALWAYS))return ESP_FAIL;
    jpeg_encode_engine_cfg_t j={.timeout_ms=500};if(jpeg_new_encoder_engine(&j,&jpeg)!=ESP_OK)return ESP_FAIL;
    jpeg_encode_memory_alloc_cfg_t mem={.buffer_direction=JPEG_ENC_ALLOC_OUTPUT_BUFFER};
    jpeg_output=jpeg_alloc_encoder_mem(128*1024,&mem,&jpeg_capacity);if(!jpeg_output)return ESP_ERR_NO_MEM;
    return esp_capture_start(capture)==0?ESP_OK:ESP_FAIL;
}
static int start_rtc(void){
    if(strncmp(ai_whip_url,"https://",8)||!strlen(ai_device_token))return -1;
    esp_peer_default_cfg_t extra={0};esp_peer_signaling_whip_cfg_t signal={.auth_type=ESP_PEER_SIGNALING_WHIP_AUTH_TYPE_BEARER,.token=ai_device_token};
    esp_webrtc_cfg_t c={.peer_cfg={.video_info={.codec=ESP_PEER_VIDEO_CODEC_H264,.width=1280,.height=720,.fps=15},.audio_dir=ESP_PEER_MEDIA_DIR_NONE,.video_dir=ESP_PEER_MEDIA_DIR_SEND_ONLY,.extra_cfg=&extra,.extra_size=sizeof extra},.signaling_cfg={.signal_url=ai_whip_url,.extra_cfg=&signal,.extra_size=sizeof signal},.peer_impl=esp_peer_get_default_impl(),.signaling_impl=esp_signaling_get_whip_impl()};
    int err=esp_webrtc_open(&c,&rtc);if(err)return err;
    esp_webrtc_media_provider_t p={.capture=capture};esp_webrtc_set_media_provider(rtc,&p);esp_webrtc_set_no_auto_capture(rtc,true);esp_webrtc_set_event_handler(rtc,rtc_event,NULL);esp_webrtc_enable_peer_connection(rtc,true);return esp_webrtc_start(rtc);
}
static bool upload_jpeg(const char *event_id,const uint8_t *data,size_t size,char *url,size_t cap){
    const char *ws_url=ai_ws_url;
    if(strncmp(ws_url,"wss://",6))return false;
    const char *host=ws_url+6,*path=strchr(host,'/');size_t host_len=path?(size_t)(path-host):strlen(host);
    char endpoint[320],auth[224];if(host_len>180||strlen(ai_device_token)>200)return false;
    snprintf(endpoint,sizeof endpoint,"https://%.*s/api/device/evidence?event_id=%s",(int)host_len,host,event_id);
    snprintf(auth,sizeof auth,"Bearer %s",ai_device_token);
    esp_http_client_config_t cfg={.url=endpoint,.method=HTTP_METHOD_POST,.crt_bundle_attach=esp_crt_bundle_attach,.timeout_ms=5000,.disable_auto_redirect=true};
    esp_http_client_handle_t h=esp_http_client_init(&cfg);if(!h)return false;
    esp_http_client_set_header(h,"Authorization",auth);esp_http_client_set_header(h,"X-Device-Id",CONFIG_AI_DEVICE_ID);esp_http_client_set_header(h,"Content-Type","image/jpeg");
    bool ok=false;if(esp_http_client_open(h,size)==ESP_OK){int sent=0;while(sent<(int)size){int n=esp_http_client_write(h,(const char *)data+sent,size-sent);if(n<=0)break;sent+=n;}
        if(sent==(int)size){esp_http_client_fetch_headers(h);int code=esp_http_client_get_status_code(h);char body[768];int n=esp_http_client_read_response(h,body,sizeof body-1);
            if((code==200||code==201)&&n>0){body[n]=0;cJSON *json=cJSON_Parse(body),*e=cJSON_GetObjectItemCaseSensitive(json,"evidence"),*u=cJSON_GetObjectItemCaseSensitive(e,"evidence_url");
                if(cJSON_IsString(u)&&!strncmp(u->valuestring,"/api/evidence/",14)&&strlen(u->valuestring)<cap){strcpy(url,u->valuestring);ok=true;}cJSON_Delete(json);}}
    }esp_http_client_close(h);esp_http_client_cleanup(h);return ok;
}
static void evidence_task(void *arg){
    (void)arg;evidence_job_t *job;
    for(;;)if(xQueueReceive(evidence_jobs,&job,portMAX_DELAY)==pdTRUE){
        char url[160]="";
        if(job->size)upload_jpeg(job->event_id,job->jpeg,job->size,url,sizeof url);
        ai_network_event_evidence(job->event_id,job->kind,job->preset_id,job->revision,job->observed_ms,&job->observation,url[0]?url:NULL);
        heap_caps_free(job);
    }
}
static void inspect_frame(esp_capture_stream_frame_t *frame){
    ai_lock();int i=ai_state.active;int phase=ai_state.phase;int revision=ai_state.preset_revision;uint32_t epoch=ai_state.observation_epoch;bool requested=capture_request.pending;int pan=ai_state.pan10,tilt=ai_state.tilt10;
    ai_capture_request_t request_snapshot=capture_request;char request_id[64]="";if(requested)snprintf(request_id,sizeof request_id,"%s",capture_request.id);
    ai_preset_t preset=i>=0?ai_state.presets[i]:(ai_preset_t){0};ai_unlock();
    int64_t now=esp_timer_get_time()/1000;
    int64_t observed_ms=ai_now_ms();
    if(sampled_epoch!=epoch){memset(votes,0,sizeof votes);memset(candidate,0,sizeof candidate);sampled_epoch=epoch;}
    if(sampled_revision!=revision){memset(last_state,0,sizeof last_state);sampled_revision=revision;}
    if(requested&&(i<0||phase!=3||!ai_capture_valid(&request_snapshot,preset.id,revision,ai_now_ms()))){cancel_request(request_id,"expired_or_observation_target_changed");requested=false;}
    if(i<0||phase!=3||pan!=preset.pan10||tilt!=preset.tilt10||frame->size<DETECT_W*DETECT_H*2)return;
    ai_observation_t o;if(!ai_roi_classify_rgb565(frame->data,frame->size,DETECT_W,DETECT_H,DETECT_W*2,preset.roi,&thresholds,&o))return;
    if(candidate[i]!=o.state){candidate[i]=o.state;votes[i]=1;}else if(votes[i]<3)++votes[i];
    if(votes[i]<3)o.state=AI_LED_UNCERTAIN;
    ai_lock();bool current=ai_state.observation_epoch==epoch&&ai_state.active==i&&ai_state.preset_revision==revision;
    if(current)ai_state.presets[i].observation=o;
    ai_unlock();if(!current)return;
    if((o.state!=last_state[i]||requested)&&now-last_event_ms>=2000){
        last_state[i]=o.state;last_event_ms=now;char event_id[64];snprintf(event_id,sizeof event_id,"img-%08lx-%08lx",(unsigned long)esp_random(),(unsigned long)now);
        jpeg_encode_cfg_t enc={.width=DETECT_W,.height=DETECT_H,.src_type=JPEG_ENCODE_IN_FORMAT_RGB565,.sub_sample=JPEG_DOWN_SAMPLING_YUV420,.image_quality=70};uint32_t jpeg_size=0;
        bool encoded=jpeg_encoder_process(jpeg,&enc,frame->data,frame->size,jpeg_output,jpeg_capacity,&jpeg_size)==ESP_OK;
        ai_lock();current=ai_state.observation_epoch==epoch&&ai_state.active==i&&ai_state.phase==3&&ai_state.preset_revision==revision;ai_unlock();
        if(!current)return;
        const char *kind=requested?"recheck":o.state==AI_LED_UNCERTAIN?"uncertain":"state_changed";
        /* Copy the bounded JPEG before releasing the capture frame. Network I/O
         * runs elsewhere, so a slow upload cannot hold a camera buffer for 5 s. */
        evidence_job_t *job=encoded?heap_caps_malloc(sizeof(*job)+jpeg_size,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT):NULL;
        bool queued=false;
        if(job){snprintf(job->event_id,sizeof job->event_id,"%s",event_id);snprintf(job->preset_id,sizeof job->preset_id,"%s",preset.id);snprintf(job->kind,sizeof job->kind,"%s",kind);job->observation=o;job->revision=revision;job->observed_ms=observed_ms;job->size=jpeg_size;memcpy(job->jpeg,jpeg_output,jpeg_size);queued=xQueueSend(evidence_jobs,&job,0)==pdTRUE;if(!queued)heap_caps_free(job);}
        if(!queued)ai_network_event_evidence(event_id,kind,preset.id,revision,observed_ms,&o,NULL);
        if(requested){ai_lock();bool same=ai_capture_complete(&capture_request,request_id,preset.id,revision,ai_now_ms());ai_unlock();
            if(same&&request_id[0])ai_network_ack(request_id,"completed",queued?"observation_complete_evidence_upload_pending":"observation_complete_evidence_unavailable");}
    }
}
static void media_task(void *arg){
    (void)arg;media_lib_add_default_adapter();esp_video_enc_register_default();
    esp_err_t e=camera_init();if(e!=ESP_OK){ESP_LOGE("media","OV5647 pipeline init failed: %s",esp_err_to_name(e));vTaskDelete(NULL);return;}
    int64_t retry=0;
    for(;;){ai_lock();bool online=ai_state.online;bool failed=rtc_failed;ai_unlock();int64_t now=esp_timer_get_time()/1000;
        ai_lock();if(capture_request.pending&&ai_now_ms()>=capture_request.expires_ms)ai_media_cancel("observation_deadline_exceeded");ai_unlock();
        if(rtc&&(!online||failed)){esp_webrtc_close(rtc);rtc=NULL;retry=now+5000;ai_lock();rtc_failed=false;ai_state.video=false;ai_unlock();}
        if(online&&!rtc&&now>=retry){int err=start_rtc();if(err){ESP_LOGE("media","WHIP start failed: %d",err);if(rtc)esp_webrtc_close(rtc);rtc=NULL;retry=now+15000;}}
        esp_capture_stream_frame_t frame={.stream_type=ESP_CAPTURE_STREAM_TYPE_VIDEO};
        if(esp_capture_sink_acquire_frame(roi_sink,&frame,true)==ESP_CAPTURE_ERR_OK){inspect_frame(&frame);esp_capture_sink_release_frame(roi_sink,&frame);}
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
void ai_media_start(void){
    evidence_jobs=xQueueCreate(2,sizeof(evidence_job_t *));configASSERT(evidence_jobs);
    xTaskCreate(evidence_task,"jpeg_evidence",8192,NULL,4,NULL);
    xTaskCreate(media_task,"capture_media",12288,NULL,5,NULL);
}
