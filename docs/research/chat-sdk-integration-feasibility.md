# Chat SDK 集成可行性调研报告

## 背景

调研 Vercel 最新推出的 Chat SDK（`npm install chat`）是否能集成到 CodePilot 中，实现通过 Telegram 等 IM 远程控制 AI 应用。

---

## 一、Chat SDK 是什么

Chat SDK（包名 `chat`）是 Vercel 推出的**独立于 AI SDK 的新包**，核心能力是：**一套代码部署到多个聊天平台**。

- 包名：`chat`（不是 `ai`）
- 已支持平台：Slack、Microsoft Teams、Google Chat、Discord、**Telegram**、GitHub、Linear
- 通过 Matrix 适配器（Beeper Cloud）还可桥接 WhatsApp、Instagram、Signal 等
- 与 AI SDK 是互补关系：AI SDK 负责 LLM 调用，Chat SDK 负责多平台消息分发

## 二、CodePilot 当前架构

| 层级 | 技术 | 说明 |
|------|------|------|
| 核心引擎 | `@anthropic-ai/claude-agent-sdk` | 主要的 Claude Code 交互，工具执行、权限管理 |
| 辅助生成 | `ai` + `@ai-sdk/*` | 仅用于图片生成和文本批处理规划 |
| 通信协议 | 自定义 SSE | 12 种事件类型（text、tool_use、permission_request 等） |
| 前端 | Next.js + 自定义组件 | 不使用 useChat，完全自建的流管理和 UI |
| 运行环境 | Electron 桌面端 | 本地进程，操作用户本地文件系统 |

**关键点**：CodePilot 的核心是 Claude Agent SDK 驱动的**本地代码执行引擎**，不是简单的 LLM 聊天。它涉及文件读写、终端命令、权限审批等本地操作。

## 三、能否集成？技术分析

### 可行的部分

Chat SDK 的 Telegram 适配器可以实现：
- 接收 Telegram 消息并转发给后端
- 将文本回复推送回 Telegram
- 支持按钮交互（inline keyboard）
- AI SDK 流式输出直接推送到 Telegram

### 不可行 / 困难的部分

| 问题 | 说明 |
|------|------|
| **权限审批** | Claude Code 执行工具前需要用户授权（文件写入、命令执行），Telegram 的交互能力有限（callback data 仅 64 字节），难以承载复杂的权限审批流 |
| **富内容展示** | CodePilot 的 UI 包含代码高亮、diff 预览、文件树、终端输出、思维链等，Telegram 仅支持纯文本 + Markdown |
| **本地文件操作** | Claude Code 需要操作本地文件系统，而 Chat SDK 是服务端部署的，需要额外的远程访问层 |
| **会话状态** | 当前的 SSE 流管理和 session 恢复机制是为 Electron 设计的，需要大幅改造才能适配 Chat SDK 的事件模型 |
| **部署模型不同** | Chat SDK 需要一个常驻服务端来接收 webhook，而 CodePilot 是桌面应用 |

### 架构冲突

```
当前：用户 ←→ Electron UI ←→ Next.js API ←→ Claude Agent SDK ←→ 本地文件系统
                                    ↑
Chat SDK 需要：Telegram ←→ 云端服务 ←→ ???  ←→ 本地文件系统（断裂）
```

Chat SDK 本质是让 **服务端 bot** 部署到多个平台。而 CodePilot 是**本地桌面应用**直接操作用户机器上的文件。这两个模型之间存在根本性的架构鸿沟。

## 四、结论

**不建议集成 Chat SDK 到 CodePilot。** 原因：

1. **用途不匹配**：Chat SDK 解决的是「一个 bot 部署到多个聊天平台」的问题，而 CodePilot 是本地代码执行工具，不是聊天 bot
2. **改造成本极高**：需要引入云端中转服务、远程文件访问、简化版权限审批、消息格式降级等大量基础设施
3. **体验必然降级**：Telegram 无法承载 CodePilot 当前的富交互体验（代码 diff、文件树、工具审批等）
4. **安全风险**：通过 Telegram 远程触发本地文件操作和终端命令，需要非常谨慎的安全设计

### 如果确实想要远程控制能力

更合理的路径是：
- **方案 A**：为 CodePilot 加一个 Web 远程访问层（类似 VS Code Remote），保留完整 UI 体验
- **方案 B**：做一个极简的 Telegram bot 只负责监控和通知（任务进度、错误告警），不做执行控制
