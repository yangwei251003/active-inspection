# 模块原理图与可编辑工程

本目录归档现有模块连接候选设计，不包含可下单 PCB/Gerber。模块符号表达成品板接口，不复刻板内 MCU 最小系统。2026-10-26 迁移时只读取和检查文件、归档容器及元数据，未启动嘉立创 EDA/Bridge，也未重跑原生规则检查或接线实测。

| 文件 | 用途 |
|---|---|
| [active-inspection-native.eprj2](active-inspection-native.eprj2) | 嘉立创 EDA 专业版原生工程，使用“文件→打开工程”打开 |
| [active-inspection-native.epro2](active-inspection-native.epro2) | 原生交换归档，导入兼容性需在使用的客户端复验 |
| [active-inspection.epro2](active-inspection.epro2)、[active-inspection.epru](active-inspection.epru) | 生成器归档和文本源 |
| [native-schematic.png](native-schematic.png) | 原工程留存的原生图面截图，并非实板照片 |
| [module-interconnect.pdf](module-interconnect.pdf)、[SVG](module-interconnect.svg) | 由项目生成器生成的接线阅读图，并非原生 EDA 检查结果 |
| [expected-netlist.json](expected-netlist.json) | 生成器预期网络，用于重新核对连接 |
| [document-id-map.json](document-id-map.json) | 生成器使用的文档标识映射 |

原工程历史说明记录在嘉立创 EDA 专业版 3.2.77 中打开过该设计。公开副本不包含当时的日志、厂商对照工程及中间失败版本，不能把这段历史视为本次独立复验。打开后展开 `Module assembly → Active inspection module schematic`，选择 `01 Control and low-voltage power`；工程树出现不等于图页渲染完成。

## 使用与复验边界

- 这是成品模块连接设计，接口符号未配置制造封装。不能通过降低“缺少封装”的规则等级来宣称完整 ERC/PCB 验证通过。
- 三路 5 V 正极独立、逻辑模块共地的设计意图见[电源与候选针号](../docs/02-power-and-pins.md)。网表一致不证明实物的载流、压降、地线布置或输入门限合格。
- 实际板卡修订、引脚方向、舵机信号兼容性和供电余量仍待实物确认。固件默认关闭舵机输出。
- 本仓库没有 PCB、Gerber 或生产合格声明；上电、装配和动作试验均未在此次迁移进行。

## 重建现有示意图

从项目根执行 `python hardware/build_schematic.py` 可重建文本源和 SVG。可选 PNG/PDF 渲染需要 Node.js、Playwright 和其 Chromium 浏览器：

```powershell
cd hardware
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node render_schematic.mjs
```

该操作会更新当前副本中的生成文件，不会操作 EDA。重建源或手动编辑原生工程后，需要重新导入、检查端点与原生规则；生成器不会自动吸收原生工程中的手动修改。

格式资料：[官方 V3 文件格式](https://github.com/easyeda/easyeda-pro-file-format)、[官方格式 Skill](https://github.com/easyeda/easyeda-pro-format-skill)、[设计规则说明](https://prodocs.lceda.cn/cn/schematic/design-design-rule/)。厂商资料由其权利人授权，不适用本项目 MIT。
