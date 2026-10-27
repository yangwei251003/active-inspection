"""检查实际二进制 STL 的闭合边、连通性、绕序、体积和打印底面。无需切片软件。

这不是支撑/强度/打印公差验证。顶点仅以 0.00001 mm 网格归并浮点表示。
"""
import hashlib,json,struct
from collections import Counter
from datetime import datetime,timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parent
TARGETS=['base_shell','lid','electronics_tray','gantry_adapter','camera_shell',
         'camera_back','pcb_foot','cable_anchor','fit_coupon']

def check(path):
    data=path.read_bytes()
    n=struct.unpack_from('<I',data,80)[0]
    if len(data)!=84+50*n: raise ValueError('Not the expected binary STL format: '+str(path))
    edge_count=Counter(); winding=Counter(); parents={}; signed_volume=0.; degenerate=0
    minimum=[float('inf')]*3;maximum=[float('-inf')]*3
    def find(x):
        parents.setdefault(x,x)
        while parents[x]!=x:
            parents[x]=parents[parents[x]]; x=parents[x]
        return x
    for i in range(n):
        values=struct.unpack_from('<12fH',data,84+50*i)
        pts=[values[3:6],values[6:9],values[9:12]]
        a,b,c=pts
        signed_volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6.
        keys=[tuple(round(v*100000) for v in p) for p in pts]
        ab=[b[j]-a[j] for j in range(3)];ac=[c[j]-a[j] for j in range(3)]
        cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]]
        if len(set(keys))<3 or sum(v*v for v in cross)<1e-16: degenerate+=1
        for p in pts:
            for j,v in enumerate(p): minimum[j]=min(minimum[j],v); maximum[j]=max(maximum[j],v)
        for u,v in zip(keys,keys[1:]+keys[:1]):
            edge=tuple(sorted((u,v)));edge_count[edge]+=1;winding[edge]+=1 if u<v else -1
            ru,rv=find(u),find(v)
            if ru!=rv: parents[ru]=rv
    bad_edges=sum(count!=2 for count in edge_count.values())
    bad_winding=sum(value!=0 for value in winding.values())
    components=len({find(x) for x in parents})
    valid=n>0 and bad_edges==0 and bad_winding==0 and components==1 and degenerate==0 and signed_volume>0 and abs(minimum[2])<1e-5
    return {'valid':valid,'triangles':n,'boundary_or_nonmanifold_edges':bad_edges,
            'inconsistent_winding_edges':bad_winding,'connected_components':components,
            'degenerate_triangles':degenerate,'signed_volume_mm3':signed_volume,
            'bbox_min_mm':minimum,'bbox_max_mm':maximum,
            'sha256':hashlib.sha256(data).hexdigest()}

def main():
    results={name:check(ROOT/'stl'/f'{name}.stl') for name in TARGETS}
    report={'passed':all(r['valid'] for r in results.values()),
            'checked_at_utc':datetime.now(timezone.utc).isoformat(),
            'quantization_mm':0.00001,'targets':results,
            'scope':'mesh topology, orientation, connectivity and grounding; not slicer or actual print validation'}
    (ROOT/'evidence').mkdir(exist_ok=True)
    (ROOT/'evidence/stl_validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    if not report['passed']: raise SystemExit(1)

if __name__=='__main__':main()
