"""生成显式 CAD 目标并记录可复验结果；仅在本 mechanical 目录中写入。"""
import json, subprocess, sys, os
from pathlib import Path
ROOT=Path(__file__).resolve().parent
MODELS=ROOT/'models'
SKILL=Path(os.environ.get('CAD_SKILL_PATH', str(Path.home()/'.codex/skills/cad')))
sys.path.insert(0,str(MODELS))
from inspection_geometry import PARTS

def run(args, logfile):
    env=os.environ.copy(); env['PYTHONUTF8']='1'; env['CADGEN_COMPONENT_WORKERS']='1'
    r=subprocess.run([sys.executable,'-X','utf8',*map(str,args)],cwd=ROOT,env=env,text=True,capture_output=True,encoding='utf-8',errors='replace')
    dest=ROOT/'evidence'/logfile
    if dest.suffix=='.json':
        dest.write_text(r.stdout,encoding='utf-8')
        dest.with_suffix('.stderr.log').write_text(r.stderr,encoding='utf-8')
    else:
        dest.write_text(r.stdout+'\nSTDERR\n'+r.stderr,encoding='utf-8')
    if r.returncode:
        print(r.stdout[-3000:]); print(r.stderr[-3000:]); raise SystemExit(r.returncode)
    print(logfile,'OK',flush=True)

def main():
    if not (SKILL/'scripts/gen').is_file():
        raise SystemExit('Install the external CAD Skill and set CAD_SKILL_PATH to its root; pre-exported STEP/STL files can be opened without it.')
    (ROOT/'evidence').mkdir(exist_ok=True); (ROOT/'stl').mkdir(exist_ok=True)
    allowed=['inspection_terminal','exploded_terminal',*PARTS,'fit_coupon']
    targets=sys.argv[1:] or allowed
    if any(name not in allowed for name in targets):
        raise SystemExit('Unknown model target; use explicit approved model names.')
    for name in PARTS:
        dest=MODELS/f'{name}.step.py'
        source=f"from inspection_geometry import printable\ndef gen_step():\n    return printable('{name}')\n"
        if not dest.exists() or dest.read_text(encoding='utf-8')!=source:
            dest.write_text(source,encoding='utf-8')
    for name in targets:
        target=MODELS/f'{name}.step.py'
        run([SKILL/'scripts/gen',target,'--write','--json'],f'{name}_generation.log')
        run([SKILL/'scripts/inspect','validate',target],f'{name}_validate.json')
        run([SKILL/'scripts/inspect','refs',target,'--facts','--planes','--positioning','--plane-limit','6'],f'{name}_facts.json')
        if name in PARTS or name=='fit_coupon':
            run([SKILL/'scripts/export',target,'--stl',ROOT/'stl'/f'{name}.stl','--json'],f'{name}_export.json')
    print('All explicit STEP targets, validations and printable STL exports completed.')

if __name__=='__main__': main()
