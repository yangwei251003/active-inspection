"""主动巡检终端参数化机械结构，单位 mm。

采购件只建命名包络，不伪装官方模型。所有零件均以打印底面为 Z=0。
生成入口由同目录 *.step.py 调用；不要编辑派生 STEP/STL。
"""
from functools import lru_cache
from build123d import (Box, Cylinder, RectangleRounded, SlotOverall, RegularPolygon,
                      extrude, Pos, Rot, Compound, Color, Align, Location)

P = dict(width=180., depth=130., base_h=52., wall=2.4, floor=2.4,
         radius=10., lid_t=3., clearance=.35, tray_w=152., tray_d=104.,
         tray_t=2.8, tray_z=8., board_riser=12., screw_d=3.4,
         boss_x=81., boss_y=56., boss_r=5., camera_w=48., camera_h=46.,
         camera_depth=22., camera_screw_x=19.2, camera_screw_y=18.2,
         head_z=116., head_y=-23., plate_z=55.)

def color(hexcode):
    vals=[int(hexcode[i:i+2],16)/255. for i in (1,3,5)]
    vals=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in vals]
    return Color(*vals)

COLORS={"base":"#28333D","lid":"#D7DBD7","tray":"#79868D", "head":"#28333D",
        "accent":"#DEBA59", "hardware":"#585D66", "board":"#467E69"}

def finish(shape,name,tone="base"):
    shape.label=name
    shape.color=color(COLORS.get(tone,tone))
    return shape

def rr(w,d,h,r=4,z=0):
    return Pos(0,0,z)*extrude(RectangleRounded(w,d,r), amount=h)

def cyl(d,h,x=0,y=0,z=0):
    return Pos(x,y,z)*Cylinder(d/2,h,align=(Align.CENTER,Align.CENTER,Align.MIN))

def slot(length,width,h,x=0,y=0,z=-1,angle=0):
    return Pos(x,y,z)*Rot(0,0,angle)*extrude(SlotOverall(length,width),amount=h)

def box(w,d,h,x=0,y=0,z=0):
    return Pos(x,y,z)*Box(w,d,h,align=(Align.CENTER,Align.CENTER,Align.MIN))

def base():
    p=P
    a=rr(p['width'],p['depth'],p['base_h'],p['radius'])
    a-=rr(p['width']-2*p['wall'],p['depth']-2*p['wall'],p['base_h'],p['radius']-p['wall'],p['floor'])
    a+= [cyl(2*p['boss_r'],p['base_h'],sx*p['boss_x'],sy*p['boss_y']) for sx in (-1,1) for sy in (-1,1)]
    # 用开口式螺母窝取代热熔螺母。
    a-= [cyl(p['screw_d'],p['base_h']+2,sx*p['boss_x'],sy*p['boss_y'],-1) for sx in (-1,1) for sy in (-1,1)]
    a-= [Pos(sx*p['boss_x'],sy*p['boss_y'],p['base_h']-5)*extrude(RegularPolygon(5.8/1.7320508,6),amount=2.8) for sx in (-1,1) for sy in (-1,1)]
    # 螺母可从内侧水平槽装入，不需封印在打印件内。
    a-= [box(7,8,2.8,sx*p['boss_x'],sy*(p['boss_y']-4),p['base_h']-5) for sx in (-1,1) for sy in (-1,1)]
    # 背部预制线束及独立舵机电源插拔窗口，不绑定未核实的板卡端口。
    a-= [box(90,8,18,-20,64,13),box(18,8,14,53,64,15)]
    # 左右长条通风，保留底角、顶边连续框。
    a-= [box(8,3.0,16,sx*89,y,19) for sx in (-1,1) for y in range(-39,40,6)]
    # 前部狭长标记凹槽，贴标签，不要求增加显示屏。
    a-=box(42,1.2,5,-50,-64.9,31)
    # 托盘落座垫和 M3 通孔，螺母从底面装入。
    pads=[box(12,12,p['tray_z'],sx*65,sy*44) for sx in(-1,1) for sy in(-1,1)]
    a+=pads
    a-= [cyl(3.4,11,sx*65,sy*44,-1) for sx in(-1,1) for sy in(-1,1)]
    # 底面橡胶脚粘贴浅凹，留连续 1.8 mm 底。
    a-= [cyl(10,.6,sx*69,sy*51,0) for sx in(-1,1) for sy in(-1,1)]
    return finish(a,'base_shell','base')

def lid():
    a=rr(P['width'],P['depth'],P['lid_t'],P['radius'])
    # 下部定位环，0.35 mm 每侧余量。
    ow=P['width']-2*(P['wall']+P['clearance']); od=P['depth']-2*(P['wall']+P['clearance'])
    ring=rr(ow,od,3,7.0,-3)-rr(ow-3.2,od-3.2,5,5.4,-4)
    # 避让四角螺丝柱，避免定位圈穿柱。
    ring-= [cyl(12,6,sx*P['boss_x'],sy*P['boss_y'],-4) for sx in(-1,1) for sy in(-1,1)]
    a+=ring
    a-= [cyl(3.4,9,sx*P['boss_x'],sy*P['boss_y'],-4) for sx in(-1,1) for sy in(-1,1)]
    a-= [cyl(3.4,6,sx*28,sy*23,-1) for sx in(-1,1) for sy in(-1,1)]
    a-=slot(26,10,6,0,13,-1)
    a-= [slot(37,2.5,6,sx*59,y,-1,90) for sx in(-1,1) for y in(-20,20)]
    # 底部避让后线束无需拆线就能抬盖。
    return finish(a,'lid_with_locating_rim','lid')

