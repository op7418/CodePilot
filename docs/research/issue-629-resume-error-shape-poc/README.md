# Issue #629 — resume 坏 session 的 error shape POC

> 关联执行计划：[docs/exec-plans/active/v0.56.x-stability-trust.md](../../exec-plans/active/v0.56.x-stability-trust.md) Phase 2 Session/Stream cluster（#629）
> 看板：[docs/exec-plans/active/issue-tracker.md](../../exec-plans/active/issue-tracker.md) `#629`（🟡 残留 gap）
> 状态：**已关闭（🟢，2026-06-26）。** POC-A（源码层）+ driver `--selftest` 5/5 绿；POC-B 4 个第三方 proxy 一致返回 `B_RESULT_ERROR` + 可判别 `errors[]`；修复 claude-client + route 双层落地（见下「修复已落地」+「复审 follow-up」），**Codex 端到端 smoke 通过：两轮坏 resume → 第二轮 fresh、不再 `No conversation found`**。
> 三层写法（遵守 research 文档纪律）：A 外部事实（SDK 类型，含 file:line + 快照）/ B repo facts（file:line）/ C 推断与设计。刻意放 `docs/research/`、不进 `src/`，不触产品测试文件清单。

## 一句话结论

#629 的 gap 真实存在（坏 sdk_session_id 在 is_error **result** 路径不被清，留到下一轮重试坏 resume）。**修复的判别器不能用 `result.subtype`**——它只有 4 个通用枚举、无 session 语义；**真实 POC-B 已确认唯一可用判别源是 `SDKResultError.errors: string[]`**。GLM / MiMo Token Plan / DeepSeek / Aliyun Bailian 四个第三方 Anthropic-compatible proxy 全部返回同一形态：第一条消息就是 `is_error result`，`errors[0] = "No conversation found with session ID: <bad sid>"`。因此修复应在 is_error result 分支读取 `errors[]`，把该文案归入 `RESUME_FAILED`/session-state 类后只清坏 session id；不能无脑清所有 is_error。

---

## 快照固定

| 对象 | 版本 / 日期 | 来源 |
|------|------------|------|
| `@anthropic-ai/claude-agent-sdk` | 0.2.111 | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（仓库现装） |
| 产品源 HEAD | `223a796`（v0.56.x 文档同步后）| 本仓库 |
| node | 运行机现装（driver 为纯 ESM，无版本绑定） | — |
| 记录日期 | 2026-06-26 | 本 POC |

---

## A. 外部事实 —— Claude Agent SDK 的 result 类型（sdk.d.ts，已核实）

`SDKResultMessage = SDKResultSuccess | SDKResultError`（`sdk.d.ts:2732`）。

**`SDKResultError`（`sdk.d.ts:2713-2730`）关键字段：**

- `subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`（`sdk.d.ts:2715`）—— **4 个通用枚举，无任何 session 语义**。resume-400 几乎必然落 `error_during_execution`。
- `is_error: boolean`（`:2718`）
- `stop_reason: string | null`（`:2720`）
- **`errors: string[]`（`:2725`）—— 唯一可能携带具体错误文本的字段。**
- `permission_denials: SDKPermissionDenial[]`（`:2724`）
- `session_id: string`（`:2729`）

对照 `SDKResultSuccess`（`sdk.d.ts:2734-2756`）：它多一个 `api_error_status?: number | null`（`:2738`）和 `result: string`，但 `SDKResultError` **没有** `api_error_status`、**没有** `result`、也没有任何 message/detail 字符串字段——错误细节只可能在 `errors[]`。

> 含义：任何"看 subtype 判 session-state vs transient"的修复都走不通。判别只能基于 `errors[]` 文本（或非文本旁证）。

## B. repo facts（file:line，当前 HEAD）

**gap 因果链（未防护）：**

1. `claude-client.ts:1922-1932` result event 只透传 `subtype / is_error / num_turns / duration_ms / usage / session_id / terminal_reason`——**没透传 `errors[]`，也没透传 `stop_reason`**。
2. `claude-client.ts:1932` `resultEmitted = true`（注释 `#577 — turn succeeded; suppress any post-result error`）。任何 result（含 is_error result）走到这都会先置位。
3. `claude-client.ts:1934-1945` is_error 分支只发 `status` 通知 + （非 autoTrigger 时）Telegram，`errMsg = resultMsg.subtype`（即 `error_during_execution` 这种词）——**分支内无 `updateSdkSessionId`**。
4. `claude-client.ts:2348` 兜底清理 `if (sessionId && !resultEmitted) updateSdkSessionId(sessionId,'')`——因 step 2 的 `resultEmitted=true` 被跳过。
   → 坏 `sdk_session_id` 留到下一轮，下条消息再用它 resume，再 400。

**已防护的相邻路径（不要重复修）：**

