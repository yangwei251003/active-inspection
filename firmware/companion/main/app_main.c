#include "app.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "esp_timer.h"
#include <sys/time.h>
#include <string.h>
ai_state_t ai_state = {.active=-1,.phase=0,.pan10=900,.tilt10=900,.mode="paused"};
char ai_ws_url[]=CONFIG_AI_WS_URL;
char ai_whip_url[]=CONFIG_AI_WHIP_URL;
char ai_device_token[]=CONFIG_AI_DEVICE_TOKEN;
static SemaphoreHandle_t state_mutex;
void ai_lock(void) { xSemaphoreTakeRecursive(state_mutex, portMAX_DELAY); }
void ai_unlock(void) { xSemaphoreGiveRecursive(state_mutex); }
int64_t ai_now_ms(void) { struct timeval tv; gettimeofday(&tv, NULL); return (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000; }
bool ai_clock_valid(void) { return ai_now_ms() > 1700000000000LL; }
void app_main(void) {
    ESP_LOGW("inspection", "PRE-PROCUREMENT BUILD: hardware, camera and network acceptance pending; no servo enable implied.");
    state_mutex = xSemaphoreCreateRecursiveMutex(); configASSERT(state_mutex);
    esp_err_t err = nvs_flash_init();
    /* 不自动擦除 NVS，避免发生版本错误时静默丢失凭据与未上传事件。 */
    if (err != ESP_OK) { ESP_LOGE("inspection", "NVS init rejected: %s", esp_err_to_name(err)); return; }
    ai_bridge_start(); ai_network_start();
#if CONFIG_AI_BLE_ENABLE
    ai_ble_start();
#endif
#if CONFIG_AI_MEDIA_ENABLE
    ai_media_start();
#endif
}
