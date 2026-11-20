# Phase 6 Context Breakdown — 数据审计

> 创建：2026-05-19
> 关联执行计划：`docs/exec-plans/completed/phase-6-context-visualization.md`
> 数据契约实现：[`src/lib/context-breakdown.ts`](../../src/lib/context-breakdown.ts)
> 单元测试：[`src/__tests__/unit/context-breakdown.test.ts`](../../src/__tests__/unit/context-breakdown.test.ts)

## 用途

Phase 6 Phase 0「数据审计」的固化结果。给后续 Phase 1b/1c/2/3 实施者一个"哪一类 `ContextBreakdownKind` 的 tokens 从哪里来"的事实快照。本文档由 Explore agent 精读源码后产出，未来真实改动以代码现状为准（memory 法则——验证当前文件再行动）。

## ContextBreakdownKind 数据出口（10 类）

| Kind | 数据出口 | 状态 |
|------|---------|------|
| `system_prompt` | `src/lib/harness/context-compiler.ts:577-625` — `CompiledContext.systemPromptText` 组装链 | 完整可用 |
| `tools` | `src/lib/harness/context-compiler.ts:234, 472-548` — `toolDescriptors[]` per-capability | 元数据可用；tokens 估算用 char/4（已存在 `context-estimator.roughTokenEstimate`） |
| `rules` | `src/lib/harness/context-compiler.ts` — `workspaceFragments[]` | 未完全落地；Phase 1a 默认 tokens=0，等 1b 真实接入 |
| `skills` | `src/lib/harness/harness-bundle.ts:111-130` — `UserHarnessExtension[]` + `ExternalFrameworkHarnessRef[]` (kind=`skill`) | 元数据可用；缺 tokens 估算 |
| `mcp` | `src/lib/harness/harness-bundle.ts` — `BuiltinCapabilityMount.exposureKind==='mcp_server'` + `UserExtensionKind=='mcp_server'` | 元数据可用；缺 tokens 估算 |
| `memory` | `src/lib/harness/context-compiler.ts:405-438` — `MemoryFragment[]` per-entry 已带 tokens | 完整可用（char/4 估算）|
| `files_attachments` | `src/components/chat/MessageInput.tsx:782-800` — `attachmentPendingTokens` + `mentionTokens` + `directoryTokens` | 完整可用，pending tokens |
| `conversation` | `src/lib/context-usage-walk.ts:56-111` — `baseline.used` residual（减去其它 used 部分）| 完整可用 |
| `pending_next_turn` | composer 纯文本估算（暂未 wire） | Phase 1a 默认 tokens=0 |
| `cache_or_previous` | `src/lib/context-usage-walk.ts:73-75` — `baseline.cacheReadTokens / cacheCreationTokens` | 完整可用 |

## 现有 hook / lib 接口快照

- **`useContextUsage(messages, modelName, options)`** → `ContextUsageData{ used, ratio, estimatedNextTurn, cacheReadTokens, cacheCreationTokens, outputTokens, source, state }`
  - Phase 1a 不动它；Phase 1b 会让它旁路调用 `buildContextUsageBreakdown` 并在返回里加 `breakdown` 字段。
- **`walkContextUsage(messages)`** → `{ baseline, latestSdkContextWindow }`，纯函数。
- **`estimateContextTokens(params)`** 提供 char/4 估算，已被 context-compiler 复用。

## MessageInput pending tokens 现状

- 当前 sources：`attachmentPendingTokens`（来自 PromptInput `AttachmentPendingTracker`）+ `mentionTokens`（`useMentionTokenEstimate`）+ `directoryTokens`（同 hook 的 synthetic version）。
- 当前暴露给父组件：单一 callback `onPendingContextTokensChange?: (tokens: number) => void`（总数，无 breakdown）。
- Phase 1c 会新增可选 `onPendingContextBreakdownChange?: (parts: Pick<ContextBreakdownPart, 'kind' | 'tokens'>[]) => void` 把 sub-totals 暴露给父组件。

## RunCockpit / RunCockpitPopoverContent / ContextUsageIndicator 现状

- `RunCockpit.tsx:175-177` trigger：百分比文字或 token 数 + ring SVG 环形图（0-100% 圆周）。
- `RunCockpitPopoverContent.tsx:88-410` popover body：`ContextContentHeader` + `ContextContentBody` 包 `ContextInputUsage / ContextOutputUsage / ContextCacheUsage`（来自 `@/components/ai-elements/context`）。
- `ContextUsageIndicator.tsx` 用同样的 ai-elements/context 原语，但通过 HoverCard 而不是 popover。
- Phase 2 改造范围：trigger 视觉换点阵；body 内容换 10 类 breakdown 列表。不新增第三套平行入口。

## Phase 1a 范围（本次实施）

- 新文件 `src/lib/context-breakdown.ts`：纯数据契约 + `buildContextUsageBreakdown()` 函数
- 新单元测试 `src/__tests__/unit/context-breakdown.test.ts`：覆盖 ordering / 累加不变量 / 负数 clamp / unknown window / pending 不污染 / cache 计入 conversation 减项
- **不动**`useContextUsage` / `MessageInput` / `RunCockpit*` —— 这些 wire-up 留给 Phase 1b/1c 跟 Phase 2 UI 改造一起做，避免引入暂时无消费者的 props

## 后续子阶段（暂不实施）

- **Phase 1b**：`useContextUsage` 旁路调用 `buildContextUsageBreakdown`，把 `breakdown` 加入返回字段
- **Phase 1c**：`MessageInput` 新增可选 `onPendingContextBreakdownChange` callback
- **Phase 2**：在现有 `ContextUsageIndicator` / `RunCockpit` / `RunCockpitPopoverContent` 链路里替换 trigger 视觉和 body 分类内容
- **Phase 3**：Chat / page.tsx 两入口都传入同一 pending breakdown

## StreamSession guardrail 合规

- `docs/guardrails/StreamSession.md` 不变量 #1：首消息 `page.tsx` 和后续 `ChatView.tsx` 各自独立管理 effort / thinking / runtime override。Phase 1c 新增 callback 默认 `undefined`，不影响双入口独立状态管理。
- 不变量 #2（rewind point 规则）：本次改动不动 `onSend` / `onCommand` 签名，不影响 rewind point 发出规则。
- 不变量 #3（capability cache per-provider）：本次只读 compiler / harness-bundle 输出，不改 capability cache。
