# 硬件技术来源

以下是原工程用于核对参考板的官方资料入口；迁移日期为 2026-10-26。本页保留技术来源，不包含个人采购、价格、订单或预算。原工程核查日期为 2026-09-30，资料应在实际使用时重新核对。公开副本不捆绑许可范围未确认的厂商 PDF、裁图或网页全文。

| 来源 | 对应技术内容 | 仍需确认 |
|---|---|---|
| [ST NUCLEO-F401RE](https://www.st.com/en/evaluation-tools/nucleo-f401re.html) | 参考板型、调试器及连接器入口 | 实际 PCB 修订与排针朝向 |
| [ST UM1724](https://www.st.com/resource/en/user_manual/dm00105823.pdf) | 原工程采用 Rev17；USB/JP1/JP5/E5V 与 F401RE CN7/CN10 | 实际供电电流、到货版本及供电顺序 |
| [Waveshare P4-NANO 文档](https://docs.waveshare.net/ESP32-P4-NANO/) | 经典 C6 版、KIT-A、CSI/USB 与芯片配置 | C5/WIFI6-DB 版本兼容性、相机与排线批次 |
| [Waveshare 官方原理图](https://files.waveshare.com/wiki/ESP32-P4-NANO/ESP32-P4-NANO-schematic.pdf) | P1-13=GPIO20、P1-15=GPIO21、P1-25=GND 的候选依据 | 实际修订、针1位置、预焊状态 |
| [P4-NANO 套件入口](https://www.waveshare.com/product/arduino/boards-kits/esp32-p4/esp32-p4-nano.htm) | 组合配件与相机型号核对入口 | 实际所用套餐与配件 |
| [DFRobot FIT0415](https://www.dfrobot.com.cn/goods-1117.html) | 参考支架形态；裸套件与已装云台的区别 | 实际舵盘匹配、孔距与预装状态 |
| [Waveshare MG90S](https://www.waveshare.com/mg90s-servo.htm) | 4.8–6 V、标称行程与参考包络 | 3.3 V 输入门限、堵转电流、真实齿隙 |
| [WeAct MiniSTM32F4x1](https://github.com/WeActStudio/WeActStudio.MiniSTM32F4x1) | F411 备选板的资料入口 | 不能自动复用 F401 镜像、针表或外壳 |
| [DFRobot 电源目录](https://www.dfrobot.com.cn/category-344.html) | 固定 5 V 成品电源参考入口 | 接头、输出保护、额定电流及插座适配 |
| [CH343 USB UART Board](https://www.waveshare.com/product/ch343-usb-uart-board.htm) | C6 更新工具的 3.3 V 逻辑功能要求 | 实际 SKU、跳线和针序 |
| [Waveshare C6 FAQ](https://docs.waveshare.com/ESP32-P4-NANO/FAQ/) | 独立 UART 下载与模式条件入口 | 实际固件版本、首次更新与恢复过程；另见[本项目 C6 构建说明](../../firmware/companion/REPRODUCE.md) |

原工程资料下载的指纹仅供版本辨识，不表示随仓库分发：

- ST UM1724 Rev17：`576d9bee3bc32c8ee70bf0d77cf9494cec06ea7c1d9ff98eebf2738cb9314a14`。
- ESP32-P4-NANO 原理图：`1e57b31f9ecc98be77c6cfba7ff1720e0f764d36208cbe18dff7f1fbea310de1`。

这些来源不能证明板卡已经到货、针号吻合、功耗达标或实物测试通过。外壳配合、FFC 寿命、云台重复定位、真实视频与 BLE 表现均保留为待验证。
