$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'evidence'
New-Item -ItemType Directory -Force -Path $out | Out-Null
& gcc -std=c11 -Wall -Wextra -Werror -O2 "-I$root/components/inspection_core/include" "$root/components/inspection_core/inspection_core.c" "$PSScriptRoot/test_core.c" -lm -o "$out/test_core.exe"
if ($LASTEXITCODE -ne 0) { throw 'Host compile failed' }
& "$out/test_core.exe" | Tee-Object -FilePath "$out/host-core.log"
if ($LASTEXITCODE -ne 0) { throw 'Host test failed' }
$json=Join-Path $root 'managed_components/espressif__cjson/cJSON'
& gcc -std=c11 -Wall -Wextra -Werror -Wno-misleading-indentation -O2 "-I$PSScriptRoot/fakes" "-I$root/components/inspection_core/include" "-I$json" "$root/components/inspection_core/inspection_core.c" "$json/cJSON.c" "$PSScriptRoot/test_bridge.c" -lm -o "$out/test_bridge.exe"
if ($LASTEXITCODE -ne 0) { throw 'Production bridge host compile failed' }
& "$out/test_bridge.exe" | Tee-Object -FilePath "$out/host-bridge.log"
if ($LASTEXITCODE -ne 0) { throw 'Production bridge host test failed' }
& gcc -std=c11 -Wall -Wextra -Werror -O2 "-I$root/components/inspection_core/include" "-I$json" "$root/components/inspection_core/inspection_core.c" "$json/cJSON.c" "$PSScriptRoot/test_lifecycle.c" -lm -o "$out/test_lifecycle.exe"
if ($LASTEXITCODE -ne 0) { throw 'Capture lifecycle host compile failed' }
& "$out/test_lifecycle.exe" | Tee-Object -FilePath "$out/host-lifecycle.log"
if ($LASTEXITCODE -ne 0) { throw 'Capture lifecycle host test failed' }
