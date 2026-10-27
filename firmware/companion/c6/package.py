"""Package already-built C6 images and validate their offline target contract.

This tool never opens a serial port, connects to a board, or flashes firmware.
Run with the pinned ESP-IDF Python environment after build.ps1 build succeeds.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parent
COMPANION = ROOT.parent
BUILD = ROOT / "build"
OUTPUT = ROOT / "artifacts"
EVIDENCE = ROOT / "evidence"
VENDOR = ROOT / "vendor" / "esp-hosted-mcu"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def record(path: Path) -> dict:
    return {"path": path.relative_to(ROOT).as_posix(),
            "bytes": path.stat().st_size, "sha256": digest(path)}


def execute(args: list[str], log_name: str) -> str:
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", env=env)
    output = result.stdout + result.stderr
    (EVIDENCE / log_name).write_text(output, encoding="utf-8")
    if result.returncode:
        raise RuntimeError(f"Offline packaging command failed: {log_name}\n{output}")
    return output


def main() -> None:
    OUTPUT.mkdir(exist_ok=True)
    EVIDENCE.mkdir(exist_ok=True)
    project = json.loads((BUILD / "project_description.json").read_text())
    if project["project_version"] != "2.12.13" or project["target"] != "esp32c6":
        raise ValueError("Build description does not identify ESP-Hosted 2.12.13 on C6")
    config = json.loads((BUILD / "config" / "sdkconfig.json").read_text())
    expected = {
        "IDF_TARGET": "esp32c6", "ESPTOOLPY_FLASHSIZE": "4MB",
        "ESPTOOLPY_FLASHMODE": "dio", "ESPTOOLPY_FLASHFREQ": "80m",
        "ESP_SDIO_HOST_INTERFACE": True, "ESP_SDIO_GPIO_RESET": -1,
        "ESP_SDIO_PIN_CLK": 19, "ESP_SDIO_PIN_CMD": 18,
        "ESP_SDIO_PIN_D0": 20, "ESP_SDIO_PIN_D1": 21,
        "ESP_SDIO_PIN_D2": 22, "ESP_SDIO_PIN_D3": 23,
        "ESP_HOSTED_CP_WIFI": True, "ESP_HOSTED_CP_BT": True,
        "ESP_WIFI_ENABLED": True, "BT_ENABLED": True,
        "BT_CONTROLLER_ONLY": True, "BT_CONTROLLER_ENABLED": True,
        "BT_NIMBLE_ENABLED": False, "BT_BLUEDROID_ENABLED": False,
        "ESP_SDIO_HIGH_SPEED": True,
        "BT_LE_HCI_INTERFACE_USE_RAM": True,
        "ESP_COEX_SW_COEXIST_ENABLE": True,
        "ESP_HOSTED_COPROCESSOR_APP_MAIN": True,
        "ESP_HOSTED_NETWORK_SPLIT_ENABLED": False,
        "ESP_HOSTED_CLI_ENABLED": False,
    }
    for key, value in expected.items():
        if config.get(key) != value:
            raise ValueError(f"C6 target contract mismatch: {key}: {config.get(key)!r} != {value!r}")

    elf = BUILD / "network_adapter.elf"
    header = elf.read_bytes()[:52]
    if header[:7] != b"\x7fELF\x01\x01\x01" or struct.unpack_from("<H", header, 18)[0] != 243:
        raise ValueError("Expected a little-endian ELF32 RISC-V executable")
    entry = struct.unpack_from("<I", header, 24)[0]
    size_data = json.loads(execute([sys.executable, "-m", "esp_idf_size", "--format", "json2",
                                   str(BUILD / "network_adapter.map")], "memory-usage.json"))
    nm = COMPANION / "tooling" / "idf-tools" / "tools" / "riscv32-esp-elf" / "esp-15.2.0_20251204" / "riscv32-esp-elf" / "bin" / "riscv32-esp-elf-nm.exe"
    symbols = execute([str(nm), str(elf)], "linked-symbols.log")
    linked = {line.split()[-1] for line in symbols.splitlines() if len(line.split()) >= 3}
    required_symbols = ["esp_hosted_coprocessor_init", "sdio_slave_initialize",
                        "esp_vhci_host_register_callback", "esp_wifi_init"]
    for symbol in required_symbols:
        if symbol not in linked:
            raise ValueError(f"Required wireless/transport function missing from ELF: {symbol}")
    flash = json.loads((BUILD / "flasher_args.json").read_text())
    if flash["extra_esptool_args"]["chip"] != "esp32c6":
        raise ValueError("Flasher metadata has the wrong chip")
    segments = []
    for address, source in flash["flash_files"].items():
        path = BUILD / source
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Missing or empty built image: {path}")
        target = OUTPUT / path.name
        shutil.copy2(path, target)
        start = int(address, 0)
        end = start + target.stat().st_size
        if end > 4 * 1024 * 1024:
            raise ValueError("Flash image exceeds N4 document-backed capacity")
        segments.append({"offset": hex(start), "end_exclusive": hex(end), **record(target)})
    segments.sort(key=lambda item: int(item["offset"], 0))
    for left, right in zip(segments, segments[1:]):
        if int(left["end_exclusive"], 0) > int(right["offset"], 0):
            raise ValueError("Flash segments overlap")

    partition_bytes = (BUILD / "partition_table" / "partition-table.bin").read_bytes()
    partitions = []
    for offset in range(0, len(partition_bytes), 32):
        magic, kind, subtype, start, size, label, flags = struct.unpack_from("<HBBII16sI", partition_bytes, offset)
        if magic != 0x50AA:
            break
        name = label.rstrip(b"\0").decode("ascii")
        if start + size > 4 * 1024 * 1024:
            raise ValueError(f"Partition {name} exceeds flash capacity")
        partitions.append({"name": name, "type": kind, "subtype": subtype,
                           "offset": hex(start), "bytes": size, "flags": flags})
    ota = next(item for item in partitions if item["name"] == "ota_0")
    app_size = (BUILD / "network_adapter.bin").stat().st_size
    if app_size > ota["bytes"]:
        raise ValueError("Application image does not fit ota_0")

    for source, name in [(elf, "network_adapter.elf"),
                         (BUILD / "network_adapter.map", "network_adapter.map"),
                         (ROOT / "sdkconfig", "sdkconfig"),
                         (VENDOR / "slave" / "dependencies.lock", "dependencies.lock"),
                         (VENDOR / "slave" / "partitions.esp32c6.csv", "partitions.csv")]:
        shutil.copy2(source, OUTPUT / name)

    args = [sys.executable, "-m", "esptool", "--chip", "esp32c6", "merge-bin",
            "-o", str(OUTPUT / "esp32c6-esp-hosted-2.12.13-merged.bin")]
    for setting in ("flash_mode", "flash_freq", "flash_size"):
        args += ["--" + setting.replace("_", "-"), flash["flash_settings"][setting]]
    for segment in segments:
        args += [segment["offset"], str(ROOT / segment["path"])]
    execute(args, "merge-image.log")
    for image_name, log_name in (("network_adapter.bin", "app-image-info.log"),
                                 ("bootloader.bin", "bootloader-image-info.log")):
        image_info = execute([sys.executable, "-m", "esptool", "--chip", "esp32c6", "image-info",
                              str(OUTPUT / image_name)], log_name)
        if not re.search(r"Checksum: .+ \(valid\)", image_info) or not re.search(r"Validation hash: .+ \(valid\)", image_info):
            raise ValueError(f"Image checksum or appended validation hash is invalid: {image_name}")
        if image_name == "network_adapter.bin" and f"ELF file SHA256: {digest(elf)}" not in image_info:
            raise ValueError("Application image does not refer to the packaged ELF hash")

    sources = []
    upstream = COMPANION / "managed_components" / "espressif__esp_hosted"
    for path in sorted(VENDOR.rglob("*")):
        if not path.is_file() or "managed_components" in path.parts or path.name == "dependencies.lock":
            continue
        original = upstream / path.relative_to(VENDOR)
        if original.is_file():
            if digest(path) != digest(original):
                raise ValueError(f"Vendored upstream file changed: {path}")
            sources.append(record(path))
    source_manifest = {
        "component": "espressif/esp_hosted", "version": "2.12.13",
        "commit": "dd0176e5fc959d79b306f6677a2f878123c58e9a",
        "origin": "https://github.com/espressif/esp-hosted-mcu",
        "scope": "Complete slave/ and common/ source trees plus license and upstream metadata",
        "comparison": "Every recorded file SHA-256 matches the installed official component source",
        "files": sources,
    }
    (EVIDENCE / "upstream-source-manifest.json").write_text(
        json.dumps(source_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    plan = {"kind": "offline_flash_layout_only", "chip": "esp32c6", "capacity": 4194304,
            "settings": flash["flash_settings"], "segments": segments,
            "physical_target_verified": False, "flash_executed": False,
            "requires": ["Verify delivered PCB revision and ESP32-C6-MINI-1-N4 marking",
                         "Verify C6 UART/BOOT/reset access and isolated power before any wiring",
                         "Identify exact physical target and obtain one-time flash confirmation"]}
    (OUTPUT / "flash-layout.json").write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    artifacts = [record(path) for path in sorted(OUTPUT.iterdir()) if path.is_file()]
    report = {
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "result": "offline_build_and_artifact_validation_passed",
        "evidence_level": "V2_compile_link_and_V3_resource_analysis",
        "board_profile": "Waveshare ESP32-P4-NANO / ESP32-C6-MINI-1-N4 (document-backed, not physically verified)",
        "hosted_version": "2.12.13", "idf_version": "6.0.2",
        "idf_commit": "7101770dc6db2667b3c477cc31365dd1acd6db4e",
        "idf_reported_revision": project["git_revision"],
        "idf_source_note": "Pinned SDK plus a documented Windows subst path adapter in tools/cmake/build.cmake; git reports dirty",
        "idf_path_adapter_sha256": digest(COMPANION / "tooling" / "esp-idf" / "tools" / "cmake" / "build.cmake"),
        "idf_submodule_evidence": {"path": "../evidence/idf-submodule-sources.json",
                                   "sha256": digest(COMPANION / "evidence" / "idf-submodule-sources.json")},
        "compiler": "riscv32-esp-elf-gcc esp-15.2.0_20251204 / GCC 15.2.0",
        "cmake": "4.3.1", "target": "esp32c6", "elf_entry_point": hex(entry),
        "configuration_checks": expected, "partitions": partitions,
        "required_linked_symbols": required_symbols,
        "memory_usage": size_data,
        "application_bytes": app_size, "application_partition_bytes": ota["bytes"],
        "application_partition_free_bytes": ota["bytes"] - app_size,
        "source_manifest": record(EVIDENCE / "upstream-source-manifest.json"),
        "board_document_sources": [
            {"url": "https://files.waveshare.com/wiki/ESP32-P4-NANO/ESP32-P4-NANO-schematic.pdf",
             **record(EVIDENCE / "ESP32-P4-NANO-schematic.pdf")},
            {"url": "https://documentation.espressif.com/esp32-c6-mini-1_mini-1u_datasheet_en.html",
             **record(EVIDENCE / "esp32-c6-mini-1-datasheet.html")},
            {"url": "https://docs.waveshare.com/ESP32-P4-NANO/FAQ/",
             **record(EVIDENCE / "waveshare-faq.html")},
        ],
        "verification_logs": [record(EVIDENCE / name) for name in
                              ("idf-reconfigure.log", "idf-build.log", "idf-size.log",
                               "memory-usage.json", "linked-symbols.log", "merge-image.log",
                               "app-image-info.log", "bootloader-image-info.log")],
        "artifacts": artifacts,
        "not_verified": ["Physical flash identity/capacity/PCB revision", "Boot on physical C6",
                         "SDIO exchange with P4", "Wi-Fi connection and throughput", "BLE/GATT and Wi-Fi coexistence",
                         "Device power, heat, antenna placement, and recovery procedure"],
        "hardware_actions": [],
    }
    (EVIDENCE / "build-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (EVIDENCE / "artifact-sha256.txt").write_text(
        "".join(f"{item['sha256']}  {item['path']}\n" for item in artifacts), encoding="utf-8")
    print(json.dumps({"result": report["result"], "application_bytes": app_size,
                      "partition_free_bytes": ota["bytes"] - app_size,
                      "artifact_count": len(artifacts), "source_files_verified": len(sources)}, indent=2))


if __name__ == "__main__":
    main()
