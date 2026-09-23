## CodePilot v0.67.17

> 新增可查看来源、更正和忘记的助理记忆管理，减少辅助功能失败后的重复请求，并修复 Gemini 普通聊天报错。

### 新增功能

- **助理记忆管理** — 在设置的助理工作区中手动保存、查看来源、更正或忘记记忆；手动管理不调用模型。
- **自动提取状态** — 查看成功对话后的记忆提取进度、失败原因和可重试时间；同一批任务连续生成失败达到3次后停止自动重试。
- **快捷建议重试** — 动态建议不可用时显示原因，提供重试按钮和真实冷却截止时间。

### 修复问题

- 修复 Gemini 在启用视频工具后，连普通问候也可能因工具参数声明不兼容而报错的问题；视频时长仍严格校验为6秒或10秒。
- 修复只为 Claude Code 配置凭据时，后台记忆提取和快捷建议仍误尝试直接请求、重复产生错误的问题。
- 修复限流及普通请求错误可能永久阻断辅助功能的问题；凭据错误等待配置修复，其他错误冷却后可重试。
- 修复辅助配置文件不可用时可能打断聊天的问题；记忆搜索的可选智能排序失败时保留基础搜索结果并说明原因。
- 修复只在记忆正文出现的信息可能无法被搜索到，以及已忘记内容可能被旧索引再次带回的问题。
- 修复旧助理会话身份识别与界面不一致，以及已选择助理目录的远程会话无法参与自动提取的问题。
- 修改服务商配置后，快捷建议立即重新检查，不再被旧失败缓存遮蔽。

### 优化改进

- Claude Code、Codex 和 Native 共享助理记忆的读取、搜索及记录格式；记忆功能仅在已绑定助理工作区的会话启用，普通项目不自动加入。
- 计划模式保持记忆只读；对话中的记忆写工具遵循会话审批策略，只有实际保存成功才确认已记住。
- 自动提取每累计3个成功用户回合尝试整理长期信息，可能消耗所选服务商额度，通过校验后自动保存；可在记忆面板查看和调整。
- 区分容量不足、文件损坏、访问失败与编辑冲突，减少无效重试；改善错误诊断并减少已知配置故障的重复上报。
- 增加聊天输入框下方留白，避免输入框贴近窗口底边。

### 已知验证缺口

- 已通过本地回归、真实 SDK 合成请求和隔离界面验证；三 Runtime 真实账号的完整记忆流程、打包客户端人工验收仍待完成。
- Gemini 已验证真实问候；完整工具生成、压缩后续聊及 Windows 多模型会话仍保留此前的实测缺口。
- 此前版本的运行期恢复、长时间稳定性与真实自动升级验证缺口继续跟踪，不因发布而标记通过。
- Windows 安装包未配置 Authenticode 证书，请只从本 Release 下载并核对 SHA-256。

## 下载地址

> macOS v0.67.5 及更高正式版、Windows v0.67.10 及更高正式版可在应用内检查并升级。更早的 Windows 版本请手动安装 v0.67.17；Linux 继续手动下载安装。

### macOS

- [Apple Silicon (M1/M2/M3/M4)](https://github.com/op7418/CodePilot/releases/download/v0.67.17/CodePilot-0.67.17-arm64.dmg)
- [Intel](https://github.com/op7418/CodePilot/releases/download/v0.67.17/CodePilot-0.67.17-x64.dmg)

### Windows

- [Windows x64 安装包](https://github.com/op7418/CodePilot/releases/download/v0.67.17/CodePilot.Setup.0.67.17.exe)
- Windows 安装包未配置 Authenticode 证书，可能显示 SmartScreen。仅从本 Release 下载并核对 SHA-256；应用内也会在安装更新前再次明确提示未签名状态。

### Linux

- [x64 AppImage](https://github.com/op7418/CodePilot/releases/download/v0.67.17/CodePilot-0.67.17-x86_64.AppImage)
- [arm64 AppImage](https://github.com/op7418/CodePilot/releases/download/v0.67.17/CodePilot-0.67.17-arm64.AppImage)
- [amd64 DEB](https://github.com/op7418/CodePilot/releases/download/v0.67.17/CodePilot-0.67.17-amd64.deb)
- [arm64 DEB](https://github.com/op7418/CodePilot/releases/download/v0.67.17/CodePilot-0.67.17-arm64.deb)
- [x86_64 RPM](https://github.com/op7418/CodePilot/releases/download/v0.67.17/CodePilot-0.67.17-x86_64.rpm)
- [aarch64 RPM](https://github.com/op7418/CodePilot/releases/download/v0.67.17/CodePilot-0.67.17-aarch64.rpm)

### 完整性验证

- [SHA-256 Checksums](https://github.com/op7418/CodePilot/releases/download/v0.67.17/SHA256SUMS.txt)
- GitHub Release 页面可验证每个安装包的 build-provenance attestation；`latest-mac.yml`、`latest.yml` 与 blockmap 是自动更新器资产，不需要手工下载。

## 安装说明

**macOS**：下载 DMG → 拖入 Applications → 正常启动。若 Gatekeeper 报告开发者无法验证或文件损坏，请停止安装并反馈，不要绕过安全检查。

已安装的 macOS 正式版会通过同一 GitHub Release 的 `latest-mac.yml` 检查更新，并使用签名、公证后的 universal ZIP 完成应用内下载与重启安装。

**Windows**：v0.67.10 及更高版本会通过 `latest.yml` 优先差分下载未签名 NSIS，失败时回退完整安装包。更早版本需手动安装 v0.67.17。出现 SmartScreen 时请核对下载来源与 SHA-256；安装前仍会明确提示没有独立发布者签名。

**Linux**：继续手动下载新版安装包，不会静默运行包管理器或提权安装。

## 系统要求

- macOS 12.0+
- Windows 10/11 x64，或常见 x64/arm64 Linux 发行版
- 需要配置 API 服务商或受支持的套餐凭据
- 推荐安装 Claude Code CLI 或 Codex CLI 以获得完整功能