def tray():
    a=rr(P['tray_w'],P['tray_d'],P['tray_t'],5)
    a-= [cyl(3.4,5,sx*65,sy*44,-1) for sx in(-1,1) for sy in(-1,1)]
    # 绑带避开 PCB 焊点；实际支脚位置按板底避空区调整。
    a-= [slot(34,3.4,5,x,y,-1,90) for x in(-69,-4,6,64) for y in(-23,23)]
    a-= [slot(44,5,5,x,y,-1) for x in(-36,35) for y in(-32,-16,0,16,32)]
    return finish(a,'adjustable_electronics_tray','tray')

def gantry_plate():
    a=rr(72,64,3.2,7)
    a-= [cyl(3.4,6,sx*28,sy*23,-1) for sx in(-1,1) for sy in(-1,1)]
    a-= [slot(39,3.4,6,0,y,-1) for y in(-15,0,15)]
    a-= [slot(26,3.2,6,x,0,-1,90) for x in(-25,25)]
    a-=slot(25,8,6,0,25,-1)
    return finish(a,'universal_pan_tilt_adapter','accent')

def camera_shell():
    # 局部 XY 是正面，+Z 指向相机背面；装配时旋到 XZ。
    a=rr(48,46,22,8)
    a-=rr(43.2,41.2,22,5.6,2.4)
    a-=cyl(22,5,z=-1)
    # 孔柱外移避开 32×32 相机 PCB 的角部，并在后盖使用相同参数。
    # 孔 2.5，M3 塑料自攻仅低扭矩，仍须打印及实际相机核验。
    a+= [cyl(6,22,sx*P['camera_screw_x'],sy*P['camera_screw_y']) for sx in(-1,1) for sy in(-1,1)]
    a-= [cyl(2.5,10,sx*P['camera_screw_x'],sy*P['camera_screw_y'],13) for sx in(-1,1) for sy in(-1,1)]
    a-=box(20,8,7,0,-22,15)
    return finish(a,'camera_front_shell','head')

def camera_back():
    a=rr(48,46,2.4,8)
    a-= [cyl(3.4,5,sx*P['camera_screw_x'],sy*P['camera_screw_y'],-1) for sx in(-1,1) for sy in(-1,1)]
    a-= [slot(27,3.2,5,x,0,-1,90) for x in(-11,11)]
    a-=slot(23,5,5,0,-15,-1)
    # 横槽不与纵向绑带槽相交，保留中心桥，避免切出悬空小片。
    a-= [slot(14,3.4,5,0,y,-1) for y in(-7,7)]
    return finish(a,'camera_back_adjustable_mount','head')

def board_foot():
    a=rr(11,11,12,2)
    a-=cyl(3.4,14,z=-1)
    return finish(a,'pcb_insulating_foot','tray')

def cable_anchor():
    a=rr(30,12,3,3)
    a-= [slot(7,3.2,5,x,0,-1,90) for x in(-8,8)]
    a+=box(12,3,4,0,0,3)
    return finish(a,'cable_tie_anchor','accent')

PARTS={'base_shell':base,'lid':lid,'electronics_tray':tray,'gantry_adapter':gantry_plate,
       'camera_shell':camera_shell,'camera_back':camera_back,'pcb_foot':board_foot,'cable_anchor':cable_anchor}

def printable(name):
    s=PARTS[name]()
    # 每件 STL 以最低面为 Z=0，盖子的定位环朝上打印可减少支撑。
    if name=='lid':
        s=Rot(180,0,0)*s
    s=Pos(0,0,-s.bounding_box().min.Z)*s
    return s

def assembled(exploded=False, envelopes=True):
    e=30. if exploded else 0.
    c=[base(), Pos(0,0,52+e*2)*lid(), Pos(0,0,P['tray_z']+e)*tray(),
       Pos(0,0,P['plate_z']+e*3)*gantry_plate()]
    # 相机正面指向 -Y，局部 Z 指向背面 +Y。
    camera_pose=Pos(0,P['head_y'],P['head_z']+e*4)*Rot(-90,0,0)
    c.extend([camera_pose*camera_shell(), camera_pose*Pos(0,0,22+e*.5)*camera_back()])
    for i,(x,y) in enumerate([(x,y) for x in(-65,-6,13,60) for y in(-34,34)]):
        c.append(finish(Pos(x,y,10.8+e)*board_foot(),f'pcb_foot_{i+1}','tray'))
    c.append(Pos(-38,48,2.4)*cable_anchor())
    if envelopes:
        # 空间包络非精确组件 CAD：板卡含顶面器件和接插件高度。
        c.append(finish(box(70,82.5,24,-36,0,22.8+e),'REFERENCE_NUCLEO_F401RE_ENVELOPE','board'))
        c.append(finish(box(56,85,25,35,0,22.8+e),'REFERENCE_P4_NANO_ENVELOPE','board'))
        # 正式云台由采购件替代，几何包络仅用于总高和预留空间。
        c.append(finish(box(38,30,30,0,0,58.2+e*3),'REFERENCE_PAN_SERVO_ENVELOPE','hardware'))
        c.append(finish(box(55,20,35,0,12,88.2+e*3),'REFERENCE_TILT_BRACKET_ENVELOPE','hardware'))
        lens=cyl(14,7,z=-3)
        c.append(finish(camera_pose*lens,'REFERENCE_LENS_ENVELOPE','#111820'))
    return Compound(label='active_inspection_terminal_exploded' if exploded else 'active_inspection_terminal',children=c)
