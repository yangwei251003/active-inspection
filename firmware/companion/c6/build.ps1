param([ValidateSet('build','reconfigure','size')][string]$Action='build')
$ErrorActionPreference='Stop'
if (-not (Get-Command idf.py -ErrorAction SilentlyContinue)) { throw 'Activate the pinned ESP-IDF 6.0.2 environment first; see ../REPRODUCE.md.' }
if (-not $env:IDF_PATH) { throw 'IDF_PATH is missing.' }
$env:ESP_IDF_VERSION='6.0'
$project=Join-Path $PSScriptRoot 'vendor\esp-hosted-mcu\slave'
if (-not (Test-Path -LiteralPath (Join-Path $project 'CMakeLists.txt'))) { throw 'Run ../bootstrap_dependencies.py first.' }
$config=Join-Path $PSScriptRoot 'sdkconfig'
$defaults=Join-Path $PSScriptRoot 'sdkconfig.defaults'
& idf.py -C $project -B (Join-Path $PSScriptRoot 'build') -DIDF_TARGET=esp32c6 "-DSDKCONFIG=$config" "-DSDKCONFIG_DEFAULTS=$defaults" $Action
exit $LASTEXITCODE
