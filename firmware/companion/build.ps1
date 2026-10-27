param([ValidateSet('build','reconfigure','size')][string]$Action='build')
$ErrorActionPreference='Stop'
if (-not (Get-Command idf.py -ErrorAction SilentlyContinue)) { throw 'Activate the pinned ESP-IDF 6.0.2 environment first; see REPRODUCE.md.' }
if (-not $env:IDF_PATH) { throw 'IDF_PATH is missing.' }
$env:ESP_IDF_VERSION='6.0'
$env:PYTHONUTF8='1'
$project=[IO.Path]::GetFullPath($PSScriptRoot)
if (-not (Test-Path -LiteralPath (Join-Path $project 'vendor\esp-webrtc-solution\components'))) { throw 'Run bootstrap_dependencies.py first.' }
& idf.py -C $project -B (Join-Path $project 'build') -DIDF_TARGET=esp32p4 $Action
exit $LASTEXITCODE
