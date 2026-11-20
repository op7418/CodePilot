# 自建 Agent Loop 替代 claude-agent-sdk — 深度调研

> 创建时间：2026-04-06
> 关联执行计划：decouple-claude-code

## 1. CodePilot 当前 Agent Loop 完整事件流

### 当前架构链路

```
Frontend (ChatView / page.tsx)
  → stream-session-manager.startStream()
    → fetch('/api/chat', POST)
      → route.ts: assembleContext + resolveProvider + streamClaude()
        → claude-client.ts: query() from @anthropic-ai/claude-agent-sdk
          → spawns Claude Code CLI subprocess
            → CLI 内部完成 Agent Loop (API call → tool_use → execute → tool_result → continue)
          → yields SDK messages back
        → claude-client.ts formats to SSE events
      → route.ts returns ReadableStream<SSE>
    → consumeSSEStream() parses SSE
  → snapshot updates → React re-render
```

### 核心调用点

**`claude-client.ts` ~第 978 行** — `query()` 入口：
```typescript
let conversation = query({
  prompt: finalPrompt,
  options: queryOptions,
});
```

**`queryOptions` 关键参数构建（~第 502-713 行）：**
- `cwd` — 工作目录
- `permissionMode` — 权限模式 (`acceptEdits` / `plan` / `bypassPermissions`)
- `env` — 子进程环境变量（含 API key、provider 配置）
- `settingSources` — SDK 设置来源
- `model` — 模型标识
- `systemPrompt` — 系统提示（preset: 'claude_code' + append）
- `mcpServers` — MCP 服务器配置（CodePilot 内置 + 用户配置）
- `canUseTool` — 权限回调函数
- `thinking` / `effort` — 思考配置
- `resume` — 会话恢复 ID
- `pathToClaudeCodeExecutable` — CLI 可执行文件路径

### SDK 消息处理循环（~第 1035+ 行）

```
for await (const message of conversation) {
  switch (message.type) {
    case 'assistant':   → 提取 tool_use blocks → SSE { type: 'tool_use' }
    case 'user':        → 提取 tool_result blocks → SSE { type: 'tool_result' }
    case 'stream_event' → 实时文本增量 → SSE { type: 'text' } / { type: 'thinking' }
    case 'tool_progress' → 工具进度 → SSE { type: 'tool_output' }
    case 'result'       → 最终结果 + token usage → SSE { type: 'result' }
    case 'system'       → 初始化元数据/模式切换 → SSE { type: 'status' }
  }
}
```

### SSE 事件类型（CodePilot 自定义格式）

| SSE type | 含义 | 来源 SDK message type |
|----------|------|----------------------|
| `text` | 文本增量 | `stream_event` |
| `thinking` | 思考增量 | `stream_event` |
| `tool_use` | 工具调用开始 | `assistant` |
| `tool_result` | 工具执行结果 | `user` (tool_result) |
| `tool_output` | 工具实时输出 | `tool_progress` / stderr |
| `permission_request` | 权限请求 | `canUseTool` 回调 |
| `status` | 状态信息 | `system` / 内部事件 |
| `result` | 完成 + usage | `result` |
| `error` | 错误 | 异常处理 |
| `task_update` | 任务更新 | `system` (task_notification) |
| `mode_changed` | 模式切换 | `system` (mode_change) |
| `rewind_point` | 回退点 | `user` (prompt-level) |
| `keepalive` | 心跳 | 定时发送 |

### SDK `query()` 内部自动处理的事项

1. Agent Loop（tool_use → execute tool → tool_result → continue 直到完成）
2. 工具定义和执行（Read, Write, Edit, Bash, Glob, Grep 等内置工具）
3. MCP 服务器连接和工具发现
4. 权限检查和交互
5. 上下文管理和自动压缩
6. 会话恢复（resume）
7. Skills 加载和执行
8. 系统提示拼装

---

## 2. Vercel AI SDK `streamText` 的 Agent Loop 能力

### CodePilot 已有用法

`src/lib/text-generator.ts` 使用 `streamText` 进行纯文本生成（无 tools），支持 5 个 provider：
- `@ai-sdk/anthropic`
- `@ai-sdk/openai`
- `@ai-sdk/google`
- `@ai-sdk/amazon-bedrock`
- `@ai-sdk/google-vertex/anthropic`

### streamText 的 Agent Loop 能力

`streamText()` 原生支持 agentic loop：

```typescript
streamText({
  model: anthropic('claude-sonnet-4-20250514'),
  system: '...',
  messages: [...],
  tools: {
    readFile: tool({
      description: 'Read a file from the filesystem',
      parameters: z.object({ path: z.string() }),
      execute: async ({ path }) => { ... },
    }),
  },
  maxSteps: 50,           // 自动循环次数上限
  toolChoice: 'auto',     // 'auto' | 'required' | 'none'
  maxOutputTokens: 16384,
  abortSignal: controller.signal,
  onStepFinish: ({ stepType, toolCalls, toolResults, usage }) => { ... },
});
```

