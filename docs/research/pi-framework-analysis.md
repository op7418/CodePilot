# Pi AI 框架调研

> 创建时间：2026-04-06
> 源码位置：/Users/op7418/Documents/code/资料/pi-mono-main
> 关联执行计划：decouple-claude-code

## 1. 架构概览

**技术栈：** TypeScript / Node.js 20+ / ESM / biome linting

**Monorepo 结构（7 个包）：**

| 包 | 用途 |
|----|------|
| `ai` | 统一多 Provider LLM 抽象层 |
| `agent` | Agent 运行时（状态管理 + 工具执行 + 事件流） |
| `coding-agent` | 交互式编码 Agent CLI（工具 + 扩展 + 会话管理） |
| `tui` | 终端 UI 库（差分渲染） |
| `web-ui` | Web 聊天组件 |
| `mom` | Slack Bot（委托给 coding-agent） |
| `pods` | vLLM GPU Pod 部署管理 |

---

## 2. 多 Provider 支持（最大亮点）

### 底层 API 适配器（10 个）

Pi 注册了 10 个底层 API 适配器（`registerApiProvider` 调用）：

1. `anthropic-messages`
2. `openai-completions`
3. `openai-responses`
4. `azure-openai-responses`
5. `openai-codex-responses`
6. `mistral-conversations`
7. `google-generative-ai`
8. `google-gemini-cli`
9. `google-vertex`
10. `bedrock-converse-stream`

很多 Provider（Groq、xAI、Cerebras、OpenRouter 等）通过 `openai-completions` 兼容层接入，不是独立适配器。

### API Key Provider（16+）

providers.md 列出：Anthropic, Azure OpenAI, OpenAI, Google Gemini, Mistral, Groq, Cerebras, xAI, OpenRouter, Vercel AI Gateway, ZAI, OpenCode Zen/Go, Hugging Face, Kimi For Coding, MiniMax 等。

### OAuth 订阅 Provider（5 个）

| Provider | OAuth 实现文件 | 说明 |
|---------|--------------|------|
| Claude Pro/Max | `oauth/anthropic.ts` | Anthropic OAuth |
| ChatGPT Plus/Pro | `oauth/openai-codex.ts` | Browser-based OAuth |
| GitHub Copilot | `oauth/github-copilot.ts` | Token-based |
| Google Gemini CLI | `oauth/google-gemini-cli.ts` | CLI OAuth |
| Google Antigravity | `oauth/google-antigravity.ts` | OAuth |

**OAuth 接口：**
```typescript
interface OAuthProviderInterface {
  id: OAuthProviderId;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
}
```

OAuth 凭据存储在 `~/.pi/agent/auth/`，支持自动刷新。

### 懒加载注册表模式

`packages/ai/src/providers/register-builtins.ts` 使用 `||=` 惰性赋值：
```typescript
anthropicProviderModulePromise ||= import("./anthropic.js").then(...)
```

`createLazyStream()` 工厂函数包装懒加载逻辑，Provider 仅在首次使用时加载（减少启动开销）。

### 统一 Stream 接口

```typescript
type StreamFunction<TApi, TOptions> = (
  model: Model<TApi>,
  context: Context,    // { systemPrompt, messages, tools }
  options?: TOptions,
) => AssistantMessageEventStream;
```

所有 Provider 遵守同一接口，context 包含 systemPrompt + messages + tools。

---

## 3. Streaming 事件协议

**`AssistantMessageEvent` 事件类型：**

| 事件 | 说明 |
|------|------|
| `start` | 响应开始 |
| `text_start` / `text_delta` / `text_end` | 文本块 |
| `thinking_start` / `thinking_delta` / `thinking_end` | 思考块 |
| `toolcall_start` / `toolcall_delta` / `toolcall_end` | 工具调用（含渐进 JSON 解析） |
| `done` | 完成（含 stop reason） |
| `error` | 错误 |

**渐进 JSON 解析：** 工具调用的参数在流式传输过程中被逐步解析，实现实时 UI 更新。

---

## 4. Agent Loop

文件：`packages/agent/src/agent-loop.ts`

**流程：**
```
LLM 生成 assistant message（含 tool_use）
  → beforeToolCall hook（可 block）
  → 并行/串行执行工具
  → afterToolCall hook（可修改结果）
  → 工具结果加入 context
  → 循环继续
```

**独特能力：**
- **Steering**：在工具执行期间向 Agent 插入消息
- **Follow-up**：在 Agent 完成后追加消息触发新轮次
- **并行执行**（默认）：preflight 串行，实际执行并行
- **工具参数验证**：TypeBox schema + AJV

### Agent 状态

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly pendingToolCalls: ReadonlySet<string>;
}
```

### Agent 事件

```typescript
type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message }
  | { type: "message_update"; assistantMessageEvent }
  | { type: "message_end"; message }
  | { type: "tool_execution_start"; toolCallId, toolName, args }
  | { type: "tool_execution_update"; partialResult }
  | { type: "tool_execution_end"; result }
  | { type: "turn_end"; message, toolResults }
  | { type: "agent_end"; messages }
