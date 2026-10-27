#include "inspection.h"
#include <string.h>

static bool range(int32_t pan,int32_t tilt) {
    return pan>=INS_PAN_MIN&&pan<=INS_PAN_MAX&&tilt>=INS_TILT_MIN&&tilt<=INS_TILT_MAX;
}
void ins_pause(ins_controller *c) {
    /* idle 不表示当前镜头仍对准旧预置点；暂停可能发生在途中。 */
    c->mode=INS_PAUSED;c->phase=INS_IDLE;c->target=c->commanded;c->observation_ready=false;
    c->active_preset=255;
}
static void expire_link(ins_controller *c) {
    if(c->heartbeat_seen&&!c->lease_expired)c->link_losses++;
    c->lease_expired=true;ins_pause(c);
}
bool ins_link_alive(const ins_controller *c,uint32_t now) {
    return c->heartbeat_seen&&!c->lease_expired&&(uint32_t)(now-c->heartbeat_at)<INS_HEARTBEAT_MS;
}
bool ins_output_permitted(const ins_controller *c,uint32_t now) {
    /* 心跳恢复只恢复通信；必须有新的运动/模式命令才能恢复PWM。 */
    return c->output_enabled&&ins_link_alive(c,now)&&c->mode!=INS_PAUSED;
}
void ins_init(ins_controller *c,uint32_t now) {
    memset(c,0,sizeof(*c));c->commanded=(ins_pose){900,900};c->target=c->commanded;
    c->presets[0]=(ins_pose){500,900};c->presets[1]=(ins_pose){900,900};c->presets[2]=(ins_pose){1300,900};
    c->mode=INS_PAUSED;c->phase=INS_IDLE;c->active_preset=255;c->step_at=now;
    /* 兼容旧版三个内置点；协处理器同步时用 type13 提交实际有效点数。 */
    c->active_count=INS_PRESET_COUNT;
}
void ins_set_output_enabled(ins_controller *c,bool enabled,uint32_t now) {
    c->output_enabled=enabled;c->step_at=now;
    /* 解锁不能导致历史目标自动恢复。 */
    ins_pause(c);
}
static void move_to(ins_controller *c,ins_pose target,uint32_t now) {
    /* 连续遥控更新目标不能重置正在运动的步进时钟，否则高频指令会饿死步进。 */
    if(c->phase!=INS_MOVING)c->step_at=now;
    c->target=target;c->phase=INS_MOVING;c->observation_ready=false;
}
ins_result ins_command(ins_controller *c,const ins_frame *f,uint32_t now) {
    /* 所有合法CRC命令共用序号空间：半范围算法支持65535→0，拒绝重复和旧包。
       拒绝的命令也消耗seq，避免一条先被禁用的旧命令之后突然被执行。 */
    uint16_t delta=(uint16_t)(f->seq-c->last_seq);
    if(c->seq_seen&&(delta==0U||delta>=32768U))return INS_ERR_REPLAY;
    c->seq_seen=true;c->last_seq=f->seq;
    if(f->type==4) {
        if(f->a!=0||f->b!=0)return INS_ERR_RANGE;
        /* 心跳到达晚于租约时必须先暂停，绝不能只更新时间后继续旧巡检。 */
        if(c->heartbeat_seen&&!ins_link_alive(c,now))expire_link(c);
        c->heartbeat_seen=true;c->lease_expired=false;c->heartbeat_at=now;c->accepted_seq=f->seq;return INS_OK;
    }
    if(f->type==3&&f->a==INS_PAUSED&&f->b==0){ins_pause(c);c->accepted_seq=f->seq;return INS_OK;}
    if(!ins_link_alive(c,now)) {expire_link(c);return INS_ERR_NO_HEARTBEAT;}
    if(f->type>=10&&f->type<=12) {
        if(!range(f->a,f->b))return INS_ERR_RANGE;
        if(c->mode==INS_PATROL)return INS_ERR_BUSY;
        c->presets[f->type-10]=(ins_pose){(int16_t)f->a,(int16_t)f->b};
        /* 修改坐标后旧 active/驻留证据已失效，不能继续误认为到点。 */
        ins_pause(c);
        c->accepted_seq=f->seq;return INS_OK;
    }
    if(f->type==13) {
        if(f->a<1||f->a>INS_PRESET_COUNT||f->b!=0)return INS_ERR_RANGE;
        if(c->mode==INS_PATROL)return INS_ERR_BUSY;
        c->active_count=(uint8_t)f->a;ins_pause(c);
        c->accepted_seq=f->seq;return INS_OK;
    }
    if(f->type!=1&&f->type!=2&&f->type!=3)return INS_ERR_TYPE;
    if(f->type==1&&!range(f->a,f->b))return INS_ERR_RANGE;
    if(f->type==2&&(f->a<0||f->a>=c->active_count||f->b!=0))return INS_ERR_RANGE;
    if(f->type==3&&(f->a<0||f->a>INS_PAUSED||f->b!=0))return INS_ERR_RANGE;
    if(!c->output_enabled)return INS_ERR_DISABLED;
    if(f->type==1) {
        c->mode=INS_MANUAL;c->active_preset=255;
        move_to(c,(ins_pose){(int16_t)f->a,(int16_t)f->b},now);
    } else if(f->type==2) {
        c->mode=INS_MANUAL;c->active_preset=(uint8_t)f->a;
        move_to(c,c->presets[c->active_preset],now);
    } else {
        c->mode=(ins_mode)f->a;
        if(c->mode==INS_PATROL){c->active_preset=0;move_to(c,c->presets[0],now);}
        else {c->target=c->commanded;c->phase=INS_IDLE;c->observation_ready=false;c->active_preset=255;}
    }
    c->accepted_seq=f->seq;return INS_OK;
}
static int16_t step(int16_t current,int16_t target) {
    int32_t d=(int32_t)target-current;
    if(d>INS_STEP_ANGLE)return (int16_t)(current+INS_STEP_ANGLE);
    if(d< -INS_STEP_ANGLE)return (int16_t)(current-INS_STEP_ANGLE);
    return target;
}
void ins_tick(ins_controller *c,uint32_t now) {
    if(c->heartbeat_seen&&!ins_link_alive(c,now)) {
        expire_link(c);return;
    }
    if(!c->output_enabled||c->mode==INS_PAUSED)return;
    if(c->phase==INS_MOVING&&(uint32_t)(now-c->step_at)>=INS_STEP_MS) {
        /* 不追赶因阻塞错过的步进，避免主循环恢复时一次跨越大角度。 */
        c->step_at=now;c->commanded.pan=step(c->commanded.pan,c->target.pan);
        c->commanded.tilt=step(c->commanded.tilt,c->target.tilt);
        if(c->commanded.pan==c->target.pan&&c->commanded.tilt==c->target.tilt) {
            c->phase=INS_SETTLING;c->phase_at=now;
        }
    } else if(c->phase==INS_SETTLING&&(uint32_t)(now-c->phase_at)>=INS_SETTLE_MS) {
        c->phase=INS_DWELLING;c->phase_at=now;c->observation_ready=true;c->observations++;
    } else if(c->phase==INS_DWELLING&&(uint32_t)(now-c->phase_at)>=INS_DWELL_MS) {
        if(c->mode==INS_PATROL) {
            c->active_preset=(uint8_t)((c->active_preset+1)%c->active_count);
            move_to(c,c->presets[c->active_preset],now);
        } else c->phase=INS_IDLE;
    }
}
bool ins_take_observation(ins_controller *c) {bool ready=c->observation_ready;c->observation_ready=false;return ready;}
