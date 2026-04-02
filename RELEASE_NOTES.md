## CodePilot v0.44.1

> v0.44.0 热修复：修复切换会话时模型选择器跳到错误模型的问题，以及若干界面优化。

### 修复问题

- 修复切换会话时，模型选择器短暂显示上一个会话的模型再跳回正确值的问题
- 修复分栏视图中切换会话同样会出现模型跳动的问题
- 修复全局默认模型属于其他服务商时，可能被错误应用到当前会话的问题
- 移除设置页中的"重置伙伴"按钮（测试功能，不应出现在正式版）

### 优化改进

- 看板面板默认宽度从 640px 调整为 480px，减少对聊天区域的占用
- 模型解析逻辑统一为共享函数，主聊天页和分栏视图行为一致
- 新增 11 个模型解析回归测试，覆盖跨服务商、空配置、已删除服务商等边界场景

## 下载地址

### macOS
- [Apple Silicon (M1/M2/M3/M4)](https://github.com/op7418/CodePilot/releases/download/v0.44.1/CodePilot-0.44.1-arm64.dmg)
- [Intel](https://github.com/op7418/CodePilot/releases/download/v0.44.1/CodePilot-0.44.1-x64.dmg)

### Windows
- [Windows 安装包](https://github.com/op7418/CodePilot/releases/download/v0.44.1/CodePilot-Setup-0.44.1.exe)

## 安装说明

**macOS**: 下载 DMG → 拖入 Applications → 首次启动如遇安全提示，在系统设置 > 隐私与安全中点击"仍要打开"
**Windows**: 下载 exe 安装包 → 双击安装

## 系统要求

- macOS 12.0+ / Windows 10+ / Linux (glibc 2.31+)
- 需要配置 API 服务商（Anthropic / OpenRouter 等）
- 推荐安装 Claude Code CLI 以获得完整功能
