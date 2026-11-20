# Codex SDK tool-call surface — Phase 7.3 调研

> 创建：2026-05-20（Phase 7.3）
> 父计划：`docs/exec-plans/completed/context-accounting-runtime-contract.md` Phase 7（已归档）
> 目的：确认 Codex Runtime 能否给 Phase 7 `ToolInvocationAccumulator` 提供 (toolUseId, toolName, input, resultContent) 这四元组，决定 Codex 走 native API 还是 SSE 兜底。

## 调研结果（一句话）

**Codex 不依赖外部 SDK；现成的 canonical `RuntimeRunEvent` 抽象层就是 native API**，且已经在 `src/lib/codex/runtime.ts:82-134` emit 完整的 `tool_started` / `tool_completed` 事件。Phase 7.5 直接在那些 case 分支里 wire `ToolInvocationAccumulator`，不需要 SDK 调用或 SSE 中转。

## 事实层（带 file:line 引用）

### 1. Codex 不是 npm SDK，是内嵌的 native binary + canonical event abstraction

```text
$ grep '"@?(codex|openai/codex)' package.json
（无匹配）

$ find node_modules -type d -name "codex*"
（无匹配）
```

Codex 通过 `src/lib/codex/` 内的 IPC/SSE bridge 调用本机 Codex CLI 进程，不依赖外部 `codex-sdk` npm 包。所谓"Codex SDK"在 CodePilot 上下文里指的是 **内部 `RuntimeRunEvent` canonical 抽象**（`src/lib/codex/`），不是第三方接口。

### 2. `RuntimeRunEvent` 已经分解 tool 调用为独立事件

`src/lib/codex/runtime.ts:76-134` 的 `canonicalToSseLine(event: RuntimeRunEvent)` 把 Runtime 内部 event 翻译为 SSE 行；其中：

- `case 'tool_started'` (line 82)：`event.toolId / event.name / event.input` — 完整三元组
- `case 'tool_completed'` (line ~89-130)：`event.toolId / event.output / event.error / event.media` — 完整 result 含错误旁路
- `case 'command_started'` (line ~131-134)：把 Bash 命令转 `tool_started` shape (`id: commandId, name: 'Bash', input: { command, cwd }`)

也就是说 Codex Runtime 内部已经按 tool-call/tool-result 拆分清楚，不需要从 SSE 字节流逆向解析。

### 3. 与 ClaudeCode / Native 的 shape 对齐

| Runtime | 事件名 | 字段 |
|---|---|---|
| ClaudeCode | `block.type === 'tool_use'` / `tool_result` | `id` / `name` / `input` / `tool_use_id` / `content` |
| Native | `case 'tool-call'` / `'tool-result'` | `toolCallId` / `toolName` / `input` / `output` |
| Codex | `case 'tool_started'` / `'tool_completed'` | `toolId` / `name` / `input` / `output` |

字段命名有细微差异（`id` vs `toolCallId` vs `toolId`；`content` vs `output`），但**语义完全等价**。Phase 7.0 `ToolInvocationAccumulator` 的 `(toolUseId, toolName, input, resultContent)` 四元组是它们的 LCD。

### 4. Codex `command_started` 事件等价 ClaudeCode `tool_use` name='Bash'

Codex 把 Bash 命令视为独立 event type (`command_started`)，但在 SSE 转换层强制 name='Bash'。Phase 7.5 wire 时直接在 `case 'command_started'` 分支调 `accumulator.recordToolUse(event.commandId, 'Bash', { command: event.command, cwd: event.cwd })`，输出与 ClaudeCode / Native 完全一致。

## 决议

**Phase 7.5 Codex 接通方案：在 `src/lib/codex/runtime.ts` 的 `canonicalToSseLine` 切换语句里 wire ToolInvocationAccumulator**，与 ClaudeCode (claude-client.ts:1585) 和 Native (agent-loop.ts:483) 同一抽象同一入口。

具体位置 + 拍板（待 7.5 实施时调整一次性 wire）：

```ts
// 在 canonicalToSseLine 外部某处持有 accumulator instance（按 turn 实例化）
// 在 case 'tool_started':       accumulator.recordToolUse(event.toolId, event.name, event.input ?? {});
// 在 case 'command_started':    accumulator.recordToolUse(event.commandId, 'Bash', { command: event.command, cwd: event.cwd });
// 在 case 'tool_completed':     accumulator.recordToolResult(event.toolId, stringifyToolResultContent(event.output));
// 在 case 'run_completed':      collectAutoInvokeSnapshot({ records: accumulator.drain(), producedBy: 'codex_runtime', providerBackend, ... })
//                               并嵌入 result event 的 usage.context_accounting（沿用 Phase 4 P2 通道）
```

不需要：
- 等任何外部 `codex-sdk` 升级
- SSE 中转或解析回流
- 与 ClaudeCode 不同的 token 估算逻辑

兜底场景（如果调研有遗漏）：如果某种 Codex provider backend 不经过 `RuntimeRunEvent`，则该 backend 的 records 为空 → `entries.skills/mcp/tools` 全 omit → UI hide。这跟"不假数据"原则一致，不需要额外兜底分支。

## 风险 / 未确认点

1. **`event.input` 是否可能为 undefined**：line 82 用 `event.input ?? {}` 防御，说明 Runtime 自己也认为可能 undefined。Accumulator `recordToolUse(id, name, input)` 接受 unknown，可以 unwrap。
2. **Codex tool_result content 形态**：`stringifyToolResultContent(event.output)` (line ~125) 已经把 object 转字符串。Accumulator 期望 string，复用现有 normalizer 即可。
3. **媒体类 tool_result**：`event.media` 与 token accounting 无关（资源指针不是文本），accumulator 不需要处理。
4. **Codex 多 backend 一致性**：`codex_account / codepilot_proxy / native_app_server` 三个 backend 都经过同一个 `canonicalToSseLine`，所以 wire 一次 cover 全部 — 不需要分支。

## 不在本调研范围

- Codex provider 配置 / OAuth / 凭据管理 — 由 Phase 5e 其他文档负责
- Codex `usage_updated` 事件中的 context window 字段 — 已有 Phase 4 P2 通道处理
- 是否替换现有 `produceCodexAccountingSnapshot` — 是的，Phase 7.5 实施时改造（complete replace by `collectAutoInvokeSnapshot`）
