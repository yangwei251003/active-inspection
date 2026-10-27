#include "inspection.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static unsigned tests;
#define RUN(fn) do{fn();tests++;printf("PASS %s\n",#fn);}while(0)
static bool feed(ins_parser *p,const char *s,ins_frame *f){bool got=false;while(*s)if(ins_parser_feed(p,*s++,f))got=true;return got;}
static void raw(char *out,const char *body){sprintf(out,"@%s*%04X\n",body,ins_crc16(body,strlen(body)));}
static ins_result send(ins_controller *c,uint16_t seq,uint16_t type,int32_t a,int32_t b,uint32_t now){ins_frame f={seq,type,a,b};return ins_command(c,&f,now);}
static void arm(ins_controller *c,uint32_t now){ins_init(c,now);ins_set_output_enabled(c,true,now);assert(send(c,1,4,0,0,now)==INS_OK);}
static void test_crc_and_roundtrip(void){
    assert(ins_crc16("123456789",9)==0x29b1);ins_parser p;ins_parser_init(&p);
    ins_frame a={65535,1,300,1200},b;char buf[80];size_t n=ins_encode(&a,buf,sizeof(buf));
    assert(n>0);for(size_t i=0;i<n-1;i++)assert(!ins_parser_feed(&p,buf[i],&b));
    assert(ins_parser_feed(&p,buf[n-1],&b));assert(a.seq==b.seq&&a.type==b.type&&a.a==b.a&&a.b==b.b);
    assert(ins_encode(&a,buf,3)==0);
}
static void test_parser_rejects_malformed(void){
    const char *bad[]={"65536,1,900,900","1,65536,0,0","1,1,900","1,1,900,900,0","1,1,+900,900","1,1, 900,900","1,1,2147483648,900","1,1,900,900x","1,1,,900","-1,1,0,0"};
    ins_parser p;ins_parser_init(&p);ins_frame f;char buf[100];
    for(unsigned i=0;i<sizeof(bad)/sizeof(bad[0]);i++){raw(buf,bad[i]);assert(!feed(&p,buf,&f));}
    assert(p.bad_format==10);raw(buf,"2,4,0,0");buf[4]='3';assert(!feed(&p,buf,&f));assert(p.bad_crc==1);
}
static void test_parser_recovers_and_bounds(void){
    ins_parser p;ins_parser_init(&p);ins_frame f;char good[80];raw(good,"2,4,0,0");
    assert(!feed(&p,"ignored noise @",&f));for(unsigned i=0;i<1000;i++)assert(!ins_parser_feed(&p,'x',&f));
    assert(!ins_parser_feed(&p,'\n',&f));assert(p.too_long==1);assert(feed(&p,good,&f));
    assert(!feed(&p,"@truncated",&f));assert(feed(&p,good,&f));assert(f.seq==2);
    uint32_t r=1234567;for(unsigned i=0;i<20000;i++){r=r*1664525U+1013904223U;ins_parser_feed(&p,(char)(r>>24),&f);assert(p.length<INS_FRAME_MAX);}
    assert(feed(&p,good,&f));
}
static void test_disabled_and_lease(void){
    ins_controller c;ins_init(&c,0);assert(!c.output_enabled&&c.mode==INS_PAUSED);
    assert(send(&c,1,1,900,900,0)==INS_ERR_NO_HEARTBEAT);
    assert(send(&c,2,4,0,0,0)==INS_OK);assert(send(&c,3,1,1000,900,0)==INS_ERR_DISABLED);
    ins_tick(&c,1000);assert(c.commanded.pan==900);
    assert(send(&c,4,3,2,0,3000)==INS_OK);assert(c.mode==INS_PAUSED);
}
static void test_limits_and_reserved_fields(void){
    ins_controller c;arm(&c,0);
    assert(send(&c,2,1,299,900,0)==INS_ERR_RANGE);assert(send(&c,3,1,900,1201,0)==INS_ERR_RANGE);
    assert(send(&c,4,2,3,0,0)==INS_ERR_RANGE);assert(send(&c,5,2,0,1,0)==INS_ERR_RANGE);
    assert(send(&c,6,4,1,0,0)==INS_ERR_RANGE);assert(send(&c,7,101,0,0,0)==INS_ERR_TYPE);
    assert(send(&c,8,1,300,450,0)==INS_OK);assert(c.target.pan==300&&c.target.tilt==450);
}
static void test_gradual_no_catchup(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,1,1500,1200,0)==INS_OK);
    ins_tick(&c,19);assert(c.commanded.pan==900);ins_tick(&c,20);assert(c.commanded.pan==906);
    ins_tick(&c,1000);assert(c.commanded.pan==912);assert(c.commanded.tilt==912);
}
static void test_timeout_freezes_and_requires_resume(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,1,1500,900,0)==INS_OK);ins_tick(&c,20);
    int16_t held=c.commanded.pan;ins_tick(&c,1500);assert(c.mode==INS_PAUSED&&c.target.pan==held&&c.link_losses==1);
    assert(send(&c,3,4,0,0,1600)==INS_OK);ins_tick(&c,1620);assert(c.commanded.pan==held&&c.mode==INS_PAUSED&&c.link_losses==1);
    assert(send(&c,4,1,1000,900,1640)==INS_OK);ins_tick(&c,1660);assert(c.commanded.pan==held+6);
}
static void test_late_heartbeat_cannot_hide_loss(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,3,1,0,0)==INS_OK);
    assert(send(&c,3,4,0,0,1500)==INS_OK);assert(c.mode==INS_PAUSED);ins_tick(&c,1520);assert(c.commanded.pan==900);
}
static void test_replay_and_wrap(void){
    ins_controller c;ins_init(&c,0);ins_set_output_enabled(&c,true,0);
    assert(send(&c,65534,4,0,0,0)==INS_OK);assert(send(&c,65535,1,1000,900,0)==INS_OK);
    assert(send(&c,65535,1,1200,900,0)==INS_ERR_REPLAY);assert(c.target.pan==1000);
    assert(send(&c,0,4,0,0,10)==INS_OK);assert(send(&c,65534,1,1200,900,10)==INS_ERR_REPLAY);
    assert(send(&c,32768,4,0,0,20)==INS_ERR_REPLAY);assert(send(&c,1,4,0,0,20)==INS_OK);
}
static void test_manual_preempts_patrol(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,3,1,0,0)==INS_OK);assert(c.target.pan==500);
    ins_tick(&c,20);assert(send(&c,3,1,1100,1000,30)==INS_OK);
    assert(c.mode==INS_MANUAL&&c.target.pan==1100&&c.active_preset==255);
}
static void test_stable_dwell_then_next(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,10,900,900,0)==INS_OK);assert(send(&c,3,3,1,0,0)==INS_OK);
    ins_tick(&c,20);assert(c.phase==INS_SETTLING&&!ins_take_observation(&c));
    ins_tick(&c,519);assert(c.phase==INS_SETTLING);ins_tick(&c,520);assert(c.phase==INS_DWELLING&&ins_take_observation(&c));
    assert(!ins_take_observation(&c));assert(send(&c,4,4,0,0,1000)==INS_OK);assert(send(&c,5,4,0,0,2000)==INS_OK);
    ins_tick(&c,2519);assert(c.active_preset==0);ins_tick(&c,2520);assert(c.active_preset==1&&c.phase==INS_MOVING);
}
static void test_preset_update_and_pause(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,12,1400,1000,0)==INS_OK);assert(send(&c,3,2,2,0,0)==INS_OK);assert(c.target.pan==1400);
    assert(send(&c,4,3,1,0,0)==INS_OK);assert(send(&c,5,10,800,900,0)==INS_ERR_BUSY);
    assert(send(&c,6,3,2,0,0)==INS_OK);assert(send(&c,7,10,800,900,0)==INS_OK);assert(c.mode==INS_PAUSED);
    assert(send(&c,8,11,1510,900,0)==INS_ERR_RANGE);
}
static void test_tick_rollover(void){
    ins_controller c;uint32_t t=UINT32_MAX-10U;arm(&c,t);assert(send(&c,2,1,1000,900,t)==INS_OK);
    ins_tick(&c,9);assert(c.commanded.pan==906);assert(ins_link_alive(&c,1000));
    ins_tick(&c,1490);assert(c.mode==INS_PAUSED);
}
static void test_disarm_clears_target(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,1,1400,900,0)==INS_OK);ins_tick(&c,20);
    ins_set_output_enabled(&c,false,40);assert(c.target.pan==906&&c.mode==INS_PAUSED);
    ins_set_output_enabled(&c,true,60);ins_tick(&c,80);assert(c.commanded.pan==906);
}
static void test_pwm_needs_explicit_resume(void){
    ins_controller c;arm(&c,0);assert(!ins_output_permitted(&c,0));
    assert(send(&c,2,1,1400,900,0)==INS_OK);assert(ins_output_permitted(&c,0));
    ins_tick(&c,1500);assert(!ins_output_permitted(&c,1500));
    assert(send(&c,3,4,0,0,1600)==INS_OK);assert(!ins_output_permitted(&c,1600));
    assert(send(&c,4,1,1400,900,1620)==INS_OK);assert(ins_output_permitted(&c,1620));
    assert(send(&c,5,3,2,0,1640)==INS_OK);assert(!ins_output_permitted(&c,1640));
}
static void test_continuous_manual_updates_progress(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,1,1400,900,0)==INS_OK);
    uint16_t seq=3;
    for(uint32_t t=10;t<=100;t+=10){assert(send(&c,seq++,1,1400,900,t)==INS_OK);ins_tick(&c,t);}
    assert(c.commanded.pan==930);
}
static void test_expired_lease_stays_expired_after_full_wrap(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,1,1400,900,0)==INS_OK);ins_tick(&c,1500);
    assert(c.lease_expired&&!ins_link_alive(&c,0)&&!ins_output_permitted(&c,0));
    assert(send(&c,3,1,1400,900,0)==INS_ERR_NO_HEARTBEAT);
    assert(send(&c,4,4,0,0,10)==INS_OK);assert(ins_link_alive(&c,10));assert(!ins_output_permitted(&c,10));
}
static void test_restart_sync_after_rejected_command(void){
    ins_controller c;arm(&c,0);assert(send(&c,2,1,1501,900,0)==INS_ERR_RANGE);
    assert(c.last_seq==2&&c.accepted_seq==1);assert(send(&c,1,4,0,0,10)==INS_ERR_REPLAY);assert(c.last_seq==2);
    uint16_t resumed_seq=(uint16_t)(c.last_seq+1U);assert(send(&c,resumed_seq,4,0,0,20)==INS_OK);
    assert(c.mode==INS_PAUSED&&c.last_seq==3);
}
static void test_preset_count_validation_and_commit(void){
    ins_controller c;ins_init(&c,0);assert(c.active_count==3);
    assert(send(&c,1,13,2,0,0)==INS_ERR_NO_HEARTBEAT);assert(c.active_count==3);
    assert(send(&c,2,4,0,0,0)==INS_OK);
    assert(send(&c,3,13,0,0,0)==INS_ERR_RANGE);assert(c.active_count==3);
    assert(send(&c,4,13,4,0,0)==INS_ERR_RANGE);assert(c.active_count==3);
    assert(send(&c,5,13,2,1,0)==INS_ERR_RANGE);assert(c.active_count==3);
    /* 安装配置不能自动启用 PWM；禁用输出时仍可完成配点握手。 */
    assert(send(&c,6,13,2,0,0)==INS_OK);assert(c.active_count==2&&!c.output_enabled);
    assert(c.mode==INS_PAUSED&&c.active_preset==255&&!ins_output_permitted(&c,0));
    assert(send(&c,7,2,2,0,0)==INS_ERR_RANGE);
    assert(send(&c,8,2,1,0,0)==INS_ERR_DISABLED);
    assert(send(&c,6,13,3,0,0)==INS_ERR_REPLAY);assert(c.active_count==2&&c.last_seq==8);
    ins_set_output_enabled(&c,true,0);
    assert(send(&c,9,3,1,0,0)==INS_OK);
    assert(send(&c,10,13,1,0,0)==INS_ERR_BUSY);assert(c.active_count==2&&c.mode==INS_PATROL);
    assert(send(&c,11,3,2,0,0)==INS_OK);assert(send(&c,12,13,1,0,0)==INS_OK);
    assert(c.active_count==1&&c.mode==INS_PAUSED&&c.active_preset==255);
}
static void test_two_point_patrol_never_visits_disabled_slot(void){
    ins_controller c;arm(&c,0);uint16_t seq=2;
    assert(send(&c,seq++,10,900,900,0)==INS_OK);assert(send(&c,seq++,11,930,900,0)==INS_OK);
    assert(send(&c,seq++,12,1400,1100,0)==INS_OK); /* 第三个槽仍保有旧坐标。 */
    assert(send(&c,seq++,13,2,0,0)==INS_OK);assert(send(&c,seq++,3,1,0,0)==INS_OK);
    unsigned seen=0,observed=0;
    for(uint32_t t=20;t<=16000;t+=20){
        if(t%400==0)assert(send(&c,seq++,4,0,0,t)==INS_OK);
        ins_tick(&c,t);assert(c.active_preset<2&&c.active_count==2);
        assert(c.target.pan==900||c.target.pan==930);assert(c.target.tilt==900);
        if(ins_take_observation(&c)){seen|=1U<<c.active_preset;observed++;}
    }
    assert(seen==3&&observed>=5); /* 至少跨过两个完整往返，非单步取模自测。 */
    assert(send(&c,seq++,2,2,0,16000)==INS_ERR_RANGE);assert(c.active_preset<2);
}
static void test_one_point_patrol_and_range(void){
    ins_controller c;arm(&c,0);uint16_t seq=2;
    assert(send(&c,seq++,10,900,900,0)==INS_OK);assert(send(&c,seq++,13,1,0,0)==INS_OK);
    assert(send(&c,seq++,2,1,0,0)==INS_ERR_RANGE);assert(send(&c,seq++,2,2,0,0)==INS_ERR_RANGE);
    assert(send(&c,seq++,3,1,0,0)==INS_OK);unsigned observed=0;
    for(uint32_t t=20;t<=8000;t+=20){
        if(t%400==0)assert(send(&c,seq++,4,0,0,t)==INS_OK);
        ins_tick(&c,t);assert(c.active_preset==0&&c.target.pan==900);
        if(ins_take_observation(&c))observed++;
    }
    assert(observed>=3);
}
static void test_pause_clears_observation_identity(void){
    ins_controller c;arm(&c,0);
    assert(send(&c,2,2,2,0,0)==INS_OK);ins_tick(&c,20);assert(c.active_preset==2&&c.commanded.pan!=c.target.pan);
    assert(send(&c,3,3,2,0,30)==INS_OK);
    assert(c.active_preset==255&&c.phase==INS_IDLE&&c.target.pan==c.commanded.pan&&!ins_take_observation(&c));
    assert(send(&c,4,2,2,0,40)==INS_OK);ins_tick(&c,1500);
    assert(c.active_preset==255&&c.mode==INS_PAUSED&&!ins_take_observation(&c));
    assert(send(&c,5,4,0,0,1600)==INS_OK);assert(send(&c,6,10,c.commanded.pan,c.commanded.tilt,1600)==INS_OK);
    assert(send(&c,7,2,0,0,1600)==INS_OK);ins_tick(&c,1620);ins_tick(&c,2120);
    assert(c.active_preset==0&&c.observation_ready&&c.phase==INS_DWELLING);
    ins_pause(&c); /* UART 异常等板级路径，作废尚未取走的旧观察。 */
    assert(c.active_preset==255&&c.phase==INS_IDLE&&!ins_take_observation(&c));
    assert(send(&c,8,2,0,0,2140)==INS_OK);ins_set_output_enabled(&c,false,2150);
    assert(c.active_preset==255&&c.mode==INS_PAUSED&&!ins_output_permitted(&c,2150));
}
static void test_config_update_invalidates_stability(void){
    ins_controller c;arm(&c,0);
    assert(send(&c,2,10,900,900,0)==INS_OK);assert(send(&c,3,2,0,0,0)==INS_OK);
    ins_tick(&c,20);ins_tick(&c,520);assert(c.phase==INS_DWELLING&&c.observation_ready);
    assert(send(&c,4,10,920,900,530)==INS_OK);
    assert(c.mode==INS_PAUSED&&c.active_preset==255&&!ins_take_observation(&c));
    assert(send(&c,5,2,2,0,540)==INS_OK);ins_tick(&c,560);
    assert(send(&c,6,13,2,0,570)==INS_OK);
    assert(c.active_count==2&&c.active_preset==255&&c.target.pan==c.commanded.pan&&!ins_output_permitted(&c,570));
    assert(send(&c,7,2,2,0,580)==INS_ERR_RANGE);
    assert(send(&c,8,3,0,0,590)==INS_OK);assert(c.active_preset==255&&c.phase==INS_IDLE);
}
static void test_count_and_paused_golden_frames(void){
    /* 固定向量同时验证发送/接收，CRC 来自独立标准库核对，不在测试内动态重算期望。 */
    const char *lines[]={"@4,13,2,0*6A63\n","@4,101,13,0*F13A\n","@5,103,0,255*D9ED\n"};
    const ins_frame frames[]={{4,13,2,0},{4,101,13,0},{5,103,0,255}};
    for(unsigned i=0;i<3;i++){
        ins_parser p;ins_parser_init(&p);ins_frame got;char encoded[80];
        assert(feed(&p,lines[i],&got));
        assert(got.seq==frames[i].seq&&got.type==frames[i].type&&got.a==frames[i].a&&got.b==frames[i].b);
        assert(ins_encode(&frames[i],encoded,sizeof(encoded))==strlen(lines[i]));assert(strcmp(encoded,lines[i])==0);
    }
}
int main(void){
    RUN(test_crc_and_roundtrip);RUN(test_parser_rejects_malformed);RUN(test_parser_recovers_and_bounds);
    RUN(test_disabled_and_lease);RUN(test_limits_and_reserved_fields);RUN(test_gradual_no_catchup);
    RUN(test_timeout_freezes_and_requires_resume);RUN(test_late_heartbeat_cannot_hide_loss);RUN(test_replay_and_wrap);
    RUN(test_manual_preempts_patrol);RUN(test_stable_dwell_then_next);RUN(test_preset_update_and_pause);
    RUN(test_tick_rollover);RUN(test_disarm_clears_target);RUN(test_pwm_needs_explicit_resume);
    RUN(test_continuous_manual_updates_progress);RUN(test_expired_lease_stays_expired_after_full_wrap);
    RUN(test_restart_sync_after_rejected_command);
    RUN(test_preset_count_validation_and_commit);RUN(test_two_point_patrol_never_visits_disabled_slot);
    RUN(test_one_point_patrol_and_range);RUN(test_pause_clears_observation_identity);
    RUN(test_config_update_invalidates_stability);
    RUN(test_count_and_paused_golden_frames);
    printf("%u tests passed; hardware not tested\n",tests);return 0;
}
