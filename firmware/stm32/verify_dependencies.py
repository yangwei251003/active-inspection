"""Read-only local hash verification of the manifest-listed ST source files."""
from pathlib import Path
import json,hashlib
R=Path(__file__).resolve().parent
manifest=json.loads((R/'dependency-files.sha256.json').read_text(encoding='utf8'))
failures=[]
for relative,expected in manifest.items():
 p=R/relative
 if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:failures.append(relative)
print(json.dumps({'ok':not failures,'checked':len(manifest),'failed_paths':failures,'hardware_accessed':False}))
raise SystemExit(1 if failures else 0)
