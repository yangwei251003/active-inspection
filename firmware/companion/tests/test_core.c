#include "inspection_core.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    assert(ai_crc16("123456789", 9) == 0x29b1);
    char line[80]; ai_uart_frame_t a = {65535, 1, 900, 900}, b;
    int n = ai_uart_encode(&a, line, sizeof line); assert(n > 0);
    assert(ai_uart_decode(line, n, &b) && b.seq == 65535 && b.a == 900);
    line[4] ^= 1; assert(!ai_uart_decode(line, n, &b)); line[4] ^= 1;
    assert(!ai_uart_decode(line, n - 1, &b)); assert(ai_uart_encode(&a, line, 5) < 0);
    assert(ai_motion_valid(300, 450) && ai_motion_valid(1500, 1200));
    assert(!ai_motion_valid(299, 900) && !ai_motion_valid(900, 1201));
    const uint8_t colors[][3] = {{0,0,0},{255,0,0},{0,255,0},{0,0,255},{255,255,0},{255,255,255}};
    const ai_led_state_t expected[] = {AI_LED_OFF,AI_LED_RED,AI_LED_GREEN,AI_LED_BLUE,AI_LED_YELLOW,AI_LED_UNCERTAIN};
    uint8_t pixels[300]; ai_roi_config_t cfg = {.dark_max=.18f,.bright_min=.4f,.saturation_min=.4f,.dominant_fraction=.65f};
    ai_observation_t out; ai_roi_t roi = {0,0,1,1};
    for (unsigned c = 0; c < 6; ++c) { for (int i = 0; i < 100; ++i) memcpy(pixels + i * 3, colors[c], 3);
        assert(ai_roi_classify(pixels, sizeof pixels, 10, 10, 30, roi, &cfg, &out)); assert(out.state == expected[c]); }
    assert(!ai_roi_classify(pixels, 20, 10, 10, 30, roi, &cfg, &out));
    assert(!ai_roi_valid((ai_roi_t){NAN,0,1,1}) && !ai_roi_valid((ai_roi_t){.9f,0,.2f,1}));
    for (int i = 0; i < 100; ++i) memcpy(pixels + i*3, colors[1 + i%2], 3);
    assert(ai_roi_classify(pixels, sizeof pixels, 10, 10, 30, roi, &cfg, &out) && out.state == AI_LED_UNCERTAIN);
    ai_replay_t replay = {0}; int64_t now = 1800000000000LL;
    assert(!ai_command_admit(&replay, "a", now, now+5000, now, false));
    assert(ai_command_admit(&replay, "a", now, now+5000, now, true));
    assert(!ai_command_admit(&replay, "a", now, now+5000, now, true));
    assert(!ai_command_admit(&replay, "expired", now-5000, now, now, true));
    assert(!ai_command_admit(&replay, "future", now+9000, now+10000, now, true));
    assert(!ai_command_admit(&replay, "long", now, now+90000, now, true));
    uint8_t red565[200];for (unsigned i=0;i<100;++i){red565[2*i]=0;red565[2*i+1]=0xf8;}
    assert(ai_roi_classify_rgb565(red565,sizeof red565,10,10,20,roi,&cfg,&out)&&out.state==AI_LED_RED);
    const char *frames[]={"@1,4,0,0*6320\n","@2,1,900,900*61DB\n","@3,10,500,900*CEE0\n","@2,101,1,5*8783\n","@3,102,900,900*372B\n","@3,103,3,0*16E6\n","@65535,1,300,1200*6743\n","@0,4,0,0*DB41\n"};
    for(unsigned i=0;i<sizeof frames/sizeof frames[0];++i){assert(ai_uart_decode(frames[i],strlen(frames[i]),&b));assert(ai_uart_encode(&b,line,sizeof line)>0&&!strcmp(line,frames[i]));}
    const char *count_frames[]={"@4,13,2,0*6A63\n","@4,101,13,0*F13A\n","@5,103,0,255*D9ED\n"};
    for(unsigned i=0;i<sizeof count_frames/sizeof count_frames[0];++i){assert(ai_uart_decode(count_frames[i],strlen(count_frames[i]),&b));assert(ai_uart_encode(&b,line,sizeof line)>0&&!strcmp(line,count_frames[i]));}
    const char *bad_body="1,4,\t0,0";snprintf(line,sizeof line,"@%s*%04X\n",bad_body,ai_crc16(bad_body,strlen(bad_body)));
    assert(!ai_uart_decode(line,strlen(line),&b));
    ai_line_buffer_t buf = {0}; for (int i=0; i<511; ++i) assert(ai_line_feed(&buf, 'x')==0);
    assert(ai_line_feed(&buf,'\n')==1&&strlen(buf.bytes)==511);buf.used=0;
    for (int i=0;i<512;++i)ai_line_feed(&buf,'x');
    assert(buf.discarding); assert(ai_line_feed(&buf, '\n') == 0); assert(ai_line_feed(&buf,'x') == 0);
    assert(ai_line_feed(&buf,'\n') == 1 && !strcmp(buf.bytes,"x"));
    puts("PASS: CRC known vector; 11 STM32 golden frames; UART bounds/corruption/whitespace; motion range; RGB888/RGB565 ROI/uncertainty; replay/TTL; BLE 512-byte line boundary and overflow recovery."); return 0;
}
