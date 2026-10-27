"""以 CAD 导出后的实际面/零件选择器复核配合；不作为实物运动验证。"""
from build_models import run, SKILL

TARGET='models/inspection_terminal.step.py'
JOBS=[
    ('base_lid_flush', ['align',TARGET,'--moving','#o1.2.f4','--target','#o1.1.f4','--mode','flush','--axis','z']),
    ('tray_seat_flush', ['align',TARGET,'--moving','#o1.3.f4','--target','#o1.1.f157','--mode','flush','--axis','z']),
    ('board_spacing', ['measure',TARGET,'--from','#REFERENCE_NUCLEO_F401RE_ENVELOPE','--to','#REFERENCE_P4_NANO_ENVELOPE','--axis','x']),
    ('lid_gantry_flush', ['align',TARGET,'--moving','#o1.4.f4','--target','#o1.2.f5','--mode','flush','--axis','z']),
    ('camera_frame', ['frame',TARGET,'#camera_front_shell']),
]

if __name__=='__main__':
    for name,args in JOBS:
        run([SKILL/'scripts/inspect',*args],name+'.json')
