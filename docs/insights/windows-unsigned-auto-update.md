# 为什么 Windows 自动更新选择“无签名但不装作可信发布者”

## 用户要解决的不是证书问题

用户的核心目标是：Windows 版本能像 Mac 一样在应用内发现、下载并完成升级，但不想进入 Microsoft/Azure Trusted Signing 或 PFX 证书申请流程。这里最容易混淆的两件事是“安装器有写入权限”和“安装器是谁发布的”：per-user NSIS 可以在没有证书时更新文件，证书则为系统和客户端提供独立发布者身份。

因此产品选择不是“无证书也同样安全”，而是接受一个更窄、说得清楚的模型：Windows updater 信任固定的官方 GitHub 仓库，并用 Release metadata 的 SHA-512 确认下载内容与 metadata 一致。它换来零证书申请成本，但失去仓库之外的独立身份锚点。

## 为什么仍然可以做

这个项目已经具备一条较强的发布管线：官方 provenance bit、固定 GitHub provider、最小 token、同 build 资产审计、checksum、attestation、draft 完整后公开。再加上 Immutable Releases、main/tag rulesets 和 Action SHA pin，可以显著压低日常误上传、资产被后改、mutable Action tag 漂移等风险。

但这些保护仍属于同一个 GitHub 信任域。若拥有足够仓库/CI 权限的身份在首次发布时被攻破，攻击者仍可能同时发布恶意 installer 与匹配 metadata。产品文案必须保留这条边界，不能把 SHA-512 写成“已验证官方发布者”。

## 为什么提示放在应用内

只在 README 或 Release Notes 写“unsigned”不够，因为自动更新把用户从浏览器下载页带进应用内动作。用户点击“下载并安装”时应知道：

- 这是官方 `op7418/CodePilot` GitHub Release 路径；
- 文件会按 metadata SHA-512 校验；
- 没有 Authenticode publisher verification；
- Windows 仍可能显示 SmartScreen。

这个提示不是阻止使用，而是保持能力承诺与真实信任边界一致。以后若启用稳定 Authenticode publisher，可由真实 package provenance 决定是否隐藏，而不是简单删除文案。

## 增量更新如何对用户承诺

用户关心的“增量”是少下载、少等待，不是某种必须成功的专有 patch。采用 NSIS blockmap 的好处是：条件满足时只请求差异区间；条件不满足时仍回退完整安装包，功能可用性不依赖差分。

因此首版不显示“节省 60%”之类固定数字。不同版本的二进制布局、压缩变化和旧 installer 缓存都会改变结果；只有真实 RC-A → RC-B 请求统计才是这一对版本的实际证据。

## 为什么 Linux 延后

Windows NSIS 是单一 per-user installer/updater 模型；Linux 同时存在 AppImage、deb、rpm 与发行版包管理策略。没有受信 GPG repository、独立签名 manifest 和各包管理器真实升级 smoke 时，应用自行提权安装会扩大风险并产生不一致体验。先把 Windows 做成可验证闭环，比同时打开三个 Linux 升级路径更稳妥。

## 未来方向

- 若 SmartScreen 或企业设备阻断率成为主要问题，再评估 Authenticode/Trusted Signing；这会新增 publisher identity，而不是推翻现有资产审计。
- 评估客户端验证 GitHub artifact attestation 的可行性，前提是有稳定离线/网络失败降级设计。
- Linux 单独设计 repository/signature/package-manager 合同，不复用 Windows 的 unsigned NSIS 决策。

