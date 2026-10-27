"""检查交付 CAD 的实际实体/尺寸与配合；结果为几何证据，不是试装证据。"""
import json, sys, hashlib
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'models'))
from inspection_geometry import P, PARTS, base, lid, tray, assembled, printable, camera_shell, box
from build123d import Pos, import_step

def main():
    installed_counts={k:1 for k in PARTS}; installed_counts['pcb_foot']=8
    spare_counts={k:0 for k in PARTS}; spare_counts['cable_anchor']=1
    # 主装配仅安装一个线束锚点；打印第二个作为备用，不计入装配实体。
    counts={k:installed_counts[k]+spare_counts[k] for k in PARTS}
    parts={}; failures=[]
    for name,count in counts.items():
        path=ROOT/'models'/f'{name}.step'
        s=import_step(str(path)); bb=s.bounding_box()
        solids=s.solids()
        ok=len(solids)==1 and all(x.is_valid and x.volume>0 for x in solids)
        if not ok: failures.append(name+' invalid')
        generated=printable(name)
        # 同时比较当前参数化源与已交付 STEP，避免只检验旧的导出文件。
        source_bb=generated.bounding_box()
        bbox_error=max(abs(a-b) for a,b in zip(
            (bb.min.X,bb.min.Y,bb.min.Z,bb.max.X,bb.max.Y,bb.max.Z),
            (source_bb.min.X,source_bb.min.Y,source_bb.min.Z,source_bb.max.X,source_bb.max.Y,source_bb.max.Z)))
        volume_error=abs(s.volume-generated.volume)
        source_match=bbox_error<1e-5 and volume_error<1e-3
        if not source_match: failures.append(name+' source/export mismatch')
        parts[name]={'quantity':count,'installed_quantity':installed_counts[name],
                     'spare_quantity':spare_counts[name],'valid':ok,'solids':len(solids),
                     'bbox_mm':[round(v,3) for v in (bb.size.X,bb.size.Y,bb.size.Z)],
                     'volume_mm3':round(s.volume,2),'mass_solid_petg_g':round(s.volume*1.27/1000,2),
                     'source_export_metrics_match':source_match,'bbox_max_error_mm':bbox_error,
                     'volume_error_mm3':volume_error,
                     'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    # 直接测试装配源的实际实体，接触/不交叠是不同的检查。
    b=base(); l=Pos(0,0,P['base_h'])*lid(); t=Pos(0,0,P['tray_z'])*tray()
    overlaps={}
    for name,a,c in [('base_lid',b,l),('base_tray',b,t),('tray_lid',t,l)]:
        common=a.intersect(c)
        volume=sum(x.volume for x in common.solids()) if common else 0.
        overlaps[name]=round(volume,6)
        if volume>1e-3: failures.append(name+' intersects')
    # 以最大 32 mm 板投影外加每边 0.4 mm 的矩形检查螺柱避空。
    # 此区域只证明 XY 投影空间，实际相机厚度、镜头高度和 FFC 锁扣仍待锁定 SKU。
    camera_region=box(32.8,32.8,17.6,z=3.4)
    common=camera_shell().intersect(camera_region)
    camera_volume=sum(x.volume for x in common.solids()) if common else 0.
    overlaps['camera_32mm_board_with_0_4mm_xy_margin']=round(camera_volume,6)
    if camera_volume>1e-3: failures.append('camera screw pillars intrude into 32mm camera board clearance region')
    board_top=max(22.8+24,22.8+25)
    metrics={
      'base_footprint_mm':[P['width'],P['depth']],
      'closed_base_height_mm':P['base_h']+P['lid_t'],
      'lid_locating_rim_clearance_each_side_mm':P['clearance'],
      'maximum_reference_board_top_z_mm':board_top,
      'reference_board_to_lid_plane_mm':P['base_h']-board_top,
      'reference_board_to_board_x_gap_mm':(35-56/2)-(-36+70/2),
      'base_lid_screw_xy_delta_mm':0.0,
      'tray_seat_z_delta_mm':0.0,
      'camera_back_to_reference_bracket_front_y_gap_mm':2-(P['head_y']+22+2.4),
    }
    total=sum(parts[k]['volume_mm3']*v for k,v in counts.items())
    installed_volume=sum(parts[k]['volume_mm3']*v for k,v in installed_counts.items())
    spare_volume=sum(parts[k]['volume_mm3']*v for k,v in spare_counts.items())
    # 实际填充由切片决定；给实心上界和显式经验区间，不能宣称实际重量。
    solid_g=total*1.27/1000
    assembly=assembled()
    assembly_parts=[]
    for child in assembly.children:
        bb=child.bounding_box()
        assembly_parts.append({'label':child.label,'volume_mm3':child.volume,
            'bbox_mm':[bb.min.X,bb.min.Y,bb.min.Z,bb.max.X,bb.max.Y,bb.max.Z]})
    report={'status':'passed' if not failures else 'failed','units':'mm',
            'checked_at_utc':datetime.now(timezone.utc).isoformat(),
            'source':'imported delivered STEP plus source-level placement intersection',
            'source_sha256':hashlib.sha256((ROOT/'models/inspection_geometry.py').read_bytes()).hexdigest(),
            'assembly_step_sha256':hashlib.sha256((ROOT/'models/inspection_terminal.step').read_bytes()).hexdigest(),
            'assembly_parts':assembly_parts,
            'bom_counts':{'installed_printed_parts':sum(installed_counts.values()),
                'purchased_reference_envelopes':sum(c['label'].startswith('REFERENCE_') for c in assembly_parts),
                'main_assembly_solids':len(assembly_parts),'spare_printed_parts':sum(spare_counts.values()),
                'quoted_printed_parts_including_spares':sum(counts.values()),
                'optional_fit_coupon_not_in_assembly_or_quote_count':1},
            'parts':parts,'overlap_volume_mm3':overlaps,'design_metrics':metrics,
            'failures':failures,'material_estimate':{'petg_density_g_cm3':1.27,
            'scope':'15 installed printed parts plus 1 spare cable anchor; excludes optional fit coupon and purchased envelopes',
            'installed_volume_mm3':round(installed_volume,2),
            'installed_solid_petg_g':round(installed_volume*1.27/1000,1),
            'spare_volume_mm3':round(spare_volume,2),
            'spare_solid_petg_g':round(spare_volume*1.27/1000,2),
            'quoted_volume_including_spare_mm3':round(total,2),
            'solid_geometry_mass_g':round(solid_g,1),'sliced_mass_estimate_g':[round(solid_g*.6),round(solid_g*.9)],
            'not_verified':'No slicer, support mass, commercial quote or actual print. Above is an assumption range.'},
            'unverified':['actual board revision/connectors','purchased pan tilt exact fit','camera lens centering and FOV',
                          'FFC motion fatigue','dynamic swept clearances','thermal performance','fastener torque','print fit']}
    (ROOT/'evidence').mkdir(exist_ok=True)
    (ROOT/'evidence/design_validation.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(report,indent=2,ensure_ascii=False))
    if failures: raise SystemExit(1)

if __name__=='__main__':main()
