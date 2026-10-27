"""用 FreeCAD 独立 Python 导入交付 STEP 并保存原生文件，不控制 GUI。"""
import json, hashlib, re
from datetime import datetime, timezone
from pathlib import Path
import FreeCAD as App
import Part
ROOT=Path(__file__).resolve().parent
doc=App.newDocument('ActiveInspection_Reference_Assembly')
assembly=Part.Shape()
assembly.read(str(ROOT/'models/inspection_terminal.step'))
obj=doc.addObject('App::DocumentObjectGroup','InspectionTerminal')
obj.Label='主动巡检终端 / 采购前装配参考'
obj.addProperty('App::PropertyString','Source','Provenance')
obj.Source='models/inspection_geometry.py (parameterized master; regenerate STEP before reimport)'
obj.addProperty('App::PropertyString','Verification','Provenance')
obj.Verification='Geometry checked; no physical fit, thermal, motion, or purchased component verification.'
for name,value in [('BaseWidth',180.),('BaseDepth',130.),('BaseClosedHeight',55.),('WallThickness',2.4),('LidClearanceEachSide',.35)]:
    obj.addProperty('App::PropertyLength',name,'DesignReference');setattr(obj,name,value)
    obj.setEditorMode(name,1)
# 从源/导出对应报告匹配 STEP 实体，为原生文件保留可单独选择的零件。
# 标准差量/包围盒匹配，不假定 STEP 导入后的实体次序。
manifest=json.loads((ROOT/'evidence/design_validation.json').read_text(encoding='utf-8'))
expected=manifest['assembly_parts']
group=doc.addObject('App::DocumentObjectGroup','NamedComponents')
group.Label='命名零件（STEP 实体；参数化主源为 Python）'
obj.addObject(group)
unmatched=list(expected); component_reports=[]
for index,solid in enumerate(assembly.Solids):
    bb=solid.BoundBox
    bbox=[bb.XMin,bb.YMin,bb.ZMin,bb.XMax,bb.YMax,bb.ZMax]
    candidates=[m for m in unmatched if max(abs(a-b) for a,b in zip(bbox,m['bbox_mm']))<1e-5 and abs(solid.Volume-m['volume_mm3'])<1e-3]
    if len(candidates)!=1:
        raise ValueError('Unable to uniquely map imported STEP solid '+str(index))
    metadata=candidates[0];unmatched.remove(metadata)
    part=doc.addObject('PartDesign::Feature','Component_'+str(index+1))
    part.Label=metadata['label'];part.Shape=solid;group.addObject(part)
    part.addProperty('App::PropertyString','EvidenceRole','Provenance')
    part.EvidenceRole='purchased component envelope, not exact hardware CAD' if metadata['label'].startswith('REFERENCE_') else 'printed part (source-driven geometry)'
    component_reports.append({'name':part.Name,'label':part.Label,'valid':solid.isValid(),'volume_mm3':solid.Volume})
if unmatched: raise ValueError('STEP missing expected named components')
doc.recompute()
out=ROOT/'inspection_terminal.FCStd'
doc.saveAs(str(out))
report={'freecad_version':'.'.join(App.Version()[:3]),'path':str(out),'is_valid':assembly.isValid(),
        'solids':len(assembly.Solids),'volume_mm3':assembly.Volume,
        'checked_at_utc':datetime.now(timezone.utc).isoformat(),
        'step_sha256':hashlib.sha256((ROOT/'models/inspection_terminal.step').read_bytes()).hexdigest(),
        'source_sha256':manifest['source_sha256'],'named_components':component_reports,
        'native_note':'Individually named STEP solid features, not native parametric history; editable master is Python source.'}
(ROOT/'evidence/freecad_import.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
App.closeDocument(doc.Name)
reopened=App.openDocument(str(out)); report['reopen_valid']=all(p.Shape.isValid() for p in reopened.getObject('NamedComponents').Group)
report['reopen_component_count']=len(reopened.getObject('NamedComponents').Group)
report['reopen_all_components_valid']=all(p.Shape.isValid() for p in reopened.getObject('NamedComponents').Group)
report['fcstd_sha256']=hashlib.sha256(out.read_bytes()).hexdigest()
(ROOT/'evidence/freecad_import.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
App.closeDocument(reopened.Name)
print(json.dumps(report))
