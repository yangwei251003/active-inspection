# 主动巡检终端硬件交付入口

更新：2026-09-30。状态：**采购前候选设计，尚无到货或上电证据**。

本方案为 NUCLEO-F401RE + Waveshare ESP32-P4-NANO-KIT-A（C6 无线模块、OV5647 摄像头）+ 预装双轴微型云台。STM32 负责运动和失联停止，P4 负责视频、网络、蓝牙和限定区域识别。用户焊接目标为 0 点；是否达到必须由实际发货版本和预装服务确认。

| 文件 | 用途 |
|---|---|
| [01-procurement.md](01-procurement.md) | 公开物料技术入口与替换边界 |
| [02-power-and-pins.md](02-power-and-pins.md) | 电源树、电平、候选物理针号、禁止混接的电源端 |
| [03-arrival-and-assembly.md](03-arrival-and-assembly.md) | 到货核验、一步一验证、组装与初次运行流程 |
| [04-troubleshooting-and-tests.md](04-troubleshooting-and-tests.md) | 按现象排查、实物测试表和论文证据要求 |
| [05-source-register.md](05-source-register.md) | 官方技术资料与尚未确认的实物条件 |
| [../bom.csv](../bom.csv) | 可导入表格的物料规格表 |
| [../pin-plan.json](../pin-plan.json) | 可供固件、EDA、图纸交叉检查的候选引脚清单 |
| [../eda/active-inspection-native.eprj2](../eda/active-inspection-native.eprj2) | 已重新打开验证的嘉立创原生工程；[验证记录](../eda/README.md)保留检查范围与7条封装警告 |

CAD 对应 `../../mechanical/`；烧录及固件构建对应 `../../firmware/`。首次打印前先核对板卡、云台、摄像头和线缆尺寸；当前 CAD 的包络模型不能代替到货尺寸。

## 已明确与待明确

已完成文档级核对：F401 候选 USART1/TIM3 引脚、官方连接器针号、P4 P1-13/P1-15 对应 GPIO20/GPIO21、KIT-A 摄像头与排线组合、Nucleo USB 充电器供电的跳线限制。它们是 V0 文档证据。

尚待证实：实际 MCU/PCB 修订、实物针号方向、卖家预焊/预装承诺、舵机 3.3 V 输入门限、5 V 供电余量、云台负载及排线弯曲范围。实物未核验前，不应按候选图带电试接或把任意同名板烧入现有镜像。

本项目的网络视频和低压云台不具备安全关键监控认证；使用对象限定为低风险、可容忍漏检的可见状态。论文中的电路和软件设计可以引用本包；实测结论必须来自后续记录。
