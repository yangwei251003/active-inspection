#include "inspection_core.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>

uint16_t ai_crc16(const void *data, size_t length) {
    const uint8_t *p = data; uint16_t crc = 0xffff;
    while (length--) { crc ^= (uint16_t)*p++ << 8;
        for (int bit = 0; bit < 8; ++bit) crc = (uint16_t)((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0));
    } return crc;
}
bool ai_motion_valid(int pan10, int tilt10) { return pan10 >= 300 && pan10 <= 1500 && tilt10 >= 450 && tilt10 <= 1200; }
int ai_uart_encode(const ai_uart_frame_t *f, char *out, size_t cap) {
    if (!f || !out || cap < 8) return -1;
    char payload[64]; int n = snprintf(payload, sizeof payload, "%u,%d,%d,%d", f->seq, f->type, f->a, f->b);
    if (n < 0 || (size_t)n >= sizeof payload) return -1;
    int total = snprintf(out, cap, "@%s*%04X\n", payload, ai_crc16(payload, (size_t)n));
    return total >= 0 && (size_t)total < cap ? total : -1;
}
bool ai_uart_decode(const char *line, size_t len, ai_uart_frame_t *f) {
    if (!line || !f || len < 12 || len > 79 || line[0] != '@' || line[len - 1] != '\n') return false;
    const char *star = memchr(line, '*', len);
    if (!star || line + len - star != 6) return false;
    unsigned checksum = 0;
    for (int i = 1; i <= 4; ++i) { char c = star[i]; unsigned d;
        if (c >= '0' && c <= '9') d = (unsigned)(c - '0');
        else if (c >= 'A' && c <= 'F') d = (unsigned)(c - 'A' + 10);
        else if (c >= 'a' && c <= 'f') d = (unsigned)(c - 'a' + 10);
        else return false;
        checksum = (checksum << 4) | d;
    }
    if (ai_crc16(line + 1, (size_t)(star - line - 1)) != checksum) return false;
    char body[64]; size_t n = (size_t)(star - line - 1);
    if (n >= sizeof body) return false;
    memcpy(body, line + 1, n); body[n] = 0;
    long fields[4]; char *p = body;
    for (int i = 0; i < 4; ++i) {
        const char *digits = *p == '-' ? p + 1 : p;
        if (*digits < '0' || *digits > '9') return false;
        for (const char *scan = digits; *scan && *scan != ','; ++scan)
            if (*scan < '0' || *scan > '9') return false;
        char *end; errno = 0; fields[i] = strtol(p, &end, 10);
        if (errno || end == p || fields[i] < INT_MIN || fields[i] > INT_MAX) return false;
        if (i < 3) { if (*end != ',') return false; p = end + 1; }
        else if (*end) return false;
    }
    if (fields[0] < 0 || fields[0] > 65535 || fields[1] < 0 || fields[1] > 255) return false;
    *f = (ai_uart_frame_t){ (uint16_t)fields[0], (int)fields[1], (int)fields[2], (int)fields[3] }; return true;
}
bool ai_roi_valid(ai_roi_t r) {
    return isfinite(r.x) && isfinite(r.y) && isfinite(r.w) && isfinite(r.h) &&
           r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= 1.000001f && r.y + r.h <= 1.000001f;
}
static bool classify(const uint8_t *rgb, size_t size, unsigned w, unsigned h,
                     unsigned stride, ai_roi_t roi, const ai_roi_config_t *cfg, ai_observation_t *out, bool rgb565) {
    unsigned channels = rgb565 ? 2 : 3;
    if (!rgb || !cfg || !out || !w || !h || w > 8192 || h > 8192 || stride < w * channels ||
        (size_t)stride > size / h || !ai_roi_valid(roi) || !isfinite(cfg->dark_max) ||
        !isfinite(cfg->bright_min) || !isfinite(cfg->saturation_min) || !isfinite(cfg->dominant_fraction) ||
        cfg->dark_max < 0 || cfg->dark_max >= cfg->bright_min || cfg->bright_min > 1 ||
        cfg->saturation_min < 0 || cfg->saturation_min > 1 || cfg->dominant_fraction <= 0.5f || cfg->dominant_fraction > 1) return false;
    unsigned x0 = (unsigned)(roi.x * w), y0 = (unsigned)(roi.y * h);
    unsigned x1 = (unsigned)ceilf((roi.x + roi.w) * w), y1 = (unsigned)ceilf((roi.y + roi.h) * h);
    if (x1 > w) x1 = w;
    if (y1 > h) y1 = h;
    unsigned counts[6] = {0}, total = 0; float values = 0;
    /* 每轴至多约 160 点，避免 ROI 尺寸把识别耗时无界放大。 */
    unsigned step_x = (x1 - x0) / 160 + 1, step_y = (y1 - y0) / 120 + 1;
    for (unsigned y = y0; y < y1; y += step_y) for (unsigned x = x0; x < x1; x += step_x) {
        const uint8_t *p = rgb + (size_t)y * stride + x * channels;
        uint16_t packed = (uint16_t)p[0] | (uint16_t)p[1] << 8;
        float r = rgb565 ? (packed >> 11) / 31.f : p[0] / 255.f;
        float g = rgb565 ? ((packed >> 5) & 63) / 63.f : p[1] / 255.f;
        float b = rgb565 ? (packed & 31) / 31.f : p[2] / 255.f;
        float hi = fmaxf(r, fmaxf(g, b)), lo = fminf(r, fminf(g, b));
        float delta = hi - lo, sat = hi > 0 ? delta / hi : 0;
        values += hi; ++total;
        if (hi <= cfg->dark_max) { ++counts[AI_LED_OFF]; continue; }
        if (hi < cfg->bright_min || sat < cfg->saturation_min) { ++counts[AI_LED_UNCERTAIN]; continue; }
        float hue = hi == r ? 60.f * fmodf((g - b) / delta, 6.f) : hi == g ? 60.f * ((b - r) / delta + 2.f) : 60.f * ((r - g) / delta + 4.f);
        if (hue < 0) hue += 360;
        ai_led_state_t c = hue < 25 || hue > 335 ? AI_LED_RED : hue >= 40 && hue <= 75 ? AI_LED_YELLOW : hue >= 85 && hue <= 165 ? AI_LED_GREEN : hue >= 195 && hue <= 265 ? AI_LED_BLUE : AI_LED_UNCERTAIN;
        ++counts[c];
    }
    if (!total) return false;
    ai_led_state_t best = AI_LED_OFF;
    for (int i = AI_LED_RED; i <= AI_LED_YELLOW; ++i) if (counts[i] > counts[best]) best = (ai_led_state_t)i;
    float fraction = (float)counts[best] / total;
    *out = (ai_observation_t){ fraction >= cfg->dominant_fraction ? best : AI_LED_UNCERTAIN, fraction, total, values / total };
    return true;
}
bool ai_roi_classify(const uint8_t *p,size_t s,unsigned w,unsigned h,unsigned stride,ai_roi_t r,const ai_roi_config_t *c,ai_observation_t *o){return classify(p,s,w,h,stride,r,c,o,false);}
bool ai_roi_classify_rgb565(const uint8_t *p,size_t s,unsigned w,unsigned h,unsigned stride,ai_roi_t r,const ai_roi_config_t *c,ai_observation_t *o){return classify(p,s,w,h,stride,r,c,o,true);}
const char *ai_led_name(ai_led_state_t s) { static const char *names[] = {"uncertain", "off", "red", "green", "blue", "yellow"}; return s >= 0 && s <= AI_LED_YELLOW ? names[s] : "uncertain"; }
bool ai_command_admit(ai_replay_t *cache, const char *id, int64_t created, int64_t expires, int64_t now, bool valid) {
    if (!cache || !id || !*id || strlen(id) >= AI_COMMAND_ID_MAX || !valid || now < 1700000000000LL ||
        created > now + 5000 || created < now - 30000 || expires <= now || expires <= created || expires - created > 30000) return false;
    for (unsigned i = 0; i < AI_REPLAY_CAPACITY; ++i) if (!strcmp(cache->ids[i], id)) return false;
    strcpy(cache->ids[cache->next], id); cache->next = (cache->next + 1) % AI_REPLAY_CAPACITY; return true;
}
int ai_line_feed(ai_line_buffer_t *b, uint8_t c) {
    if (!b) return -1;
    if (b->discarding) { if (c == '\n') { b->discarding = false; b->used = 0; } return 0; }
    if (c == '\n') { b->bytes[b->used] = 0; return 1; }
    if (c == 0 || b->used >= sizeof b->bytes - 1) { b->discarding = true; b->used = 0; return -1; }
    b->bytes[b->used++] = (char)c; return 0;
}
bool ai_capture_begin(ai_capture_request_t *r,const char *id,const char *preset,int revision,int64_t expires,int64_t now){
    if(!r||r->pending||!id||!preset||!*preset||strlen(id)>=sizeof r->id||strlen(preset)>=sizeof r->preset_id||revision<1||expires<=now)return false;
    *r=(ai_capture_request_t){.pending=true,.revision=revision,.expires_ms=expires};strcpy(r->id,id);strcpy(r->preset_id,preset);return true;
}
bool ai_capture_valid(const ai_capture_request_t *r,const char *preset,int revision,int64_t now){
    return r&&r->pending&&preset&&now<r->expires_ms&&r->revision==revision&&!strcmp(r->preset_id,preset);
}
bool ai_capture_complete(ai_capture_request_t *r,const char *id,const char *preset,int revision,int64_t now){
    if(!id||!ai_capture_valid(r,preset,revision,now)||strcmp(r->id,id))return false;
    ai_capture_cancel(r);return true;
}
void ai_capture_cancel(ai_capture_request_t *r){if(r)memset(r,0,sizeof *r);}
