"""Validate and package the built P4 image; this never opens a hardware port."""
from __future__ import annotations
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
BUILD, OUTPUT, EVIDENCE = (ROOT / name for name in ('build', 'artifacts', 'evidence'))

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def record(path):
    return {'path': path.relative_to(ROOT).as_posix(), 'bytes': path.stat().st_size, 'sha256': digest(path)}

def execute(args, log):
    result = subprocess.run(args, capture_output=True, text=True, encoding='utf-8',
                            env=dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8'))
    output = result.stdout + result.stderr
    (EVIDENCE / log).write_text(result.stdout if log.endswith('.json') else output, encoding='utf-8')
    if result.stderr or log.endswith('.json'):
        (EVIDENCE / (log + '.stderr.log')).write_text(result.stderr, encoding='utf-8')
    if result.returncode:
        raise RuntimeError(f'{log} failed: {output}')
    return result.stdout

def main():
    OUTPUT.mkdir(exist_ok=True)
    config = json.loads((BUILD / 'config/sdkconfig.json').read_text())
    expected = {
        'IDF_TARGET': 'esp32p4', 'ESP32P4_REV_MIN_FULL': 300,
        'ESPTOOLPY_FLASHSIZE': '16MB', 'ESPTOOLPY_FLASHMODE_QIO': True,
        'SPIRAM': True, 'SPIRAM_SPEED': 200,
        'AI_UART_ENABLE': False, 'AI_UART_TX': 20, 'AI_UART_RX': 21,
        'AI_WS_URL': '', 'AI_WHIP_URL': '', 'AI_DEVICE_TOKEN': '',
        'AI_MEDIA_ENABLE': True, 'AI_BLE_ENABLE': True,
        'CAMERA_OV5647': True, 'CAMERA_OV5647_MIPI_DEFAULT_FMT_RAW10_1920X1080_30FPS': True,
        'SLAVE_IDF_TARGET_ESP32C6': True, 'ESP_HOSTED_CP_TARGET_ESP32C6': True,
        'ESP_HOSTED_SDIO_HOST_INTERFACE': True, 'ESP_HOSTED_SDIO_BUS_WIDTH': 4,
        'ESP_HOSTED_SDIO_PIN_CLK': 18, 'ESP_HOSTED_SDIO_PIN_CMD': 19,
        'ESP_HOSTED_SDIO_PIN_D0': 14, 'ESP_HOSTED_SDIO_PIN_D1': 15,
        'ESP_HOSTED_SDIO_PIN_D2': 16, 'ESP_HOSTED_SDIO_PIN_D3': 17,
        'ESP_HOSTED_SDIO_GPIO_RESET_SLAVE': 54,
        'BT_NIMBLE_ENABLED': True, 'BT_CONTROLLER_DISABLED': True,
        'ESP_HOSTED_ENABLE_BT_NIMBLE': True, 'ESP_HOSTED_NIMBLE_HCI_VHCI': True,
    }
    for key, value in expected.items():
        if config.get(key) != value:
            raise ValueError(f'Configuration mismatch {key}: {config.get(key)!r} != {value!r}')
    receipt = json.loads((EVIDENCE / 'clean-build-receipt.json').read_text(encoding='utf-8-sig'))
    if receipt['exit_code'] != 0:
        raise ValueError('Clean build has not succeeded')
    for name in ('host-core.log', 'host-bridge.log', 'host-lifecycle.log'):
        if not (EVIDENCE / name).read_text(encoding='utf-8-sig').startswith('PASS'):
            raise ValueError(f'Missing successful host regression {name}')
    description = json.loads((BUILD / 'project_description.json').read_text())
    if description['target'] != 'esp32p4' or description['min_rev'] != '300':
        raise ValueError('Project description does not identify the default P4 revision')
    elf = BUILD / 'active_inspection_companion.elf'
    header = elf.read_bytes()[:52]
    if header[:7] != b'\x7fELF\x01\x01\x01' or struct.unpack_from('<H', header, 18)[0] != 243:
        raise ValueError('Not a little-endian ELF32 RISC-V image')
    nm = ROOT / 'tooling/idf-tools/tools/riscv32-esp-elf/esp-15.2.0_20251204/riscv32-esp-elf/bin/riscv32-esp-elf-nm.exe'
    symbol_output = execute([str(nm), str(elf)], 'linked-symbols.log')
    symbols = {line.split()[-1] for line in symbol_output.splitlines() if len(line.split()) >= 3}
    required = ['app_main', 'ai_bridge_command', 'esp_video_init', 'esp_capture_start',
                'esp_webrtc_open', 'esp_signaling_get_whip_impl', 'esp_websocket_client_init',
                'ble_gatts_add_svcs', 'esp_hosted_init']
    missing = [name for name in required if name not in symbols]
    if missing:
        raise ValueError(f'Important production code was omitted from linked ELF: {missing}')
    memory = json.loads(execute([sys.executable, '-m', 'esp_idf_size', '--format', 'json2',
                                str(BUILD / 'active_inspection_companion.map')], 'memory-usage.json'))
    # IDF-size's current P4 YAML describes older SRAM capacity. Keep its warning
    # and report actual linker bounds separately; neither is a runtime heap test.
    map_text = (BUILD / 'active_inspection_companion.map').read_text(encoding='utf-8')
    sram_match = re.search(r'^sram_seg\s+(0x[0-9a-f]+)\s+(0x[0-9a-f]+)', map_text, re.M)
    addresses = {parts[2]: int(parts[0], 16) for line in symbol_output.splitlines()
                 if len(parts := line.split()) == 3 and re.fullmatch('[0-9a-fA-F]+', parts[0])}
    sram = {'origin': sram_match[1], 'length_bytes': int(sram_match[2], 16),
            'static_span_to_heap_start_bytes': addresses['_heap_start'] - int(sram_match[1], 16),
            'runtime_free_heap_measured': False}
    flash = json.loads((BUILD / 'flasher_args.json').read_text())
    if flash['extra_esptool_args']['chip'] != 'esp32p4':
        raise ValueError('Wrong flash target')
    segments = []
    for address, source in flash['flash_files'].items():
        target = OUTPUT / Path(source).name
        shutil.copy2(BUILD / source, target)
        start = int(address, 0)
        end = start + target.stat().st_size
        if not target.stat().st_size or end > 16 * 1024 * 1024:
            raise ValueError('Empty or oversized flash segment')
        segments.append({'offset': hex(start), 'end_exclusive': hex(end), **record(target)})
    segments.sort(key=lambda item: int(item['offset'], 0))
    for left, right in zip(segments, segments[1:]):
        if int(left['end_exclusive'], 0) > int(right['offset'], 0):
            raise ValueError('Flash segments overlap')
    partition_data = (BUILD / 'partition_table/partition-table.bin').read_bytes()
    partitions = []
    for offset in range(0, len(partition_data), 32):
        magic, kind, subtype, start, size, label, flags = struct.unpack_from('<HBBII16sI', partition_data, offset)
        if magic != 0x50AA:
            break
        if start + size > 16 * 1024 * 1024:
            raise ValueError('Partition exceeds physical profile capacity')
        partitions.append({'name': label.rstrip(b'\0').decode('ascii'), 'type': kind,
                           'subtype': subtype, 'offset': hex(start), 'bytes': size})
    factory = next(p for p in partitions if p['name'] == 'factory')
    app_size = (OUTPUT / 'active_inspection_companion.bin').stat().st_size
    if app_size > factory['bytes']:
        raise ValueError('Application does not fit factory partition')
    for source in (elf, BUILD / 'active_inspection_companion.map', ROOT / 'sdkconfig',
                   ROOT / 'dependencies.lock', ROOT / 'partitions.csv'):
        shutil.copy2(source, OUTPUT / source.name)
    args = [sys.executable, '-m', 'esptool', '--chip', 'esp32p4', 'merge-bin',
            '-o', str(OUTPUT / 'esp32p4-active-inspection-merged.bin')]
    for setting in ('flash_mode', 'flash_freq', 'flash_size'):
        args += ['--' + setting.replace('_', '-'), flash['flash_settings'][setting]]
    for segment in segments:
        args += [segment['offset'], str(ROOT / segment['path'])]
    execute(args, 'merge-image.log')
    for name in ('active_inspection_companion', 'bootloader'):
        info = execute([sys.executable, '-m', 'esptool', '--chip', 'esp32p4', 'image-info',
                        str(OUTPUT / (name + '.bin'))], name + '-image-info.log')
        if not re.search(r'Checksum: .+ \(valid\)', info) or not re.search(r'Validation hash: .+ \(valid\)', info):
            raise ValueError(f'Invalid image {name}')
        if name == 'active_inspection_companion' and f'ELF file SHA256: {digest(elf)}' not in info:
            raise ValueError('ELF and application are not the same build')
    plan = {'kind': 'offline_flash_layout_only', 'chip': 'esp32p4', 'minimum_chip_revision': '3.0',
            'settings': flash['flash_settings'], 'segments': segments,
            'uart_motion_enabled': False, 'physical_target_verified': False, 'flash_executed': False}
    (OUTPUT / 'flash-layout.json').write_text(json.dumps(plan, indent=2) + '\n', encoding='utf-8')
    source_paths = [p for folder in ('main', 'components/inspection_core', 'tests') for p in (ROOT / folder).rglob('*')
                    if p.is_file() and p.suffix not in ('.exe', '.pyc')]
    source_paths += [ROOT / p for p in ('CMakeLists.txt', 'sdkconfig.defaults', 'partitions.csv',
                                       'dependencies.lock', 'build.ps1', 'package.py', 'README.md', 'REPRODUCE.md',
                                       'tooling/build.ps1', 'tooling/fetch_idf_sources.py')]
    source_manifest = {'files': [record(p) for p in sorted(source_paths)]}
    (EVIDENCE / 'project-source-manifest.json').write_text(json.dumps(source_manifest, indent=2) + '\n', encoding='utf-8')
    artifacts = [record(p) for p in sorted(OUTPUT.iterdir()) if p.is_file()]
    report = {
        'timestamp_utc': datetime.now(timezone.utc).isoformat(),
        'result': 'clean_compile_link_and_offline_image_validation_passed',
        'target': 'esp32p4', 'board_profile': 'Waveshare ESP32-P4-NANO, P4 rev >=3.0, 16 MB flash',
        'idf_version': '6.0.2', 'idf_commit': '7101770dc6db2667b3c477cc31365dd1acd6db4e',
        'idf_reported_revision': description['git_revision'],
        'idf_path_adapter': record(EVIDENCE / 'idf-windows-path.patch'),
        'idf_submodule_sources': record(EVIDENCE / 'idf-submodule-sources.json'),
        'webrtc_commit': '3971094e2e7c2ab7cb4de59e4eae710e1902d2b4',
        'hosted_version': '2.12.13', 'c6_report': record(ROOT / 'c6/evidence/build-report.json'),
        'compiler': 'GCC 15.2.0 / esp-15.2.0_20251204', 'cmake': '4.3.1',
        'configuration_checks': expected, 'required_linked_symbols': required,
        'elf_entry': hex(struct.unpack_from('<I', header, 24)[0]),
        'partitions': partitions, 'application_bytes': app_size,
        'application_partition_bytes': factory['bytes'], 'partition_free_bytes': factory['bytes'] - app_size,
        'memory_usage': memory, 'linker_sram': sram,
        'memory_analysis_warning': 'esp_idf_size warns that rev3 sram_seg cannot be fully mapped to its older P4 capacity model; use linker bounds, not the size-tool free/total figure, for static layout. Runtime heap and PSRAM peaks remain unmeasured.',
        'clean_build_receipt': receipt,
        'source_manifest': record(EVIDENCE / 'project-source-manifest.json'),
        'verification_logs': [record(EVIDENCE / p) for p in ('host-core.log', 'host-bridge.log', 'host-lifecycle.log',
                              'bootloader-clean.log', 'app-clean.log', 'idf-clean-build.log',
                              'linked-symbols.log', 'memory-usage.json', 'memory-usage.json.stderr.log', 'merge-image.log',
                              'active_inspection_companion-image-info.log', 'bootloader-image-info.log')],
        'artifacts': artifacts, 'hardware_actions': [], 'flash_executed': False,
        'not_verified': ['Physical board revision and power', 'C6/P4 SDIO Wi-Fi and BLE coexistence',
                         'Camera CSI dual sinks and actual video frame rate', 'Real Internet WHIP/WHEP and JPEG upload',
                         'STM32 UART and servo mechanics', 'Memory peaks and long-running stability'],
    }
    (EVIDENCE / 'build-result.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    (EVIDENCE / 'artifact-sha256.txt').write_text(''.join(f"{item['sha256']}  {item['path']}\n" for item in artifacts), encoding='utf-8')
    print(json.dumps({'result': report['result'], 'application_bytes': app_size,
                      'partition_free_bytes': report['partition_free_bytes'], 'artifacts': len(artifacts)}, indent=2))

if __name__ == '__main__':
    main()
