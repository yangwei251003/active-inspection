#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* 可在 PC 与 ESP-IDF 上编译的纯 C 核心。角度统一使用十分之一度。 */
typedef struct { uint16_t seq; int type; int a; int b; } ai_uart_frame_t;
uint16_t ai_crc16(const void *data, size_t length);
int ai_uart_encode(const ai_uart_frame_t *frame, char *output, size_t capacity);
bool ai_uart_decode(const char *line, size_t length, ai_uart_frame_t *frame);
bool ai_motion_valid(int pan10, int tilt10);

typedef enum { AI_LED_UNCERTAIN, AI_LED_OFF, AI_LED_RED, AI_LED_GREEN, AI_LED_BLUE, AI_LED_YELLOW } ai_led_state_t;
typedef struct { float x, y, w, h; } ai_roi_t;
typedef struct { float dark_max, bright_min, saturation_min, dominant_fraction; } ai_roi_config_t;
typedef struct { ai_led_state_t state; float confidence; unsigned samples; float mean_value; } ai_observation_t;
bool ai_roi_valid(ai_roi_t roi);
/* RGB888，无分配，规则阈值必须用到货实景标注样本校准。 */
bool ai_roi_classify(const uint8_t *rgb, size_t size, unsigned width, unsigned height,
                     unsigned stride, ai_roi_t roi, const ai_roi_config_t *config,
                     ai_observation_t *result);
const char *ai_led_name(ai_led_state_t state);
bool ai_roi_classify_rgb565(const uint8_t *pixels, size_t size, unsigned width, unsigned height,
                            unsigned stride, ai_roi_t roi, const ai_roi_config_t *config,
                            ai_observation_t *result);

#define AI_REPLAY_CAPACITY 32
#define AI_COMMAND_ID_MAX 64
typedef struct { char ids[AI_REPLAY_CAPACITY][AI_COMMAND_ID_MAX]; unsigned next; } ai_replay_t;
/* 先检查 TTL，再记住编号。时间未同步、未来指令、过长 TTL 都拒绝。 */
bool ai_command_admit(ai_replay_t *cache, const char *id, int64_t created_ms,
                      int64_t expires_ms, int64_t now_ms, bool clock_valid);
typedef struct { char bytes[512]; size_t used; bool discarding; } ai_line_buffer_t;
/* 返回 1=完整行，0=尚未完整，-1=超长。超长一直丢弃至换行，不能执行尾部。 */
int ai_line_feed(ai_line_buffer_t *buffer, uint8_t byte);

/* Capture requests retain their configuration and absolute expiry across tasks.
 * Production calls these with the application lock held. */
typedef struct {
    bool pending;char id[64],preset_id[40];int revision;int64_t expires_ms;
} ai_capture_request_t;
bool ai_capture_begin(ai_capture_request_t *request,const char *id,const char *preset_id,int revision,int64_t expires_ms,int64_t now_ms);
bool ai_capture_valid(const ai_capture_request_t *request,const char *preset_id,int revision,int64_t now_ms);
bool ai_capture_complete(ai_capture_request_t *request,const char *id,const char *preset_id,int revision,int64_t now_ms);
void ai_capture_cancel(ai_capture_request_t *request);
