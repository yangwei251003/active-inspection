"""收集真实机械验证输出和文件指纹；不替代人工快照审看或实物验证。"""
import hashlib,json
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

ROOT=Path(__file__).resolve().parent
TARGETS=['inspection_terminal','exploded_terminal','base_shell','lid','electronics_tray',
         'gantry_adapter','camera_shell','camera_back','pcb_foot','cable_anchor','fit_coupon']
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def read(name): return json.loads((ROOT/'evidence'/name).read_text(encoding='utf-8'))

def main():
    # 旧构建脚本把 stderr 附在 JSON 后；分开保留原始诊断，恢复可解析证据。
    for path in (ROOT/'evidence').glob('*.json'):
        raw=path.read_text(encoding='utf-8')
        if '\nSTDERR\n' in raw:
            stdout,stderr=raw.split('\nSTDERR\n',1)
            json.loads(stdout)
            path.write_text(stdout.rstrip()+'\n',encoding='utf-8')
            path.with_suffix('.stderr.log').write_text(stderr,encoding='utf-8')
    geometry=read('design_validation.json');mesh=read('stl_validation.json');native=read('freecad_import.json')
    assert geometry['status']=='passed' and mesh['passed']
    assert native['reopen_valid'] and native['reopen_all_components_valid']
    assert native['step_sha256']==digest(ROOT/'models/inspection_terminal.step')
    assert geometry['source_sha256']==native['source_sha256']==digest(ROOT/'models/inspection_geometry.py')
    counts=geometry['bom_counts']
    native_reference_count=sum(p['label'].startswith('REFERENCE_') for p in native['named_components'])
    assert counts['purchased_reference_envelopes']==native_reference_count
    assert counts['installed_printed_parts']+native_reference_count==native['reopen_component_count']
    assert counts['quoted_printed_parts_including_spares']==counts['installed_printed_parts']+counts['spare_printed_parts']
    artifacts={};links={};snapshot_paths={}
    root_url='http://127.0.0.1:58459/'+quote(ROOT.as_posix(),safe='/:')
    for name in TARGETS:
        result=read(name+'_validate.json')
        assert result['ok'] and result['failureCount']==0,name
        source=ROOT/'models'/f'{name}.step.py';step=source.with_suffix('')
        assert source.exists() and step.exists()
        artifacts[name]={'source_sha256':digest(source),'step_sha256':digest(step),
                         'occurrence_count':result['occurrenceCount']}
        links[name]=root_url+'?file='+quote('models/'+source.name,safe='/')
        snaps=sorted((ROOT/'previews').glob(name+'_0_*.png'))
        assert snaps,'Missing required snapshot for '+name
        snapshot_paths[name]=str(snaps[-1])
    with urlopen(root_url,timeout=10) as response: http_status=response.status
    report={'checked_at_utc':datetime.now(timezone.utc).isoformat(),
        'digital_checks_passed':True,'physical_validation_completed':False,
        'viewer_http_status':http_status,'viewer_root':root_url,'viewer_links':links,
        'artifacts':artifacts,'latest_iso_snapshots':snapshot_paths,
        'native_sha256':digest(ROOT/'inspection_terminal.FCStd'),
        'bom_counts':geometry['bom_counts'],'material_estimate_scope':geometry['material_estimate']['scope'],
        'visual_review':'See VISUAL_REVIEW.md for manual review scope and findings; this script only verifies image files exist.',
        'unverified':geometry['unverified']}
    (ROOT/'evidence/delivery_manifest.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'digital_checks_passed':True,'viewer_http_status':http_status,
        'step_targets':len(TARGETS),'stl_targets':len(mesh['targets']),
        'native_components':native['reopen_component_count'],'material_estimate':geometry['material_estimate'],
        'main_viewer':links['inspection_terminal']},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