- 抛错路径：`claude-client.ts:1568-1595`——resume peek（`await iter.next()`）throw 时 catch 清 `sdk_session_id('')` + enqueue `resumeFallback` status + 删 `resume` 重起 fresh。
- 空 assistant：`route.ts:980-982`——`hasError && contentBlocks.length === 0 && errorMessage` 时落 `**Error:** <msg>` 文本气泡，不存空消息。
- 真 crash（非 result）：`claude-client.ts:2319/2348` 的 `!resultEmitted` 分支会清 id（只对没出过 result 的 turn）。

**判别器现状：**

- `classifyError(ctx: ErrorContext)`（`error-classifier.ts:370`）入参 `ctx.error: unknown`（`:123`）+ `ctx.stderr`，内部 `searchText = rawMessage + stderr + extraDetail`（`:379`）做关键词/正则匹配。**不接收 result.subtype**——要复用它判别 is_error result，必须把 `errors.join('\n')` 当 `ctx.error` 喂进去。
- `RESUME_FAILED` patterns（`error-classifier.ts:~295`）：`resume failed / session not found / invalid session / session expired / could not resume / failed to resume / resume_failed / conversation not found` + regex。
- `SESSION_STATE_ERROR` patterns（`error-classifier.ts:~318`，`retryable:true`）：`stale session / stale sdk_session / session state / corrupt session / session mismatch / session context` + regex。
- `claude-client.ts` 全文 grep `resultMsg.`：只命中 `subtype/is_error/num_turns/duration_ms/session_id`，**确认 `errors[]` 从未被读**。

**降低"清 id 会丢上下文"风险的事实：**

- `docs/research/session-management-and-context-compaction.md`（已删除，见 git 历史）：CodePilot 已有完整 DB-based fallback（`buildFallbackContext`），SDK resume 只是优化非必需。清掉坏 `sdk_session_id` 后下一轮用 DB 历史（最近 200 条）重建——**大部分上下文仍在**，损失的是 SDK 端增量/压缩态。这降低（但未消除）误清 transient 的代价，故仍需判别、不可无脑清。

## C. 推断与设计（待 POC-B 验证后落地）

**核心未知（只能真实跑定）：**

1. 坏 resume → SDK 是 **(A) throw**（→ 已被 `1568` catch 处理，#629 对该 provider 不成立）还是 **(B) is_error result**（→ gap）？
   - 预期：**第一方 Anthropic** 倾向 (A)——本地 claude CLI 在 `~/.claude/projects/` 找不到该 session 的 JSONL，很可能本地就拒绝/抛错，不发 API。
   - 预期：**第三方 proxy**（`ANTHROPIC_BASE_URL` 指向 GLM/MiMo 等）倾向 (B)——proxy 无真正 session 概念，带 session 的请求被回 400，可能以 result 形态回到 SDK。#629 报告者大概率是这条。
2. 若是 (B)，`errors[]` 里**到底是什么字符串**？含 `session/resume/400/not found` → 可判别（`fix viable via errors[]`）；只有泛化文本或为空 → 不可判别，需非文本旁证。

**修复设计提案（三种 errors[] 情形分支，待 POC-B 落定走哪条）：**

- 在 `claude-client.ts:1934` is_error 分支，读 `resultMsg.errors`：
  - **errors[] 含 session 信号** → `classifyError({ error: errors.join('\n'), providerName, baseUrl })` ∈ {`RESUME_FAILED`,`SESSION_STATE_ERROR`} 时 `updateSdkSessionId(sessionId,'')`；transient（`RATE_LIMITED`/`AUTH`/`BUDGET`）保留。**这是首选——精确、不误清。**
  - **errors[] 为空但可用非文本旁证** → 退化判据：该 turn 是 resume turn（`shouldResume` 为真）+ 首个 result 即 is_error + 零 assistant 输出 → 推断 resume 失败 → 清。比关键词弱，但仍优于无脑清。
  - **两者皆无** → 不动 id，只把 `errors[]`/`stop_reason` 透传进 result event 供诊断，issue 重定向到 proxy-400 诊断簇。
- 顺带（对齐 Phase 2「诊断导出字段」待办）：把 `errors` + `stop_reason` 加进 `1922-1932` 的 result event payload——无论判别走哪条，这都让 #629/#635 这类会话故障可观测。

**为什么不直接"is_error 就清"**：`error_during_execution` 同样覆盖限流/认证/预算等 transient（见 `SDKResultError.subtype` 仅 4 枚举、不区分）。无脑清会在每次限流/鉴权抖动后强制开新 session，丢 SDK 端上下文——正是 selftest `is_error+transient` 用例锁定的回归。

---

## 如何真实验证（POC-B）

