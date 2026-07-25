## CodePilot v0.59.1

> 修复开启系统代理时 xAI Grok OAuth 可能在浏览器授权成功后仍无法完成登录的问题。

### 修复问题

- **修复 xAI OAuth 代理分流** — 系统浏览器和 CodePilot 后台的授权请求现在会使用一致的 HTTP(S) 代理路径，避免网页已经授权、应用却在换取 token 时提示网络失败。
- **覆盖完整 OAuth 生命周期** — 浏览器授权码交换、设备码登录、token 刷新以及登录后的 Grok 请求都会遵循 HTTP(S) 系统代理和 `NO_PROXY` 设置。

### 优化改进

- 网络失败现在会显示经过脱敏的底层错误类型，便于区分 DNS、连接拒绝和连接重置，同时不会记录代理地址或凭据。
- 代理仅应用于 xAI 的外部请求，不会全局改写其他 Provider 或本地 OAuth callback 的网络行为。

### 已知限制

- SOCKS/PAC 代理暂不由 CodePilot 后台直接解析，此类配置维持直连；由 TUN 模式接管系统流量的代理不受影响。

## 下载地址

### macOS
- [Apple Silicon (M1/M2/M3/M4)](https://github.com/op7418/CodePilot/releases/download/v0.59.1/CodePilot-0.59.1-arm64.dmg)
- [Intel](https://github.com/op7418/CodePilot/releases/download/v0.59.1/CodePilot-0.59.1-x64.dmg)

### Windows
- [Windows 安装包](https://github.com/op7418/CodePilot/releases/download/v0.59.1/CodePilot.Setup.0.59.1.exe)

## 安装说明

**macOS**：下载 DMG → 拖入 Applications → 首次启动如遇安全提示，在系统设置 > 隐私与安全中点击“仍要打开”
**Windows**：下载 exe 安装包 → 双击安装

## 系统要求

- macOS 12.0+ / Windows 10+ / Linux (glibc 2.31+)
- 需要配置 API 服务商或受支持的套餐凭据
- 推荐安装 Claude Code CLI 以获得完整功能
