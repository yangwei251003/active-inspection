# 第三方许可边界

根MIT仅适用于维护者自有代码、文档和设计。源文件中已有的原作者声明保留，外部依赖不被统一改为MIT。

- ST HAL为BSD-3-Clause；CMSIS Core/Device相关部分为Apache-2.0。精确提交见 `firmware/stm32/dependency-lock.json`，323个实际依赖文件的哈希在相邻清单中。SDK源码不直接随仓库发布。
- ESP-IDF主项目为Apache-2.0，但传递组件并非都只有此许可。WebRTC、esp_peer、音视频等部分采用Espressif修改MIT/仅限乐鑫产品的许可，不能移植到其他芯片后仍称无限制MIT。
- C6从机主体取自锁定ESP-Hosted官方仓库；本项目公开自有集成、配置和构建入口，不将官方SDK示例计作原创成果。
- Node依赖ws 8.22.0为MIT，应保留安装包中的声明。MediaMTX、Caddy、FFmpeg与其依赖不在本项目自有内容范围，相关二进制不打包。
- 嘉立创、FreeCAD及CAD运行环境均为外部工具；工程设计源的公开不重新授权这些软件或厂商资料。

本次不分发SDK/媒体工具/真实固件二进制。以后若打包运行时、预编译库或商业固件，需针对实际分发内容保留各自完整LICENSE/NOTICE及适用限制，不能只引用本页摘要。

厂商 PDF、网页摘录与原理图裁图的再分发范围未核实，本公开版仅保留官方链接和版本指纹；`hardware/docs/sources/` 不属于发布文件。可选 CAD Skill 与 Playwright 是外部运行工具，另行安装并遵守其原许可。
