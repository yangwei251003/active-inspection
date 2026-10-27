"""Fetch pinned public source dependencies only; no IDF install, device or flash operation."""
from pathlib import Path
import subprocess,json
ROOT=Path(__file__).resolve().parent
DEPENDENCIES=[
    ('vendor/esp-webrtc-solution','https://github.com/espressif/esp-webrtc-solution.git','3971094e2e7c2ab7cb4de59e4eae710e1902d2b4'),
    ('c6/vendor/esp-hosted-mcu','https://github.com/espressif/esp-hosted-mcu.git','dd0176e5fc959d79b306f6677a2f878123c58e9a'),
]
def run(args):return subprocess.check_output(args,text=True,encoding='utf8',stderr=subprocess.STDOUT).strip()
for relative,url,commit in DEPENDENCIES:
    destination=ROOT/relative
    if not destination.exists():
        destination.mkdir(parents=True)
        run(['git','-C',str(destination),'init'])
        run(['git','-C',str(destination),'remote','add','origin',url])
        run(['git','-C',str(destination),'fetch','--depth','1','origin',commit])
        run(['git','-C',str(destination),'checkout','--detach','FETCH_HEAD'])
    if run(['git','-C',str(destination),'rev-parse','HEAD'])!=commit:raise SystemExit('Existing dependency is not the locked commit; left untouched.')
    if run(['git','-C',str(destination),'status','--porcelain']):raise SystemExit('Existing dependency has modifications; left untouched.')
print(json.dumps({'ok':True,'pinned_repositories':len(DEPENDENCIES),'device_accessed':False}))