driver：[`drive-resume-error-shape.mjs`](drive-resume-error-shape.mjs)。peek 第一条消息的方式与 `claude-client.ts:1556-1568` 逐字对齐（`conversation[Symbol.asyncIterator]()` → `iter.next()`），故结论可直接迁移到产品路径。

**安全/成本**：凭据只从 env 读、不硬编码、只打掩码尾部；cwd 强制临时目录；`maxTurns:1` + `permissionMode:'plan'`。坏 resume 在模型 turn 真正开始前就失败 → 真实跑 ~零成本，cap 只是兜底。

```bash
# 1) selftest（零凭据零网络，已通过）
node docs/research/issue-629-resume-error-shape-poc/drive-resume-error-shape.mjs --selftest

# 2) LIVE 第三方 proxy（最可能复现 #629 的 400）
ANTHROPIC_API_KEY=... ANTHROPIC_BASE_URL=https://your-proxy/v1 MODEL=glm-5-turbo \
  node docs/research/issue-629-resume-error-shape-poc/drive-resume-error-shape.mjs

# 3) LIVE 第一方（预期 (A) 本地 throw，~免费）
ANTHROPIC_API_KEY=sk-ant-... \
  node docs/research/issue-629-resume-error-shape-poc/drive-resume-error-shape.mjs
```

driver 把结局归为 `A_THROW_AT_PEEK` / `B_RESULT_ERROR` / `C_RESULT_SUCCESS` / `D_NO_RESULT_MESSAGE`，对 B 额外 dump `errors[]` 全文并给 `verdict`（errors[] 能否判别）。

## selftest 结果（2026-06-26，5/5 绿）

| 用例 | outcome | sessionSignal | verdict 摘要 |
|------|---------|---------------|--------------|
| throw-at-peek | `A_THROW_AT_PEEK` | true | 已被 1568 catch 处理 |
| is_error + session 信号 | `B_RESULT_ERROR` | true | **errors[] 可判别 → fix viable via errors[]** |
| is_error + transient | `B_RESULT_ERROR` | false | 正确保留 id（避免限流/鉴权回归） |
| is_error + 空 errors | `B_RESULT_ERROR` | false | 无文本信号 → 需非文本旁证 |
| 意外 success | `C_RESULT_SUCCESS` | false | provider 容忍坏 id，重选无效 id |

> selftest 证明的是**探测/分类逻辑**正确（覆盖全部 4 种 live 结局），不是 #629 已修。真实结局取决于 POC-B 跑出来的 outcome + errors[] 内容。

## POC-B live 结果（2026-06-26，真实第三方 proxy）

运行方式：从本机 CodePilot DB 读取已有 provider key 注入 env，driver 只打印 key 尾部掩码；`BAD_SESSION_ID` 使用默认假 UUID `00000000-0000-4000-8000-000000000629`；`maxTurns:1` + `permissionMode:'plan'` + 临时 cwd。未改产品代码。

| Date | base_url 形态 | Model | outcome | errors[] 摘要 | 能否判别 |
|------|---------------|-------|---------|---------------|----------|
| 2026-06-26 | GLM CN Anthropic proxy (`https://open.bigmodel.cn/api/anthropic`) | `glm-5-turbo` | `B_RESULT_ERROR` | `No conversation found with session ID: 00000000-0000-4000-8000-000000000629` | **可以**。语义明确是坏/不存在会话；当前 driver / `error-classifier.ts` 的近似 pattern 未命中，因为已有 `conversation not found` 顺序相反，需补 `no conversation found` 或 regex。 |
| 2026-06-26 | Xiaomi MiMo Token Plan Anthropic proxy (`https://token-plan-cn.xiaomimimo.com/anthropic`) | `mimo-v2-pro` | `B_RESULT_ERROR` | 同上 | **可以**。同一 SDK error shape。 |
| 2026-06-26 | DeepSeek Anthropic proxy (`https://api.deepseek.com/anthropic`) | `deepseek-v4-flash` | `B_RESULT_ERROR` | 同上 | **可以**。同一 SDK error shape。 |
| 2026-06-26 | Aliyun Bailian Token Plan Anthropic proxy (`https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`) | `glm-5` | `B_RESULT_ERROR` | 同上 | **可以**。同一 SDK error shape。 |

关键观察：

- 四个第三方 proxy 结论完全一致：坏 resume **不是 throw**，而是 **第一条消息即 `result`，`subtype='error_during_execution'`，`is_error=true`，`num_turns=0`，`errors.length=1`**。
- `errors[]` 原文足以判别 session-state/resume 失败，但现有 pattern 还缺这个 exact wording。当前 `RESUME_FAILED` 有 `conversation not found` 和 `/session\s+id\s+.*\s*(invalid|expired|not found|missing)/`，都不匹配 `No conversation found with session ID: ...`。修复时应补 `no conversation found` 或更稳的 `/no conversation found.*session id/`。
- 第一方 Anthropic 对照未跑：当前 shell env 与本机 CodePilot DB 未发现可用第一方 `ANTHROPIC_API_KEY`。这不阻塞 #629 第三方 proxy 修复，因为用户报告路径和四个实测 proxy 都已坐实最坏路径 `B_RESULT_ERROR`。

