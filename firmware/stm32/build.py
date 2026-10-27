"""可重建离线验证入口：python build.py --all；不连接任何烧录器。"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent
CUBE = Path("third_party/STM32CubeF4/Drivers")
HAL = CUBE / "STM32F4xx_HAL_Driver"
DEVICE = CUBE / "CMSIS/Device/ST/STM32F4xx"
CORE = CUBE / "CMSIS/Include"
LOG: list[dict] = []

def run(args: list[str]) -> str:
    p = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE,
                       stderr=subprocess.STDOUT, encoding="utf-8", errors="replace")
    LOG.append({"args": args, "exit_code": p.returncode, "output": p.stdout})
    if p.stdout.strip(): print(p.stdout.strip(), flush=True)
    if p.returncode: raise RuntimeError(f"Command failed: {args[0]}")
    return p.stdout

def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def source_hashes() -> dict:
    paths = [p for folder in ("include", "src", "target", "tests")
             for p in (ROOT/folder).rglob("*") if p.is_file()]
    paths += [ROOT/"build.py", ROOT/"dependency-lock.json", ROOT/"dependency-files.sha256.json"]
    return {p.relative_to(ROOT).as_posix(): digest(p) for p in sorted(paths)}

def host() -> dict:
    compiler = os.environ.get("HOST_CC") or shutil.which("gcc")
    if not compiler: raise RuntimeError("未发现主机 C 编译器，请配置 HOST_CC")
    out = ROOT / "build/host"; out.mkdir(parents=True, exist_ok=True)
    version = run([compiler, "--version"]).splitlines()[0]
    exe = "build/host/test_control.exe" if os.name == "nt" else "build/host/test_control"
    run([compiler, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-pedantic",
         "-Iinclude", "src/inspection.c", "src/protocol.c", "tests/test_control.c", "-o", exe])
    result = run([str(ROOT/exe)])
    return {"status": "passed", "compiler": version, "tests_output": result,
            "binary_sha256": digest(ROOT/exe), "scope": "portable host logic only"}

def arm() -> dict:
    manifest = json.loads((ROOT/"dependency-files.sha256.json").read_text())
    for relative, expected in manifest.items():
        if digest(ROOT/relative) != expected:
            raise RuntimeError("官方依赖哈希不一致: "+relative)
    compiler = os.environ.get("ARM_CC") or shutil.which("arm-none-eabi-gcc")
    if not compiler: raise RuntimeError("未发现 ARM 编译器，请配置 ARM_CC")
    prefix = str(Path(compiler).parent)
    suffix = ".exe" if os.name == "nt" else ""
    objcopy = str(Path(prefix)/("arm-none-eabi-objcopy"+suffix))
    size_tool = str(Path(prefix)/("arm-none-eabi-size"+suffix))
    out = ROOT/"build/nucleo_f401re"; out.mkdir(parents=True, exist_ok=True)
    version = run([compiler, "--version"]).splitlines()[0]
    modules = ["hal", "hal_cortex", "hal_gpio", "hal_rcc", "hal_rcc_ex", "hal_flash",
               "hal_flash_ex", "hal_pwr", "hal_dma", "hal_uart", "hal_tim", "hal_tim_ex", "hal_iwdg"]
    sources = [Path("src/inspection.c"), Path("src/protocol.c"), Path("target/main.c")]
    sources += [HAL/"Src"/("stm32f4xx_"+x+".c") for x in modules]
    sources += [DEVICE/"Source/Templates/system_stm32f4xx.c",
                DEVICE/"Source/Templates/gcc/startup_stm32f401xe.s"]
    includes = ["include", "target", str(HAL/"Inc"), str(DEVICE/"Include"), str(CORE)]
    cpu = ["-mcpu=cortex-m4", "-mthumb", "-mfpu=fpv4-sp-d16", "-mfloat-abi=hard"]
    common = cpu+["-Os", "-g3", "-ffunction-sections", "-fdata-sections", "-fstack-usage",
                  "-DSTM32F401xE", "-DUSE_HAL_DRIVER", "-DINS_ENABLE_SERVO_OUTPUT=0"]
    for inc in includes: common += ["-I"+inc.replace("\\", "/")]
    objects = []
    for src in sources:
        obj = "build/nucleo_f401re/"+src.stem+".o"
        own_source = src.parts[0] in ("src", "target")
        warnings = ["-Wall", "-Wextra", "-Werror"] if own_source else []
        cflags = ["-std=c11"] if src.suffix == ".c" else ["-x", "assembler-with-cpp"]
        run([compiler]+common+warnings+cflags+["-c", src.as_posix(), "-o", obj]); objects.append(obj)
    elf = "build/nucleo_f401re/active_inspection.elf"
    mapfile = "build/nucleo_f401re/active_inspection.map"
    run([compiler]+cpu+objects+["-nostartfiles", "--specs=nano.specs", "--specs=nosys.specs",
        "-Ttarget/stm32f401re.ld", "-Wl,--gc-sections", "-Wl,-Map="+mapfile,
        "-Wl,--print-memory-usage", "-o", elf])
    run([objcopy, "-O", "binary", elf, "build/nucleo_f401re/active_inspection.bin"])
    size = run([size_tool, "-A", elf])
    sections = {}
    for line in size.splitlines():
        fields = line.split()
        if len(fields) == 3 and fields[0].startswith(".") and fields[1].isdigit():
            sections[fields[0]] = int(fields[1])
    hashes = {p.name: digest(p) for p in out.iterdir() if p.suffix in (".elf", ".bin", ".map")}
    return {"status": "passed", "compiler": version, "target": "STM32F401RET6 / NUCLEO-F401RE offline reference",
            "servo_output_enabled": False, "hardware_connected": False, "sections_bytes": sections,
            "verified_dependency_source_files": len(manifest),
            "hashes_sha256": hashes, "scope": "compile/link only; no flash, no hardware function claim"}

def main() -> None:
    ap = argparse.ArgumentParser(); ap.add_argument("--all", action="store_true")
    ap.add_argument("--host", action="store_true"); ap.add_argument("--arm", action="store_true"); args = ap.parse_args()
    report = {"created_at": dt.datetime.now(dt.timezone.utc).isoformat(), "hardware_tested": False,
              "source_sha256": source_hashes(), "dependency_lock": json.loads((ROOT/"dependency-lock.json").read_text())}
    (ROOT/"build").mkdir(exist_ok=True)
    try:
        if args.host or args.all or not args.arm: report["host"] = host()
        if args.arm or args.all: report["arm"] = arm()
        report["status"] = "passed"
    except Exception as exc:
        report["status"] = "failed"; report["error"] = str(exc); raise
    finally:
        report["commands"] = LOG
        (ROOT/"build/verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

if __name__ == "__main__": main()
