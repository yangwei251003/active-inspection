# 离线验证记录

执行时间：2026-09-30T02:11:52.432764+00:00

主机逻辑测试：24 组通过（含 20,000 字节确定性噪声输入、1/2 点巡检、type13 及暂停后观察身份失效）。
主机工具：gcc.exe (MinGW.org GCC-6.3.0-1) 6.3.0
ARM 工具：arm-none-eabi-gcc.EXE (GNU Tools for STM32 14.3.rel1.20251027-0700) 14.3.1 20250623

参考目标：STM32F401RET6 / NUCLEO-F401RE。PWM 输出禁用，未连接硬件。

官方源文件校验数量：323

| 产物 | SHA-256 |
|---|---|
| active_inspection.bin | `cc2c51addaf25594cf509a237e4cce71fb2cb13ca63cc7e61f1d0781894a4a7c` |
| active_inspection.elf | `61b81f2b0c8be151f25f5b1a74bd44627d24139da8afdf0c6cb7171970610b4d` |
| active_inspection.map | `95de27d2502a192a23cbb9ba704241212844a6312ad32ce447d5713fb5987a63` |

内存（链接器静态结果）：

| Section | 字节 |
|---|---|
| .isr_vector | 404 |
| .text | 10328 |
| .ARM.exidx | 8 |
| .data | 92 |
| .bss | 588 |
| ._user_heap_stack | 4096 |

4 KiB 栈是预留额度，不是实测峰值。Flash 实际用量还包含段对齐/初始化数据，详见 MAP 与 verification.json 中链接器输出。

已执行编译、链接、主机断言测试；未执行烧录、硬件功能、真实串口、云台负载、Proteus 或端到端视频测试。原始命令、退出码及源码哈希均保存在 build/verification.json。
