"""调用 CAD 快照，不以外观渲染替代 CAD 几何验证。"""
import json,subprocess,sys,os
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'models'))
from inspection_geometry import PARTS

def main():
    out=ROOT/'previews';out.mkdir(exist_ok=True)
    jobs=[]
    allowed=['inspection_terminal','exploded_terminal',*PARTS,'fit_coupon']
    names=sys.argv[1:] or allowed
    if any(name not in allowed for name in names): raise SystemExit('Unknown snapshot model name')
    tag='_'+('_'.join(names)) if sys.argv[1:] else ''
    for name in names:
        cameras=['iso']
        if name=='inspection_terminal': cameras=['iso',{'direction':[-1,1,-.8]},'top','front']
        jobs.append({'input':str(ROOT/'models'/f'{name}.step.py'),'mode':'view',
                     'outputs':[{'path':str(out/f'{name}_{i}.png'),'camera':c} for i,c in enumerate(cameras)],
                     'render':{'viewLabels':True,'padding':.13,'sizeProfile':'diagnostic'}})
    jobfile=ROOT/'evidence'/f'snapshot_jobs{tag}.json';jobfile.write_text(json.dumps({'jobs':jobs}),encoding='utf-8')
    cmd=[sys.executable,str(Path(os.environ.get('CAD_SKILL_PATH', str(Path.home()/'.codex/skills/cad')))/'scripts/snapshot'),'--job',str(jobfile),'--json']
    env=os.environ.copy();env['PYTHONUTF8']='1'
    r=subprocess.run(cmd,cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace')
    (ROOT/'evidence'/f'snapshot_result{tag}.json').write_text(r.stdout,encoding='utf-8')
    (ROOT/'evidence'/f'snapshot_stderr{tag}.log').write_text(r.stderr,encoding='utf-8')
    print(r.stdout[-6000:]);print(r.stderr[-2000:]);raise SystemExit(r.returncode)

if __name__=='__main__':main()
