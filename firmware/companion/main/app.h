#pragma once
#include "esp_err.h"
#include "cJSON.h"
#include "inspection_core.h"
#include <stdbool.h>
#include <stdint.h>
#include "sdkconfig.h"
#ifndef CONFIG_AI_UART_ENABLE
#define CONFIG_AI_UART_ENABLE 0
#endif
typedef struct { char id[40]; int pan10, tilt10; ai_roi_t roi; ai_observation_t observation; } ai_preset_t;
typedef struct {
    ai_preset_t presets[3]; unsigned preset_count; int active, phase, pan10, tilt10;
    char mode[12]; bool online, wifi, video, uart_enabled; int64_t stationary_since;
    uint32_t observation_epoch;
    int preset_revision;bool presets_installed;
} ai_state_t;
extern ai_state_t ai_state;
/* Shared storage keeps optional network paths linked even in the blank-config
 * delivery image. Blank values still disable every outbound cloud request. */
extern char ai_ws_url[], ai_whip_url[], ai_device_token[];
void ai_lock(void); void ai_unlock(void);
int64_t ai_now_ms(void); bool ai_clock_valid(void);
void ai_network_start(void);
bool ai_network_send(cJSON *message); /* Takes ownership. */
void ai_network_event(const char *kind, const char *preset_id, const ai_observation_t *observation);
void ai_network_event_evidence(const char *event_id, const char *kind, const char *preset_id, int preset_revision, int64_t observed_ms, const ai_observation_t *observation, const char *evidence_url);
void ai_network_ack(const char *id, const char *status, const char *reason);
bool ai_wifi_configure(const char *ssid, const char *password);
void ai_bridge_start(void);
bool ai_bridge_command(const cJSON *command, char *error, size_t error_size);
void ai_bridge_presets(const cJSON *message);
void ai_bridge_disconnect(void);
bool ai_local_command(const char *op, const cJSON *args, char *error, size_t error_size);
void ai_ble_start(void);
void ai_media_start(void);
void ai_media_frame_rgb(const uint8_t *rgb, size_t bytes, unsigned w, unsigned h, unsigned stride);
void ai_request_recheck(void);
bool ai_request_recheck_command(const char *command_id,int64_t expires_ms);
void ai_media_cancel(const char *reason);