```

---

## 5. 工具系统

### 内置工具（8 个文件）

位于 `packages/coding-agent/src/core/tools/`：

| 文件 | 工具 |
|------|------|
| `read.ts` | 文件读取 |
| `write.ts` | 文件写入 |
| `edit.ts` | 文件编辑（行级） |
| `edit-diff.ts` | 文件编辑（diff 模式） |
| `bash.ts` | Shell 执行 |
| `grep.ts` | 内容搜索 |
| `find.ts` | 文件查找 |
| `ls.ts` | 目录列表 |

### 工具定义接口

```typescript
interface ToolDefinition<TParams extends TSchema> {
  name: string;
  description: string;
  parameters: TParams;      // TypeBox schema（非 Zod）
  execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult>;
  renderCall?: (...) => Component;   // TUI 渲染
  renderResult?: (...) => Component;
}
```

**onUpdate 回调**：工具可在执行过程中流式推送进度，用于 UI 实时更新。

---

## 6. MCP 立场

**核心不内置 MCP。** README.md 明确写道：

> "No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."

但 Extension 系统允许社区通过 TypeScript 模块添加 MCP 支持（README 中 extension 能力列表包含 "MCP server integration"），所以 MCP 是**可选的扩展能力**，非内置。

---

## 7. 权限系统

Pi 的权限通过 hook 实现，而非独立权限引擎：

```typescript
beforeToolCall?: (context: BeforeToolCallContext, signal?) 
  => Promise<{ block?: boolean; reason?: string } | undefined>;
```

- 工具可以通过 CLI `--tools read,grep,find,ls` 限制可用工具集
- Extension 可以注册 `beforeToolCall` hook 做细粒度拦截
- 没有内置的规则引擎或 AST 分析

---

## 8. 会话管理

文件：`packages/coding-agent/src/core/session-manager.ts`

**JSONL 树状分支：** 每条消息有 `id` + `parentId`，支持在单个文件中存储多个分支。

```typescript
interface SessionEntryBase {
  type: string;       // "message" | "compaction" | "branch_summary"
  id: string;
  parentId: string | null;
  timestamp: string;
}
```

**会话操作：**
- Continue（`pi -c`）：继续上次会话
- Resume（`pi -r`）：浏览和选择历史会话
- Fork（`/fork`）：从历史任意点分叉
- Tree（`/tree`）：可视化会话树
- Compact（`/compact`）：手动/自动上下文压缩

存储位置：`~/.pi/agent/sessions/`（按项目目录组织）

---

## 9. RPC 模式

Pi 可通过 `--mode rpc` 作为子进程运行，stdin/stdout JSONL 通信：

```
外部进程 → stdin:  {"type":"prompt","text":"find bugs","id":"req-123"}
Pi → stdout:       {"type":"agent_start"} / {"type":"turn_start"} / ... / {"type":"response",...}
```

RPC 实现在 `packages/coding-agent/src/modes/rpc/`（jsonl.ts, rpc-client.ts, rpc-mode.ts, rpc-types.ts）。

**Craft Agents 即通过 RPC 模式接入 Pi** 作为非 Claude 的 Agent 后端。

---

## 10. Extension 系统

Pi 的核心扩展机制——工具、命令、快捷键、UI 组件全部可通过 TypeScript 模块插拔：

- `registerTool()` — 添加或覆盖工具
- `registerCommand()` — 添加 slash 命令
- `registerShortcut()` — 添加键盘快捷键
- `beforeToolCall()` / `afterToolCall()` — 工具执行 hook
- Extension 拥有完整系统访问权限

---

## 11. 与 CodePilot 执行计划的关系

### 值得纳入的方案

| Pi 能力 | 价值 | 建议 |
|---------|------|------|
| **OAuth Provider 支持** | 极高——用户用 ChatGPT/Copilot/Gemini 订阅而非 API Key | 作为后续功能考虑，与"安装即用"目标高度一致 |
| **懒加载 Provider 注册表** | 中——比静态 import 高效 | 参考用于 `ai-provider.ts` |
| **beforeToolCall/afterToolCall** | 中——比单一 checkPermission 更灵活 | 参考用于权限增强 |
| **Steering/Follow-up** | 中——执行期间插入消息 | 未来功能 |
| **Session Tree 分支** | 中——当前 CodePilot 不支持分支 | 未来功能 |

### 不适用的方案

| Pi 特性 | 原因 |
|---------|------|
| TypeBox + AJV | CodePilot 统一用 Zod + Vercel AI SDK |
| 反 MCP 立场 | CodePilot 保留 MCP 支持 |
| 无子 Agent | CodePilot 计划支持子 Agent |
| TUI 渲染 | CodePilot 是桌面 GUI |
