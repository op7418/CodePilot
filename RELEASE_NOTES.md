## CodePilot v0.68.0

> **最低系统要求提升为 macOS 13 Ventura。** v0.67.17 是最后一个支持 macOS 12 的版本，v0.68.0 起无法在 macOS 12 及更早系统上运行。macOS 12 用户请继续使用 v0.67.17；已安装的正式版在 macOS 12 上不会再收到应用内更新。

> 升级桌面运行时并修复多个已知安全漏洞；MCP 配置修改即时生效，定时任务恢复更平稳。

### 修复问题

- 修改 MCP 服务的配置（命令、参数、环境变量或地址）后不用重启应用即可生效。
- 连接失败的 MCP 服务不再在每条消息时重新尝试启动，改为间隔一段时间后再重试；手动重新连接仍会立即尝试。连接失败时也不再遗留后台进程。
- 应用停止运行期间错过的定时任务，恢复后不再同时全部发起，而是分批依次执行。
- 加固上传文件访问的路径检查：名字相近的其他目录，以及指向上传目录之外的链接，都不能再被读取。
- 密码输入框的右键菜单不再提供复制和剪切。
- 修复英文界面下健康页中“执行引擎 / CLI”标题仍显示为中文的问题。

### 优化改进

- 升级桌面运行时和多项依赖，修复了多个已知安全漏洞。

## 下载地址

> macOS 13 及以上的 v0.67.5 及更高正式版、Windows v0.67.10 及更高正式版可在应用内检查并升级。更早的 Windows 版本请手动安装 v0.68.0；Linux 继续手动下载安装。

### macOS

- [Apple Silicon (M1/M2/M3/M4)](https://github.com/op7418/CodePilot/releases/download/v0.68.0/CodePilot-0.68.0-arm64.dmg)
- [Intel](https://github.com/op7418/CodePilot/releases/download/v0.68.0/CodePilot-0.68.0-x64.dmg)

### Windows

- [Windows x64 安装包](https://github.com/op7418/CodePilot/releases/download/v0.68.0/CodePilot.Setup.0.68.0.exe)
- Windows 安装包没有独立发布者签名（未配置 Authenticode 证书），可能显示 SmartScreen。仅从本 Release 下载并核对 SHA-256；应用内也会在安装更新前再次明确提示未签名状态。

### Linux

- [x64 AppImage](https://github.com/op7418/CodePilot/releases/download/v0.68.0/CodePilot-0.68.0-x86_64.AppImage)
- [arm64 AppImage](https://github.com/op7418/CodePilot/releases/download/v0.68.0/CodePilot-0.68.0-arm64.AppImage)
- [amd64 DEB](https://github.com/op7418/CodePilot/releases/download/v0.68.0/CodePilot-0.68.0-amd64.deb)
- [arm64 DEB](https://github.com/op7418/CodePilot/releases/download/v0.68.0/CodePilot-0.68.0-arm64.deb)
- [x86_64 RPM](https://github.com/op7418/CodePilot/releases/download/v0.68.0/CodePilot-0.68.0-x86_64.rpm)
- [aarch64 RPM](https://github.com/op7418/CodePilot/releases/download/v0.68.0/CodePilot-0.68.0-aarch64.rpm)

### 完整性验证

- [SHA-256 Checksums](https://github.com/op7418/CodePilot/releases/download/v0.68.0/SHA256SUMS.txt)
- GitHub Release 页面可验证每个安装包的 build-provenance attestation；`latest-mac.yml`、`latest.yml` 与 blockmap 是自动更新器资产，不需要手工下载。

## 安装说明

**macOS**：下载 DMG → 拖入 Applications → 正常启动。若 Gatekeeper 报告开发者无法验证或文件损坏，请停止安装并反馈，不要绕过安全检查。

已安装的 macOS 正式版会通过同一 GitHub Release 的 `latest-mac.yml` 检查更新，并使用签名、公证后的 universal ZIP 完成应用内下载与重启安装。

**macOS 12 及更早系统**：新版本无法在这些系统上运行，请继续使用最后一个支持的版本 v0.67.17。已安装的正式版在这些系统上不会再收到应用内更新。

**Windows**：v0.67.10 及更高版本会通过 `latest.yml` 优先差分下载未签名 NSIS，失败时回退完整安装包。更早版本需手动安装 v0.68.0。安装包没有独立发布者签名，出现 SmartScreen 时请核对下载来源与 SHA-256；安装前应用内仍会明确提示没有独立发布者签名。

**Linux**：继续手动下载新版安装包，不会静默运行包管理器或提权安装。

## 系统要求

- macOS 13.0+（v0.67.17 是最后一个支持 macOS 12 的版本）
- Windows 10/11 x64，或常见 x64/arm64 Linux 发行版
- 需要配置 API 服务商或受支持的套餐凭据
- 推荐安装 Claude Code CLI 或 Codex CLI 以获得完整功能
