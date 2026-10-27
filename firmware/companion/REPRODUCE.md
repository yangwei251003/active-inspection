# ESP协处理器复现

完整构建需要先按官方说明安装并激活 **ESP-IDF 6.0.2**，固定提交 `7101770dc6db2667b3c477cc31365dd1acd6db4e`，以及该版本管理的RISC-V工具链。建议在短英文路径克隆，避开原开发环境的长中文路径问题。本公开副本不建立Q:映射，也不修改SDK全局配置。

## 获取锁定来源

在 `firmware/companion` 执行：

```powershell
python bootstrap_dependencies.py
```

该脚本仅获取WebRTC与ESP-Hosted官方固定提交到被忽略的vendor目录。已有版本或修改不符则停止，不重置文件。

| 输入 | 固定来源 |
|---|---|
| ESP-IDF | espressif/esp-idf，提交 `7101770dc6db2667b3c477cc31365dd1acd6db4e` |
| WebRTC | espressif/esp-webrtc-solution，提交 `3971094e2e7c2ab7cb4de59e4eae710e1902d2b4` |
| C6 ESP-Hosted | espressif/esp-hosted-mcu，提交 `dd0176e5fc959d79b306f6677a2f878123c58e9a` |
| P4组件锁 | 本目录 `dependencies.lock`，不要删除以绕过冲突 |

## 构建

从已激活上述IDF的PowerShell运行 `./build.ps1`；C6为 `./c6/build.ps1`。它们调用标准 `idf.py`，不含烧录。也可在相应项目目录使用官方CLI；默认P4目标为esp32p4，C6目标为esp32c6，C6编译项目位于官方vendor树的slave目录。

`sdkconfig.defaults` 只保留无个人凭据的目标默认值。真实配置由使用者本机生成，`sdkconfig`被忽略。不要公开带Wi-Fi或令牌的镜像，默认参数也不是实际板卡和线路已验证的证明。

本次迁移验证了独立协处理器核心的主机测试，**未在新公开路径重跑完整P4/C6构建**。原阶段的二进制、SDK缓存、原Q:适配和机器日志未打包，不将历史构建结果改写为当前复现已通过。版本获取与完整IDF环境仍需用户按当前官方说明配置并验证。

## 许可

C6从机主体来自官方ESP-Hosted，不冒称独立原创固件。部分WebRTC/音视频库采用限定乐鑫产品的修改许可，并非通用MIT；源码集成和锁文件不代替各组件的许可/NOTICE。见仓库根THIRD_PARTY_NOTICES.md。


## 已保全的Windows路径补丁

`patches/esp-idf-6.0.2-windows-path.patch`保留原项目的8行CMake兼容修改：仅在显式设置`AI_CANONICAL_PROJECT_ROOT`时，将组件管理器生成的中文规范路径替换为使用者自己提供的等价短路径。补丁以Apache-2.0保留上游许可，见同目录LICENSE-ESP-IDF。

若确实需要该适配，先在**自己的**锁定IDF克隆内运行 `git apply --check /path/to/esp-idf-6.0.2-windows-path.patch`，逐行审查后再手动`git apply`。原SDK或机器盘符不随仓库提供，不自动创建盘符映射。短英文项目路径通常无需此补丁。

2026-10-26只在隔离复制的官方原文件上执行检查与应用，所得文本与原项目已修改文件一致；原SDK未改，未因此声称完整P4/C6构建通过。14个子模块中927项表面差异已与父工程锁定的官方对象逐项匹配，属于Git元数据/版本快照差异，没有额外自有源码补丁。
