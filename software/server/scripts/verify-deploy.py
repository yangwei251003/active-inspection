"""用上游 Compose JSON Schema 检查结构，不把它称作 Docker 运行验证。"""
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone
import jsonschema
import yaml

root = Path(__file__).resolve().parents[1]
schema_file = root / 'tooling/media/compose-spec.json'
provenance = json.loads((root / 'artifacts/compose-schema-provenance.json').read_text(encoding='utf-8-sig'))
assert hashlib.sha256(schema_file.read_bytes()).hexdigest() == provenance['sha256']
schema = json.loads(schema_file.read_text(encoding='utf-8-sig'))
compose = yaml.safe_load((root / 'deploy/compose.yaml').read_text(encoding='utf-8'))
jsonschema.validate(compose, schema)
assert 'ports' not in compose['services']['server'], 'application control port must remain internal'
assert compose['services']['server']['secrets'] == ['inspection_config']
assert all('8889' not in mapping for mapping in compose['services']['mediamtx']['ports']), 'media signalling must remain internal'
assert compose['services']['server']['read_only'] is True
media = yaml.safe_load((root / 'deploy/mediamtx.yml').read_text(encoding='utf-8'))
assert media['authMethod'] == 'http' and media['authHTTPExclude'] == []
assert all(media[feature] is False for feature in ['api', 'metrics', 'pprof', 'rtsp', 'rtmp', 'hls', 'srt', 'playback'])
assert list(media['paths']) == ['inspection']
result = {'passed': True, 'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'compose_schema': provenance, 'network_and_auth_invariants_checked': True, 'docker_compose_executed': False, 'container_build_executed': False, 'public_deployment_executed': False}
(root / 'artifacts/deploy-validation.json').write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps(result, indent=2))
