#ifndef INSPECTION_H
#define INSPECTION_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* 全部角度用 0.1° 整数，避免 MCU 浮点依赖；这些是软件窗口，不是实测机械限位。 */
#define INS_PAN_MIN 300
#define INS_PAN_MAX 1500
#define INS_TILT_MIN 450
#define INS_TILT_MAX 1200
#define INS_PRESET_COUNT 3
#define INS_FRAME_MAX 64
#define INS_HEARTBEAT_MS 1500U
#define INS_STEP_MS 20U
#define INS_STEP_ANGLE 6 /* 每 20 ms 走 0.6°，逻辑速度 30°/s */
#define INS_SETTLE_MS 500U
#define INS_DWELL_MS 2000U

typedef enum { INS_MANUAL=0, INS_PATROL=1, INS_PAUSED=2 } ins_mode;
typedef enum { INS_IDLE=0, INS_MOVING=1, INS_SETTLING=2, INS_DWELLING=3 } ins_phase;
typedef enum {
    INS_OK=0, INS_ERR_RANGE=1, INS_ERR_REPLAY=2, INS_ERR_TYPE=3,
    INS_ERR_NO_HEARTBEAT=4, INS_ERR_DISABLED=5, INS_ERR_BUSY=6
} ins_result;
typedef struct { uint16_t seq, type; int32_t a, b; } ins_frame;
typedef struct {
    char body[INS_FRAME_MAX]; size_t length; bool receiving, overflow;
    uint32_t bad_crc, bad_format, too_long;
} ins_parser;
typedef struct { int16_t pan, tilt; } ins_pose;
typedef struct {
    ins_pose commanded, target, presets[INS_PRESET_COUNT];
    ins_mode mode; ins_phase phase;
    bool output_enabled, heartbeat_seen, seq_seen, observation_ready, lease_expired;
    uint16_t last_seq, accepted_seq;
    uint8_t active_preset, active_count;
    uint32_t heartbeat_at, step_at, phase_at, observations, link_losses;
} ins_controller;

uint16_t ins_crc16(const char *data, size_t length);
void ins_parser_init(ins_parser *p);
/* 每次输入一个字节；仅完整、严格合法且 CRC 正确的帧返回 true。 */
bool ins_parser_feed(ins_parser *p, char byte, ins_frame *frame);
size_t ins_encode(const ins_frame *frame, char *out, size_t capacity);
void ins_init(ins_controller *c, uint32_t now);
/* 显式暂停/失联/板级异常共用；作废旧观察点与稳定证据，不改变指令位置。 */
void ins_pause(ins_controller *c);
/* 仅板级在核验完成且明确允许输出时调用，UART 命令不能自行解锁。 */
void ins_set_output_enabled(ins_controller *c, bool enabled, uint32_t now);
ins_result ins_command(ins_controller *c, const ins_frame *frame, uint32_t now);
void ins_tick(ins_controller *c, uint32_t now);
bool ins_take_observation(ins_controller *c);
bool ins_link_alive(const ins_controller *c, uint32_t now);
bool ins_output_permitted(const ins_controller *c, uint32_t now);
#endif