修复落点建议（交 Claude Code 实施）：

1. `claude-client.ts` 的 is_error result 分支读取 `resultMsg.errors ?? []`，并把 `errors.join('\n')` 传给 `classifyError`。
2. `error-classifier.ts` 的 `RESUME_FAILED` patterns 补 `no conversation found` / `no conversation found.*session id`，确保上述真实文案命中。
3. 分类为 `RESUME_FAILED` 或 `SESSION_STATE_ERROR` 时清 `sdk_session_id`；`RATE_LIMITED` / `AUTH_*` / `BUDGET` 等 transient 保留。
4. result event 透传 `errors` 与 `stop_reason`，否则 UI / 日志仍只能看到泛化 `error_during_execution`，后续 #629/#635 诊断会继续失明。

---

## 修复已落地（2026-06-26，Claude Code 实施，全绿）

按上述 4 条建议实施，逐条对账：

1. ✅ `error-classifier.ts` `RESUME_FAILED` 补 `'no conversation found'`（baseline 实测：真实文案改前归 `UNKNOWN`、改后 `RESUME_FAILED`；现有 `'conversation not found'` 词序相反、session-id regex 要求 "not found" 在 id 后，均不命中）。
2. ✅ 新增纯函数 `isSessionStateResultError(errors, ctx)`：`errors.join('\n')` 喂 `classifyError`，仅 `RESUME_FAILED`/`SESSION_STATE_ERROR` → true，空/null → false。
3. ✅ `claude-client.ts` is_error result 分支读 `resultMsg.errors`（cast，`SDKResultSuccess` 无 `errors[]`），`sessionId && isSessionStateResultError(...)` 时 `updateSdkSessionId(sessionId,'')`；transient（限流/鉴权/预算）保留。**正交于 #577**：#577 的 `!resultEmitted` gate 在 post-result catch（管成功 result 后噪音），本修复在 is_error result 分支内（管 result 本身是坏 resume）。
4. ✅ result event 透传 `errors`（仅 is_error 且非空）/ `stop_reason`。

Guardrail：`src/__tests__/unit/issue-629-resume-session-clear.test.ts`（12 例：classifier 真实文案 → RESUME_FAILED + helper transient 不清回归守卫 + claude-client wiring source-pin）。全量 `npm run test` **3415/3415**、`tsc --noEmit` 0、`stream-result-error-guard`(#577) 仍绿。**仍待**：Codex 复审 + 真实 app resume-recovery smoke（坏 resume 后同会话下一条能正常发）；第一方对照未跑（throw 路径本就被 `claude-client.ts:1568` catch 覆盖，非阻塞）。

### 复审 follow-up（2026-06-26，Codex 真实 route smoke）— 端到端仍复发，补 route 持久化 P1/P2

Codex 用临时 DB 做真实 route smoke：claude-client 清了 `sdk_session_id`，但 **result SSE 已带 `session_id` 先 enqueue**（`claude-client.ts:1931`），`/api/chat` 消费时 `route.ts:937` **无条件写回** `resultData.session_id` → 覆盖清理；第二轮同会话仍带 `00000000-…-629`，再报 `No conversation found`，"会话发不出去"仍在。两个 finding 已补：

- **P1**（`route.ts` result 分支）：`if (resultData.is_error && isSessionStateResultError(resultData.errors)) updateSdkSessionId(sessionId, '')`，否则才写回 `resultData.session_id`。坏 id 不再被写回覆盖；transient is_error 的有效 session_id 仍正常写回。
- **P2**（同处）：is_error result 时把 `resultData.errors?.join('\n') || resultData.subtype` 写入 `errorMessage`，让既有 empty-assistant guard（`route.ts:980`）落 `**Error:**` 气泡——否则失败首轮刷新后像"没回答"。

Guardrail 追加 route.ts source-pin（P1 clear-not-writeback + P2 errorMessage）。全量 `npm run test` **3418/3418**、tsc 0、`codex-proxy-error-visibility` / `stream-result-error-guard` 仍绿。**教训**：清 `sdk_session_id` 的 DB writer 不止 claude-client 一处，route 的 SSE 消费是另一个 writer——「fix all consumers」必须含跨进程的持久化 writer，不能只看产生方（上轮只 sweep 了 claude-client 内部 retry path，漏了 route，premature-solved 第二次）。**待 Codex 复跑端到端 smoke 确认**：两轮坏 resume → 第二轮 fresh、不再 `No conversation found`。
