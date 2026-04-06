## CodePilot v0.46.0

> 新增 Ollama 本地模型支持，优化工具调用展示和推理内容（Thinking）的显示与保留。

### 新增功能

- 新增 Ollama 服务商预设：一键接入本地模型，无需 API 密钥
- 新增推理内容（Thinking）流式展示：支持实时查看模型的推理过程
- 工具调用展示全面重构：分组折叠、状态指示、运行中工具实时输出

### 修复问题

- 修复中断或出错时已展示的推理内容（Thinking）在完成态消失的问题
- 修复远程桥接（Telegram/Discord/飞书）静默丢弃推理内容的问题
- 修复未注册工具（MCP 工具、插件工具等）在操作列表中不显示名称的问题
- 修复 auth_token 认证方式未显式清空 API Key 导致部分服务商连接失败的问题

### 优化改进

- 服务商文档新增 Ollama 配置指南（中英双语）

## 下载地址

### macOS
- [Apple Silicon (M1/M2/M3/M4)](https://github.com/op7418/CodePilot/releases/download/v0.46.0/CodePilot-0.46.0-arm64.dmg)
- [Intel](https://github.com/op7418/CodePilot/releases/download/v0.46.0/CodePilot-0.46.0-x64.dmg)

### Windows
- [Windows 安装包](https://github.com/op7418/CodePilot/releases/download/v0.46.0/CodePilot.Setup.0.46.0.exe)

## 安装说明

**macOS**: 下载 DMG → 拖入 Applications → 首次启动如遇安全提示，在系统设置 > 隐私与安全中点击"仍要打开"
**Windows**: 下载 exe 安装包 → 双击安装

## 系统要求

- macOS 12.0+ / Windows 10+ / Linux (glibc 2.31+)
- 需要配置 API 服务商（Anthropic / OpenRouter / Ollama 等）
- 推荐安装 Claude Code CLI 以获得完整功能
