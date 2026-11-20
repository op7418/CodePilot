
# 脱离 Claude Code — 产品思考

## 解决了什么用户问题

**核心痛点：CodePilot 无法独立运行。**

之前用户必须先安装 Claude Code CLI（需要 Anthropic 账号 + npm 全局安装），才能使用 CodePilot 的 AI 对话功能。这造成了几个问题：

1. **新用户上手门槛高** — 安装 Claude Code 需要终端操作、npm 环境、Anthropic 认证，非开发者用户很难完成
2. **单一服务商锁定** — 只能用 Anthropic 模型，想用 OpenAI/Google 等模型的用户被拒之门外
3. **CLI 版本依赖** — Claude Code 更新可能影响 CodePilot 稳定性，用户无法控制

## 为什么这样设计

### 双 Runtime 共存，而非替换

保留 Claude Code SDK 作为可选项，原因：
- Claude Code CLI 提供了成熟的 MCP 插件生态、文件检查点、权限管理等能力
- 一些高级用户已经依赖 Claude Code 的特定行为
- 渐进迁移比一刀切更安全

### 选择 Vercel AI SDK 作为 Native 引擎

对比过的方案：
- **直接用 Anthropic SDK** — 只支持单服务商
- **LangChain** — 过度设计，抽象层太厚
- **各原生 SDK** — 需自建统一层，维护成本高
- **Vercel AI SDK** ✅ — 多 Provider、流式、tool use、thinking 支持最均衡，且项目已在用

### 自建 Agent Loop 而非 AI SDK 内置循环

AI SDK 提供了 `maxSteps`/`stopWhen` 自动循环，但我们需要在每步之间：
- 检查工具权限（可能暂停等用户审批）
- 持久化消息到 DB
- 检测 doom loop（同一工具连续调用 3 次）
- 检测 context overflow 触发压缩
- 发射自定义 SSE 事件（rewind_point、permission_request 等）

这些需求和 OpenCode 一致——他们也选择了自建循环。

### OpenAI Codex API 集成

参考了三个项目：
- **Codex CLI**（OpenAI 官方）— 确认了 API endpoint 和认证方式
- **OpenCode** — custom fetch 拦截器模式，自建 Responses API 适配器
- **Craft Agents** — OAuth 流程和模型列表

关键发现：Codex API (`chatgpt.com/backend-api`) 和标准 OpenAI API (`api.openai.com`) 是不同端点，需要特殊的 URL 重写和认证头注入。

## 用户反馈驱动的决策

- **"为什么选了 OpenAI 模型没反应"** → 发现 MCP 工具未加载，因为 `loadCodePilotMcpServers()` 只返回有占位符的 server
- **"内置工具调用要授权太烦"** → `codepilot_*` 前缀的工具跳过权限检查
- **"看不到在用哪个引擎"** → 输入框下方加了 RuntimeBadge
- **"设置里 CLI 开关和 Runtime 选择重复"** → 合并为三选一

## 参考的外部项目

| 项目 | 参考了什么 |
|------|-----------|
| Claude Code 源码 (`src/constants/prompts.ts`) | 系统提示词结构、任务执行哲学、工具使用指导、操作安全准则 |
| OpenCode (`packages/opencode/src/`) | 自建 Agent Loop 模式、provider-specific prompt、Codex API 集成 |
| Craft Agents (`packages/shared/src/`) | OpenAI OAuth 流程、模型列表、thinking level 映射 |
| Codex CLI (`codex-rs/`) | Codex API endpoint 确认、reasoning 参数、流事件格式 |

## 未来方向

1. **更多 Provider 的 OAuth 集成** — Google Gemini、GitHub Copilot 等
2. **AI SDK `@ai-sdk/mcp` 迁移** — 替换自建的 mcp-connection-manager，减少维护量
3. **图片/文件输入完善** — Native 路径的多模态能力对齐 SDK 路径
4. **Provider-specific 系统提示词** — 参考 OpenCode，为不同模型优化 prompt
5. **Telemetry 接入** — AI SDK 的 OpenTelemetry 集成，生产环境可观测性

## 已知局限

- Native Runtime 的 reasoning/thinking 展示尚未完全调通（Codex API 返回格式待对齐）
- Plugin 系统（Claude Code 的 `enabledPlugins`）在 Native 路径无对应，靠 builtin-tools + MCP 覆盖
- Bridge 通道固定 `thinking: disabled`，高级参数未开放给 IM 用户