当设置了 `tools` + `maxSteps > 1`：
1. 模型生成 `tool_use` → SDK **自动调用** tool 的 `execute` 函数
2. 获得 tool result → **自动拼接**到消息历史
3. 再次调用模型（带 tool_result）
4. 重复直到：模型不再调用 tool / 达到 maxSteps / stop_reason = 'end_turn'

### fullStream 事件类型

| 事件类型 | 说明 |
|---------|------|
| `start` | 流开始 |
| `text-delta` | 文本增量 |
| `reasoning-start` / `reasoning-delta` / `reasoning-end` | 思考（Anthropic 特有） |
| `tool-input-start` / `tool-input-delta` / `tool-input-end` | 工具输入增量 |
| `tool-call` | 工具调用（输入完整） |
| `tool-result` | 工具执行结果 |
| `start-step` / `finish-step` | 步骤边界（含 usage） |
| `finish` | 整体完成 |
| `error` | 错误 |

---

## 3. OpenCode Agent Loop 实现细节

### 架构

OpenCode 采用**两层循环**：

**外层循环**（`prompt.ts`）：
- 管理会话生命周期：创建 message、检查是否需要 compaction、处理 agent steps
- 每次 `processor.process()` 返回后决定 continue / stop / compact

**内层循环**（`processor.ts`）：
- `SessionProcessor.create()` 创建 processor
- `processor.process(streamInput)` 调用 `LLM.stream(streamInput)` 获取 fullStream
- 消费 fullStream 事件，更新 DB parts
- 返回 `"continue"` / `"stop"` / `"compact"`

**LLM 层**（`llm.ts`）：
- 直接调用 `streamText()` with tools
- **不使用 maxSteps** — 由外层循环控制

### 关键设计决策

**1. 不依赖 maxSteps，自建循环**

每次 `streamText()` 只做一次 API 调用。原因：需要在每步之间做：
- 权限检查（doom loop detection）
- DB 持久化
- Context overflow 检测
- 错误重试
- Cost 计算

**2. Tool 定义与执行**

工具在 `tool()` 的 `execute` 回调中执行，包含权限检查：
```typescript
const result = await PermissionNext.ask({ ... })
if (result.denied) throw new PermissionNext.RejectedError()
```

**3. 消息格式**

使用 Vercel AI SDK 的 `ModelMessage` 格式，自动兼容所有 provider。

---

## 4. 从 SDK query() 到 streamText() 的映射

### 概念映射

| Claude Agent SDK (`query()`) | Vercel AI SDK (`streamText()`) |
|------------------------------|-------------------------------|
| `options.model` | `model` (via `@ai-sdk/*`) |
| `options.systemPrompt` | `system` 参数 |
| `options.cwd` | Tool execute 闭包变量 |
| `options.mcpServers` | 自建 MCP client → 转为 tools |
| `options.permissionMode` | Tool execute 中的权限逻辑 |
| `options.resume` | 从 DB 加载历史传入 messages |
| `options.canUseTool` | Tool execute 中的权限检查 |
| `options.thinking` | `providerOptions.anthropic.thinking` |
| `options.effort` | `providerOptions.anthropic.effort` |
| `options.settingSources` | 不需要 |
| `options.pathToClaudeCodeExecutable` | 不需要 |
| `options.env` | 不需要（直接用 API key） |
| SDK `conversation.resume()` | 从 DB 重建 messages array |

### SSE 事件映射

| fullStream event | CodePilot SSE type |
|------|------|
| `text-delta` | `text` |
| `reasoning-delta` | `thinking` |
| `tool-call` | `tool_use` |
| `tool-result` | `tool_result` |
| tool execute 内部事件 | `tool_output`（需自建 EventEmitter） |
| 权限检查 | `permission_request` |
| `finish` | `result` |
| `error` | `error` |

---

## 5. 改动点清单

### 核心 Agent Loop

| 文件 | 动作 | 说明 |
|------|------|------|
| `src/lib/agent-loop.ts` | 新建 | Agent Loop async generator |
| `src/lib/ai-provider.ts` | 新建 | 统一 provider 工厂 |
| `src/lib/agent-tools.ts` | 新建 | 工具组装层 |
| `src/lib/agent-system-prompt.ts` | 新建 | 系统提示拼装 |
| `src/lib/claude-client.ts` | 修改 | 增加自建路径分支 |
| `src/lib/provider-resolver.ts` | 修改 | 新增 toAiSdkConfig() |
| `src/lib/text-generator.ts` | 修改 | 复用 ai-provider.ts |
| `src/app/api/chat/route.ts` | 微调 | 传入 provider config |

### 可删除的逻辑

- `agent-sdk-capabilities.ts` 中依赖 SDK Query 对象的能力缓存
- `conversation-registry.ts` 中跟踪 SDK conversation 的逻辑
- `claude-client.ts` 中 `pathToClaudeCodeExecutable` 和 `resolveScriptFromCmd()` 逻辑

### 不需要改动

- 前端组件（useSSEStream.ts, stream-session-manager.ts, ChatView.tsx）— SSE 格式兼容
- 数据库 schema — 不变
