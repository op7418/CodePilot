# StreamSession Guardrail

> 2026-09-18 Gemini Native：每个已完成 SDK step 通过 `native_step` 保存 canonical response.messages 到 content block 的隐藏 `nativeStep`。只接受 assistant/tool role；桌面 collector 与 bridge 均沿用 owner gate。仅相同 Provider ID + upstream model 回放签名，跨路线/旧记录降级为可见历史；后续未完成 step 必须保留，不能被前一 step 元数据覆盖。UI/摘要不渲染 opaque 元数据，token 估算不重复计算。`length` 结束保留正文并发送本地化桌面截断通知；通知不是持久化的完成质量标记。回归：`gemini-native.test.ts`。

> **Status: Active** — 2026-07-22 因同 Runtime 子 Agent 的 tool stream、历史配对与侧栏 transcript 接线完成首次 on-touch 激活。
> **为什么先读**：聊天主路径——双入口（`/chat` page.tsx 首消息 + `/chat/[id]` ChatView.tsx 后续）必须**独立**管理 effort / thinking / runtime override 并各自向 `/api/chat` 传递。这是上一次 SDK 0.2.111 接入的重灾区，也是即将到来的 Phase 6 上下文可视化的主要触及点。
> **已知关键文件**：`src/lib/claude-client.ts`、`src/lib/stream-session-manager.ts`、`src/hooks/useSSEStream.ts`、`src/app/chat/page.tsx`、`src/components/chat/ChatView.tsx`。

## 词汇表

- `stream-session-manager` — 客户端流会话状态机（startedAt / snapshot / finalMessageContent）。
- `useSSEStream` — Server-Sent Events 解析 hook。
- `rewind point` — prompt-level user message 的回退锚点（不为 tool_result / autoTrigger 触发）。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|--------|--------|
| 1 | `/chat` 首消息和 `/chat/[id]` 后续消息**各自独立**管理 effort / thinking 状态并都传给 `/api/chat`，不依赖跨 page 共享状态 | page.tsx + ChatView.tsx |
| 2 | Rewind point 仅对 prompt-level user message（`parent_tool_use_id === null`）发出；autoTrigger / tool_result 不发 | `useSSEStream.ts` |
| 3 | Capability cache 必须 per-provider（`Map<string, ProviderCapabilityCache>`），所有调用者显式传 providerId | `src/lib/agent-sdk-capabilities.ts` |
| 4 | `Agent` / `Task` 的 tool_use 与 tool_result，以及 Codex 原生 collab 的单次 action start/result，必须保留同一个真实 tool id；历史消息不得改写成 `hist-N` 后丢失归属。Codex collab action id 不是 child thread id，不能拿来充当 Sub-agent identity | `MessageItem.tsx` + Runtime adapter |
| 5 | 子 Agent 在 streaming 与历史两条渲染链都必须从普通 `ToolActionsGroup` 分流；普通工具仍维持原折叠行为 | `StreamingMessage.tsx` + `MessageItem.tsx` |
| 6 | requested model、Runtime-reported selector 与用户可见 effective model 是三个可区分的事实；只有 Runtime 返回真实 breadcrumb 时才填 effective，缺失时不得拿 requested 冒充。若 `sonnet` 等协议槽位已经通过 exact route 校验，应向用户显示 route 的具体模型名（如 Kimi for Coding），同时把原始 selector 保存在 lifecycle/provenance 中；真正 mismatch 不得被归一化掩盖 | `subagent-view.ts` + Runtime adapter |
| 7 | 三条 managed Runtime 的每个 physical child 都必须写入 `subagent_runs` 生命周期事实；Claude/Native 的用户可见 transcript 仍从已持久化 chat tool blocks 重建，Codex bridge call/result 被 proxy 抑制时则以该表为跨回合事实源。Workspace Sidebar 不把 prompt/result 再复制到 localStorage | Runtime child adapter + `workspace-sidebar.ts` + `db.ts` |
| 8 | Claude background Agent 的 `async_launched` 只是运行回执；只有 `task_notification` 的 completed/failed/stopped 才能写终态，同 tool id last-wins 且终态不可被乱序回执覆盖 | `claude-client.ts` + `subagent-status.ts` |
| 9 | 子 Agent 卡片在父输出之后渲染，随正文向下滚动；首轮 `/chat` 在 session 创建后立即绑定真实 sessionId，并允许 Details 拉起 Workspace Sidebar | `StreamingMessage.tsx` + `MessageItem.tsx` + `AppShell.tsx` + `chat/page.tsx` |
| 10 | Claude managed child 的 SDK `subtype=success` 只表示协议拿到 result；`is_error=true` 或 `api_error_status` 失败必须进入 failed。maxTurns / timeout 分别进入 partial / timed_out，错误正文不能把状态抬成 completed | `claude-subagent-mcp.ts` + `subagent-status.ts` |
| 11 | 普通 `tool_result` / spawn acknowledgement 不是子 Agent 终态。managed child 只有 CodePilot 结构化 `status + terminal=true` 才能完成；Codex child 的 app-server `turn.status=completed` 只证明回合结束，任务结果还必须读取 child 的结构化 outcome；显式“无法完成”与 completed 声明冲突时 fail closed。Codex 原生 collab 的顶层 `payload.status` 只表示 wait/sendInput 等 action 的状态；只有 `receiverThreadIds / agentsStates` 精确证明一个 child 时才渲染胶囊，并只以该 child 的 `agentsStates` 判 lifecycle。匿名或多 child action 留在普通协作工具活动；显式 background input 在 terminal lifecycle 前保持 running | `codex/event-mapper.ts` + `codex/subagent.ts` + `subagent-status.ts` + `subagent-view.ts` |
| 12 | CodePilot / Claude / Codex managed spawn 都必须在调用 child 前创建 durable running row；持久化失败则不启动 child；只有第一次结构化 terminal 可收口。Codex UI toolId = DB runId，后续回合状态来自 `subagent_runs`，不得从 `update_plan`、正文、耗时或工作区文件推断 | Runtime child adapter + `subagent-run-context.ts` + `db.ts` |
| 13 | Assistant 流不能等 SSE 完整关闭后才首次落库。首个有效 text/thinking/tool block 创建 `streaming` checkpoint，后续增量更新同一 message id，终态原位收口；进程重启只把遗留 `streaming` 行改成 `interrupted`。刷新后的历史 UI 轮询该行到终态，不得把 checkpoint 当完成或插入重复回复 | `chat-collect-stream-response.ts` + `db.ts` + `ChatView.tsx` + `MessageItem.tsx` |
| 14 | managed child 的权限 request 与 timeout resolved 事件必须携带同一 `agentRunId` / `childSessionId`；request 另带用户可见 `agentName`。PermissionPrompt 必须显示发起者，不能把 child 写入审批伪装成父 Agent 请求 | `claude-subagent-mcp.ts` + `claude-client.ts` + `permission-registry.ts` + `PermissionPrompt.tsx` |
| 15 | Renderer 切换聊天、刷新或 fetch transport 断开只表示客户端 detach，不能取消 server-owned Runtime/collector；只有显式 Stop 调用 `/api/chat/interrupt` 才能向父/child abort 传播。首轮 `/chat` 的 Stop 也必须先发 interrupt，再终止本地 fetch。Codex managed delegation 必须把父 turn 的同一 AbortSignal 同时用于 dependency wait 与 child execution；proxy transport signal 只能合并为 fallback，不能取代父 Stop source。Codex Account 的动态工具可能阻塞在 app-server 的 `item/tool/call` 上，因此 Stop 必须同时 abort 进程内父 turn controller 并发送 `turn/interrupt`；只做后者会让本地 child 继续运行。组合信号必须兼容仓库 Node 18+ 开发基线，不能裸依赖 `AbortSignal.any` | `api/chat/route.ts` + `chat/page.tsx` + `ChatView.tsx` + `codex/runtime.ts` + `codex/turn-interrupt-registry.ts` + `codex/subagent.ts` + `codex/proxy/builtin-bridge.ts` |
| 16 | Claude managed child 的 timeout 必须区分可续期 idle deadline 与不可续期 hard cap；任何 SDK activity 都续期 idle。运行中 assistant 正文/effective model 必须 bounded checkpoint 到仍为 `terminal=0` 的 run，timeout/cancel 保留部分正文，terminal 后迟到 checkpoint 不得覆盖终态 | `claude-subagent-mcp.ts` + `db.ts` |
| 17 | 事实/研究 child handoff 必须让 source URL 与 claim 同行；无来源的精确日期、数字、排名和引语不得升格成已验证事实。失败 child 后由父 Agent 接管时，最终说明必须区分 child 失败与 parent 产物 | `claude-subagent-mcp.ts` routing/tool/system contract |
| 18 | Sub-agent 的用户任务 identity 是 logical run，不是 tool call。显式 retry 复用 `logical_run_id`，物理调用使用新的 attempt id/number；聊天胶囊和父进展快照只展示最新 attempt 的一个 logical task，详情保留全部 attempt | Runtime child adapter + `subagent-view.ts` + `subagent-run-context.ts` |
| 19 | child 回合停止后先进入 `settling`，此时用户状态仍不得显示 completed；只有 structured result/provenance 与 terminal lifecycle event durable 后才进入 terminal。请求/实际 Provider+Model 分开，Runtime 报告不匹配时 fail closed | Runtime child adapter + `db.ts` + `SubagentCard.tsx` |
| 20 | 当前活动、tool、permission 与 partial progress 必须写 typed lifecycle event；详情 UI 读取 `sqlite.subagent_runs` / `subagent_run_events`，不从 prompt、自由文本叙述或文件变化猜测 | Runtime child adapter + `AgentRunPanel.tsx` |
| 21 | Claude managed MCP 的 SDK tool-use id 必须成为 durable physical attempt id；首次调用可把它作为默认 opaque logical id，显式 retry 则保留旧 logical id + 新 tool-use/attempt id。运行中 transcript、权限归属与详情查询不得各造一套 UUID | `claude-client.ts` + `claude-subagent-mcp.ts` + `SubagentCard.tsx` |
| 22 | Claude managed child 的超时 owner 是 child 内部可续期 idle deadline + hard cap；父回合通用 tool timeout 不得在 300 秒整 abort managed spawn。详情 API 的 404/5xx/网络异常先做有界快速探测，随后进入低频冷却恢复；不得永久每秒请求，也不得因首次 transient error 永久吞掉真实 terminal run。404 可标 missing，transient 只能是 unknown；stream Error 必须先序列化后写日志，不能只留下 `{}` | `claude-client.ts` + `claude-stream-diagnostics.ts` + `subagent-detail-probe.ts` + `SubagentCard.tsx` |
| 23 | managed tool_use 到达不等于 Agent run 已接受。胶囊只为 durable `subagent_runs` row 展示；生产渲染链传入的 transcript `run` view 本身不是 durable evidence，必须由 session-scoped details API 200 证明。workflow dependency accepted 后显示 queued，只有 app-side handoff compiler 注入上游 terminal result 并切 dispatch_state=executing 后才显示运行中。schema/initial-route/capability 预检失败不得制造幽灵胶囊或占用 workflow task key | `subagent-orchestration.ts` + `subagent-view.ts` + `SubagentCard.tsx` + `codex/proxy/builtin-bridge.ts` |
| 24 | Codex Account 有两条明确分离的委派通道：用户指定 CodePilot Provider / Model 时，只能通过 app-server `dynamicTools` 暴露的 managed `codepilot_spawn_subagent` 精确路由并落 durable fact；Codex 原生 `spawn_agent` 只表示继承父 Codex route 的 native worker，不能冒充指定模型。动态工具仅在 `thread/start` 注册，initialize 必须声明 `experimentalApi`，旧 thread 由 feature fingerprint 切到新 thread；每个真实 Codex thread 使用独立 dispatcher route，不能用进程级单 handler 互相抢占。managed local tool 的 app-server mirror lifecycle 必须抑制，聊天只能出现一次调用/结果；最终 wire result 必须重读 terminal-immutable durable row，晚到的 child completion 不得覆盖先发生的取消 | `codex/runtime.ts` + `codex/app-server-manager.ts` + `codex/dynamic-tool-bridge.ts` + `codex/proxy/builtin-bridge.ts` + `db.ts` |
| 25 | Thinking 动画只增强已有事实，不自行声称模型在 reasoning。首 token 前的普通等待使用 `working`，只有真实 thinking delta 行使用 `solving`；可访问语义仍由现有文字承担，canvas 必须 decorative，并尊重组件的 reduced-motion / visibility pause | `StreamingMessage.tsx` + `tool-actions-group.tsx` |
| 26 | Runtime 内部 lifecycle envelope 不得经通用 status fallback 原样出现在聊天中。已知成功/瞬态事件默认静默；真正影响能力的失败保留结构化诊断事实但只展示本地化人类提示；未知 Codex kind 降级为通用人类状态。双聊天入口均不得暴露 server id、payload JSON 或协议 kind | `codex/event-mapper.ts` + `useSSEStream.ts` + `chat/page.tsx` |
| 27 | 持久化并重放给 AI SDK 的每个非 provider-executed tool-call，在下一条 user/system 或 transcript 结束前必须有匹配 tool-result。回合结束仍未收到结果时，只能补 app-owned、`is_error:true` 的“未收到结果”事实，不能伪造工具成功/执行失败；legacy history 同样修复。无调用来源的 orphan result 可留在 UI/DB 审计，但不得原样送进模型 prompt | `stream-session-manager.ts` + `message-builder.ts` + `tool-history-integrity.ts` + Native loops |
| 28 | 由多个异步 callback 写入的 server-side `ReadableStream` 必须把 enqueue/close 的唯一所有权交给 `SingleOwnerStreamWriter`。consumer cancel 先原子宣告 terminal，再 kill/abort producer；producer 的 exit/error/data callback 只能调用 writer，取消后的迟到写入必须 no-op。stream attach 后禁止任何 callback 继续直接操作裸 `controller` | `single-owner-stream-writer.ts` + marketplace/CLI/media stream routes |
| 29 | DB `token_usage` 是跨 Runtime/历史版本输入；历史消息展示前必须运行时验证 `input_tokens` / `output_tokens` 都是有限非负安全整数，缺失/非法时隐藏整项统计，不得补假 0。assistant `addMessage` 的 insert、session timestamp update 与 row read 必须在同一同步 SQLite transaction 中完成；读不到真实行时抛稳定产品错误并整体回滚，调用方不得依赖 `as Message` 后读取 `undefined.id` | `token-usage-display.ts` + `MessageItem.tsx` + `db.ts` |
| 30 | 每个父聊天第一次 execution 必须先完成 Runtime binding，再 resolve Provider 或启动 child。bound 后请求 Runtime 只能与 owner 一致；legacy/unbound 的自动执行必须在任何 transcript、工具调用和费用发生前 fail closed | `/api/chat` + `thread-execution-binding.ts` |
| 31 | 跨 Runtime 只能以新 session handoff 继续。目标首轮从 `runtime_handoff` fragment 消费同一份有边界、可截断、已脱敏事实；不得复制原生 SDK/thread ref，也不得把 handoff card 写成用户消息 | handoff API + `handoff-payload.ts` + `ChatView.tsx` |
| 32 | v2 usage 中 missing cache/cost 是 unknown，不是 0。Native 必须核对 provider raw usage，不能接受 AI SDK 合成的缓存零；聚合与 UI 只有在每轮 denominator/source 完整时才显示 rate/金额 | `turn-usage.ts` + collector + usage UI |

## 保存失败的后台与客户端边界（2026-09-07）

- `/api/chat` 启动 collector 后立即用 `observeChatCollection` 拥有 rejection，客户端 detach 后仍捕获一次安全遥测；失败处理自身不得产生新的未处理拒绝。
- runtime SSE 的 done 不是保存确认。响应结束前只等待 terminal persistence 的独立 one-shot 信号，不能等待 collector finally 中的 onboarding/check-in 模型调用或通知；整个 collector 仍有独立 rejection owner。失败发送固定 `CODEPILOT_CHAT_SAVE_UNCONFIRMED`，双聊天入口通过共同错误映射显示“未确认保存、先复制后刷新”的双语提示。后续 finally 失败不能撤销已经确认的保存。
- 首条聊天保存未确认时不得自动跳转到 DB 历史页；在 `/chat` 内把真实 session 与内存消息交给 ChatView，后续发送复用该 session 和既有 route CAS / 权限 / Stop 行为。只重读 session metadata，不能重读历史覆盖正文；正常首条继续跳转。
- 明确保存错误通过 SSE parser 的原始码传到 snapshot.saveUnconfirmed，再写入 renderer-only Message.saveUnconfirmed；不能解析翻译后正文猜状态。snapshot rebuild 必须保留标记。ChatView 的 DB reconcile 在 state updater 内检查未确认回复（含 fetch 期间到达的警告），后续成功回合也不能将其覆盖；流在页面切走后结束时，恢复从 snapshot 追加本地正文，不用 DB 替代，initialMessages 初始化不得覆盖这次追加。
- client tee branch cancel 不能取消 server collector，也不能 await 需要另一分支结束的 tee cancel Promise。所有追加 SSE/关闭走 `SingleOwnerStreamWriter`。
- 不修改 DB 空读的 fail-closed 事务语义，不声称修复初始空读或保证数据已落库。测试必须同时覆盖正常保存和首次/兜底保存失败，并验证失败时 cleanup/lock 释放。
- 回归：`chat-collection-response.test.ts`（真实 onboarding 处理器的模型请求被测试 fetch 阻塞时 SSE 已关闭、finally 在 onComplete 前抛错仍有 owner）、`chat-collection-telemetry.test.ts`、`chat-save-warning.spec.ts`（中英文、双入口、失败后续聊同 session、长会话裁剪、离页恢复、正常首条跳转对照）。

## 关键文件 + 责任

| 文件 | 守哪条不变量 |
|------|--------------|
| `src/lib/claude-client.ts` | SDK streaming core + capProviderId 派生 |
| `src/lib/stream-session-manager.ts` | snapshot 生命周期 |
| `src/hooks/useSSEStream.ts` | SSE 事件解析 + rewind point 发出规则 |
| `src/app/chat/page.tsx` | 首消息入口 |
| `src/components/chat/ChatView.tsx` | 后续消息入口 |
| `src/components/chat/MessageItem.tsx` | 历史 tool 配对；保持真实 tool id；子 Agent 分流 |
| `src/lib/token-usage-display.ts` | 历史/跨 Runtime token usage 运行时 shape 验证；缺证据隐藏，不制造 0 |
| `src/components/chat/StreamingMessage.tsx` | 流式子 Agent 卡片分流 |
| `src/components/ai-elements/tool-actions-group.tsx` | 流式 reasoning 行与工具活动折叠展示 |
| `src/lib/subagent-view.ts` | requested/effective/runtime/status 的诚实归一化 |
| `src/lib/subagent-status.ts` | Claude task lifecycle → last-wins tool_result 状态标记；async launch 非终态 |
| `src/lib/subagent-run-context.ts` | Codex durable run 快照与只读查询结果；system snapshot 不包含 prompt/result |
| `src/lib/workspace-sidebar.ts` | agent-run tab 内存态与 transcript 不落 localStorage |
| `src/lib/db.ts` | 三 Runtime 的 `subagent_runs` running→terminal、parent FK/cascade、terminal immutable；进程重启 recovery owner |
| `src/lib/tools/agent.ts` | CodePilot managed child durable lifecycle |
| `src/lib/claude-subagent-mcp.ts` | Claude managed child durable lifecycle |
| `src/lib/claude-stream-diagnostics.ts` | Claude stream error 的可序列化诊断事实 |
| `src/lib/codex/proxy/builtin-bridge.ts` | Codex managed child durable lifecycle |
| `src/lib/codex/dynamic-tool-bridge.ts` | Codex Account app-server dynamic tool 的 per-thread 路由、managed local lifecycle 去重 |
| `src/lib/codex/turn-interrupt-registry.ts` | Codex 父 turn AbortController 的 HMR-safe 所有权与显式 Stop 传播 |
| `src/lib/codex/app-server-manager.ts` | Codex initialize capabilities；dynamic tools 所需 experimental API 声明 |
| `src/lib/chat-collect-stream-response.ts` | assistant checkpoint 增量写入、owner gate、同 id 终态收口 |
| `src/components/chat/PermissionPrompt.tsx` | child permission attribution 展示 |
| `src/lib/tool-history-integrity.ts` | Stop/partial delivery 后的 call/result 完整性、legacy replay 修复与 orphan model-input 隔离 |
| `src/lib/single-owner-stream-writer.ts` | server-produced Web Stream 的 cancel/exit/error 单终态所有权 |

## 改动检查表

- [ ] 改 capability 相关代码时确认 providerId 显式传递，不依赖全局缓存
- [ ] 改 rewind 逻辑时确认 autoTrigger / tool_result 不被错误触发
- [ ] 改首消息 page 时同步检查 ChatView.tsx 是否独立持有同一状态
- [ ] snapshot clear 行为改动时确认长 idle 后 getSnapshot() 不返回 null（见已知 bug）
- [ ] 改 tool block 配对时确认真实 tool_use_id 保留，历史与 streaming 的 Agent 卡片一致
- [ ] 新 Runtime 的子 Agent 事件只能填它能证明的 model/runtime/status；未知值留空
- [ ] agent-run 侧栏内容必须纯文本展示，且不得把 transcript 复制到 localStorage
- [ ] Claude background Agent 必须用 task_notification 判终态；禁止把 async launch receipt 当 completed
- [ ] 新会话首轮的详情交互必须在 `/chat` streaming 期间可打开，不得等重定向后才挂载侧栏
- [ ] 改 Claude managed child 终态时必须覆盖 `success + is_error`、maxTurns、timeout；禁止按“有 result 文本”推断完成
- [ ] 改 Agent 状态时覆盖 managed plain receipt、background input、Codex inProgress/completed；禁止恢复“任意非错误 tool_result = completed”
- [ ] 改 Codex 原生 collab 映射时使用真实协议 fixture（`tool + receiverThreadIds + agentsStates`）：匿名/multi-child wait 不得生成 Sub-agent 胶囊，outer action completed/failed 不得改写 child 终态
- [ ] 改 Codex child 归一化时覆盖 structured completed/partial/failed、completed 标记与“无法完成”正文冲突、以及无 marker 的旧 child 失败措辞
- [ ] 改任一 managed child adapter 时确认调用 Provider 前已创建 `subagent_runs.running`，所有 terminal 分支只收口一次；持久化失败必须不启动 child
- [ ] 改 assistant persistence 时覆盖刷新中途 checkpoint、同 id terminal、真正进程重启 interrupted、live process 重复 DB init 不误中断、stale owner 不落新内容
- [ ] 改 fetch/Abort 接线时覆盖“切换聊天只 detach、显式 Stop 才调用 interrupt”；不要把 `request.signal` 直接接到 Runtime AbortController
- [ ] 改 child approval wrapper 时覆盖 permission request 与 timeout resolved 的同 run 归属、UI Agent 名称和唯一 request 定向
- [ ] 改 Claude child timeout 时同时覆盖 idle activity renewal、hard cap 不续期、timeout/cancel partial 保留、running checkpoint 与 terminal immutable
- [ ] 改研究/写作委派提示词时保留 source→claim 与 parent fallback provenance，不允许无来源精确事实或失败 child 冒领父产物
- [ ] 改 retry/胶囊聚合时覆盖一个 logical run 多 attempt、latest-attempt 父快照、详情完整 attempt/event；不能按 Agent 名称去重
- [ ] 改 effective route 时覆盖 Runtime reported alias 正例与真实 mismatch 反例；不得把 requested 值回填成 effective
- [ ] 改 Codex model report 时覆盖协议 selector → route displayName、raw report lifecycle breadcrumb、真实 mismatch 保持原值并 fail-closed
- [ ] 改完成态时覆盖 settling 非终态、structured result/provenance 与 terminal event durable 后才完成
- [ ] 改 Claude managed MCP 接线时覆盖 PreToolUse tool-use id → physical attempt 的 one-shot 关联、首次 logical id、显式 retry 新 attempt；详情不得用无法命中 DB 的临时 ID 无限轮询
- [ ] 改父工具 timeout 时确认 managed spawn 被排除，child 的 idle renewal / hard cap 仍各自有效；错误日志必须保留 message/code/cause
- [ ] 改 managed tool 渲染或依赖编排时覆盖：无 durable row 不显示、queued 与 executing 分离、上游失败时下游 Provider 未启动、下游实际 prompt 含上游 durable result
- [ ] 改 Codex Account dynamic tool 时覆盖：initialize `experimentalApi`、`thread/start.dynamicTools`、旧 thread fingerprint、不同 thread 并发路由、local lifecycle 去重、Stop 同时 abort parent controller + `turn/interrupt`
- [ ] 改 terminal settle wrapper 时覆盖“durable cancelled 之后 handler 晚到 completed”：wire、DB 与胶囊都必须保持 cancelled
- [ ] 改 Thinking 动画时保持 first-token wait 与真实 reasoning 语义分离，并验证 20px inline preset、decorative canvas、reduced-motion 不回退成无限动画
- [ ] 升级 `thinking-orbs` 前重新人工审阅发布 diff（网络/eval/storage、浏览器 API guard、reduced-motion、visibility/offscreen pause、unmount cleanup），不得只放宽版本范围后依赖 lockfile
- [ ] 新增 Runtime status kind 时明确 quiet / human-copy / actionable-UI 三选一，并同时覆盖 `/chat` 首轮和 `/chat/[id]` 后续流；禁止落入原始 JSON 展示
- [ ] 改 tool persistence/replay 时覆盖正常 pair、Stop 后 missing result、多 call、provider-executed call 与 orphan result；synthetic marker 只能陈述“CodePilot 未收到结果”，不得冒充工具执行结论。
- [ ] 新增 subprocess/callback 驱动的 `ReadableStream` 时使用 `SingleOwnerStreamWriter`；cancel 必须先终止 writer，再 kill/abort，所有迟到 callback 都要有行为断言。
- [ ] 改 chat execution 入口时确认 binding 在 Provider/child 之前完成；auto/retry/queue/bridge 不能重新读取全局 Runtime
- [ ] 改 usage producer 时用 raw provider 事实区分真实 0 与缺失；unknown 不得经 `?? 0`、SQL `COALESCE` 或图表补点变成 0

## 常见坑

- ~~`clearSnapshot()` 重置 `startedAt: 0`；用户长 idle 后返回时 `getSnapshot()` 返回 null，导致输出不显示~~ **已修 2026-06-10**：`clearSnapshot()` 现在只清 `finalMessageContent`（防 remount 重复 append），快照其余状态（终止原因 / tokenUsage / contextUsage）保留到 GC 回收。不要再让 `clearSnapshot` 触碰 `startedAt`，也不要取消 GC 定时器（旧行为会留下永不回收的隐形条目）。
- 不要在 `/chat` 和 `/chat/[id]` 之间共享 effort/thinking state—两边都必须独立持有。
- 不要把所有 Agent tool 继续塞回折叠工具组；这会让用户无法区分父/子执行边界。
- 不要用数组序号替换历史 tool id；权限归属、取消和侧栏 run 都以该 id 关联。
- 不要用“已有 tool_result”推断 child 完成；Claude background Agent 会先返回 async launch receipt。
- 不要用 Claude SDK 的 `subtype=success` 或非空 `result` 单独推断 managed child 完成；Provider 403 等错误也可能装在 success envelope 的正文里。
- 不要相信父模型写出的“已提交/仍在后台处理”。CodePilot managed Agent 是 blocking foreground：工具返回时 child 已终止，不存在稍后自行回报；UI 只认结构化 lifecycle 事实。
- 不要把 Codex bridge side-channel 当 durable transcript；它只服务当前 SSE。跨回合必须读取 `subagent_runs`，且 child prompt/result 不得直接进入 system instructions。
- 不要把 Codex `turn.status=completed` 当作任务成功。它也会包住“网络不可用，无法完成任务”的正常 final answer；必须消费 child outcome contract，并对明确失败正文做兼容性兜底。
- 不要把 Codex 原生 `collabAgentToolCall.id` 或顶层 `status` 当 child identity / child status。真实协议可能只上报多次匿名 `wait`，而 spawn 完全不进入客户端 notification；此时宁可显示普通协作活动或零胶囊，也不能制造一批 “Codex worker 已完成”。
- 不要让 Codex Account 在用户指定 Qwen / DeepSeek / Kimi 等 CodePilot route 时自行改用 native `spawn_agent`。native worker 继承 Codex 父 route；精确 Provider+Model 必须走 managed dynamic tool，路由不可用就结构化失败并询问用户。
- 不要把 Codex app-server 的动态工具 dispatcher 保存成单个进程级可替换 callback；并发聊天会互相偷走路由。dispatcher 必须按真实 Codex thread id 查找 client/context，并在相同 owner 清理时才注销。
- 不要同时转发 managed dynamic tool 的本地 side-channel lifecycle 与 app-server mirror lifecycle；同一次调用会出现两个 tool_use / tool_result。managed local tool 只保留一个事实流。
- 不要假设 `turn/interrupt` 会打断正在等待本地 `item/tool/call` 的执行。Codex Account Stop 还必须 abort 该父 turn 的进程内 controller；terminal wrapper随后必须以 immutable durable record 为准。
- 不要只在 SSE `done` 后 `addMessage`。页面刷新、renderer 重载或 dev 进程重启会让整个 Assistant 回复和 Sub-agent tool blocks 从历史消失；必须先 checkpoint，再原位收口。
- 不要把 `JSON.parse(token_usage)` 的结果直接断言成 `TokenUsage`；数据库 JSON 可合法但缺字段，UI 会在 `toLocaleString()` 二次崩溃。缺真实输入/输出计数时隐藏统计。
- 不要把 message insert、session timestamp 和回读拆成三个自动提交语句，再用 `as Message` 假定回读必有值；必须事务内验证真实 row，失败回滚并抛稳定产品错误。
- 不要把 renderer fetch 的断连当成用户 Stop。页面切换会自然 abort 客户端请求，但 server collector 应继续完成并持久化；取消权必须来自显式 `/api/chat/interrupt`。
- 不要假设 schema 模块初始化等于真正的进程启动；Next route/module duplication 会在活进程中重复执行初始化，restart recovery 必须由独立的进程 owner 守门。
- 不要只把 parent sessionId 放进 child permission event；独立 subprocess 没有归属字段时，多个 child 的 Write/Bash 提示看起来完全相同。
- 不要给活跃 child 使用固定墙钟 timeout；工具调用、assistant 消息等 SDK activity 都是仍在工作的事实。必须保留 hard cap，防止持续噪声让 run 永不终止。
- 不要只在 child terminal 时写 result；长任务超时、取消或进程退出后，running checkpoint 是唯一可恢复的部分正文。
- 不要把每次 retry 都渲染成同级 Agent，也不要为了少胶囊删除物理调用；logical capsule 与 attempt 审计必须同时存在。
- 不要把 child SDK/app-server “回合结束”直接显示为完成。settling 是明确屏障，只有 DB terminal result 才是用户完成态。
- 不要把 Codex app-server 报告的 `sonnet / opus / haiku` 协议 selector 直接放进胶囊；先用 raw 值验证 route，验证成功后显示具体 route identity，并把 raw selector 留在 lifecycle 审计字段。
- 不要让父回合的普通工具 300 秒 timeout 再次包住 Claude managed child；它会越过 child activity renewal，在健康 research run 上精确触发取消。
- 不要在 SDK transcript、MCP handler、permission attribution 和 durable row 之间另造互不相干的 run ID；MCP callback 没有 tool-use id 时，应通过同一 parent stream 的 PreToolUse correlation 传递。
- 不要对确定不存在的 durable row 永久按秒轮询。只允许短暂 spawn race 重试，legacy/mismatch id 必须有界停止。
- 不要把 Error 对象作为 Next dev logger 的第二参数期待它能展开；先归一化并输出单个 JSON 字符串。
- 不要在收到 managed `tool_use` 时立即宣称“运行中”。参数可能尚未通过 SDK/app 校验，也可能是等待依赖的 queued node；UI 必须先命中 durable row。
- 不要依赖父模型把 A 的结果写进同一 turn 内预先生成的 B prompt。那段输入已经冻结；必须在 B 真正执行前由应用从 durable result 编译。
- 不要因为加载动画叫 Thinking Orb，就把普通首 token 等待标成模型推理；视觉 state 必须跟已有状态事实走，文字仍是语义真源。
- 不要把 `unknown_item` 的 `{ kind, payload }` 直接当用户文案。fallback 保证事件可诊断，不代表内部协议适合进入聊天正文。
- 不要在 `ReadableStream.cancel()` 里只 kill producer，同时让 exit/error callback 继续裸 `controller.enqueue/close`；这是 “Controller is already closed” 的稳定竞态。

## 测试覆盖

| 契约 | 测试文件 |
|------|----------|
| Rewind emission | `session-runtime-immunity.test.ts` 等 |
| clearSnapshot 只消费 finalMessageContent、快照保持可读 | `clear-snapshot-preserves-state.test.ts` |
| Provider 编辑/删除后 capability cache 失效 | `capability-cache-invalidation.test.ts` |
| 子 Agent view、真实 id、侧栏去重与不落 localStorage | `subagent-orchestration.test.ts` |
| spawn receipt / background / Codex collab child 终态 | `subagent-orchestration.test.ts` |
| 三 Runtime managed run 持久化、terminal immutable、Codex 跨回合快照 | `subagent-run-persistence.test.ts` |
| Codex child 回合终态与任务语义分离 | `subagent-orchestration.test.ts` |
| Codex collab action/child identity 分流、匿名 wait 反例 → tool lifecycle | `codex-event-mapper.test.ts` |
| Assistant 流式 checkpoint、同 id 收口、startup interrupted | `collect-owner-gate.test.ts` |
| 刷新后 checkpoint 状态 UI 与窄范围轮询 | `subagent-orchestration.test.ts` |
| Claude child permission request/timeout 归属与 UI 发起者 | `subagent-orchestration.test.ts` |
| 切换聊天 detach 与显式 Stop interrupt 分离 | `first-turn-nav-guard.test.ts`、`interrupt-route-runtime-fanout.test.ts` |
| Claude child idle renewal / hard cap、partial interruption 与来源合同 | `subagent-orchestration.test.ts` |
| running child checkpoint、terminal 后迟到 checkpoint no-op | `subagent-run-persistence.test.ts` |
| logical run / attempt、legacy backfill、settling、structured result 与 typed lifecycle | `subagent-run-persistence.test.ts`、`subagent-orchestration.test.ts` |
| Claude tool-use/attempt correlation、outer timeout exemption、error diagnostic 与 404/5xx 冷却恢复 probe | `subagent-orchestration.test.ts` |
| workflow placeholder/edge/compiler、queued→executing、dependency failure/parallel wait、deadline taxonomy、Codex queued Stop durable cancelled、duplicate/cycle、managed durable-evidence capsule | `subagent-orchestration.test.ts`、`subagent-run-persistence.test.ts` |
| Codex Account dynamic tool surface、per-thread dispatch、mirror lifecycle 去重、feature fingerprint、initialize capability 与 parent Stop | `codex-builtin-bridge.test.ts`、`codex-dynamic-tool-bridge.test.ts`、`codex-builtin-codex-account-guardrail.test.ts`、`codex-interrupt-contract.test.ts` |
| Codex protocol selector 的 exact-route 校验、用户模型归一化与 raw lifecycle breadcrumb | `subagent-orchestration.test.ts` |
| durable cancellation 不被晚到 completion 覆盖 | `subagent-run-persistence.test.ts` |
| 20px Thinking Orb 的 React 兼容、decorative 语义与 wait/reasoning state 接线 | `chat-thinking-orb.test.ts` |
| terminal missing result、legacy repair 与真实 AI SDK `MissingToolResults` 正/反对照 | `codex-tool-only-completion.test.ts` + `agent-loop-messages.test.ts` + `tool-history-integrity.test.ts` |
| subprocess stream cancel、迟到 data/exit/error 与单终态；marketplace install/remove、CLI install、media plan 四条 route 接线 | `single-owner-stream-writer.test.ts` |
| token usage 非法/缺字段隐藏且不补 0；message insert/update/read 原子回滚与真实行返回 | `token-usage-display.test.ts` + `message-persistence.test.ts` |

## 设计决策日志

- 已实现：SDK Capabilities Integration 5 阶段（详见 `sdk-integration.md`）。
- 2026-06-10：长 idle 后输出不显示已修——`clearSnapshot` 收窄为"标记 finalMessageContent 已消费"，不再用 `startedAt: 0` 把整个快照藏起来；GC（5 分钟宽限）负责最终回收。
- 2026-07-22：子 Agent 成为一等 chat item；tool id 是 run identity，requested/effective 分离。侧栏 transcript 由 chat message 重建，不新增 localStorage 数据副本。
- 2026-07-22：用户实测发现 async launch 被误判完成、卡片固定在正文上方、首轮详情打不开；终态改以 task_notification 为事实源，卡片移到正文末尾，`/chat` 首轮侧栏随真实 session 提前可用。
- 2026-07-23：managed child 真实 Qwen smoke 发现 `SDKResultSuccess` 可同时 `is_error=true`；终态增加结构化 error 与 partial/timed_out，错误正文不再被误判完成。
- 2026-07-23：真实 Codex 会话 `da6880f2bd89ed3fd030ee20abcf63d0` 中，三次 managed call 都已 foreground await 到终态，但父模型仍声称“已提交、后台处理中”，并把计划标 completed。wire 增加显式 `terminal`，工具合同明确返回后无 background run；UI 删除 managed/plain receipt 的 completed 兜底，并按 Codex collab payload.status 判定。
- 2026-07-23：同一会话后续“进展怎么样”证明瞬时 side-channel 不足以承担历史事实：proxy suppression 让 bridge call/result 不进入 Codex thread，父模型改用工作区文件猜状态。Codex managed physical run 现写入 `subagent_runs`；toolId=runId，running 只可首次收口为结构化 terminal，后续回合自动获得无 prompt/result 的状态快照，并可调用 `codepilot_list_subagent_runs`。`update_plan`、正文和文件都不得作为 lifecycle 来源。
- 2026-07-23：会话 `1ff7d214c15e2ed2ba590b3183fe1293` 中 Qwen 两次都明确说“无法完成此任务”，但 app-server turn 正常结束导致 run 被记为 completed。Codex managed child 现要求首行结构化 outcome；normalizer 将 completed/partial/failed 与回合状态分开，并在 marker 缺失或 marker 自相矛盾时用明确失败措辞 fail closed。
- 2026-07-23：用户刷新 dev 客户端后发现刚才的测试聊天只剩 user prompt。数据库仍有 session/subagent_runs，但 assistant message 为 0，证明 detached collector 的“流结束后一次性 addMessage”不是 durable transcript。改为同一 message 行增量 checkpoint；刷新显示并自动追终态，进程重启显示 interrupted 和最后保存内容。
- 2026-07-23：Claude managed child 不再裸透传父 `canUseTool`；wrapper 给 permission request/timeout 注入 run/session/name，PermissionPrompt 显示具体 Sub Agent，permissionRequestId 继续作为批准/拒绝的唯一目标。
- 2026-07-23：会话 `ba4855b4c4d272afc85f3a70bbb5b5f4` 中父回合实际继续运行约 39 分钟，但切换回来只剩 interrupted checkpoint。根因是活进程内重复 DB module 初始化误执行 restart sweep，同时 transport disconnect 被接到 Runtime abort。现将 recovery 移出 schema 初始化并受 live process owner 守门；页面断连只 detach，显式 Stop 才调用 interrupt；CodePilot、Claude、Codex 三条 managed adapter 都在启动 child 前写 durable run 并在真实终态收口。
- 2026-07-24：会话 `67d5266867332d91b8a5f88ddbe1d1be` 中两个 Claude managed child 精确 300 秒超时，证明固定墙钟 deadline 会误杀仍有 SDK activity 的工具任务。改为 5 分钟 idle activity renewal + 30 分钟 hard cap；running 输出/effective model 写 durable checkpoint，timeout/cancel 保留 partial。该会话同时暴露父接管归属不清与无来源精确事实补写，故 routing/child contract 增加 source→claim 与 provenance 约束。
- 2026-07-24：P0 可信编排引入 logical run / physical attempt、requested/effective route 核验、settling 屏障、统一 structured result 和 typed lifecycle。UI/父快照聚合 logical task，详情保留每次真实调用；静默模型替换和“结果未持久化就完成”均 fail closed。
- 2026-07-24：会话 `76e108aa3eb500ed43e977d3101cba49` 证明 child 内部 activity-aware timeout 仍会被父回合通用 300 秒 tool timeout 绕过；同时 transcript `call_*` 与 MCP 自造 UUID 使详情永久 404。managed spawn 现从外层 timeout 排除，PreToolUse tool-use id 贯穿 physical attempt/权限/详情；无 row 轮询有界停止，stream error 以单 JSON 字符串保留诊断。
- 2026-07-24：会话 `3f0085c5fc664deca85005d70b1abfca` 有四个 transcript managed tool_use，但只有 Qwen/DeepSeek 两个 durable run；前两个 malformed capability input 在 SDK schema 层失败，仍被 UI 画成 running。DeepSeek 又在 Qwen 完成前生成“等待输入”的冻结 prompt，真正启动后只能自行搜索。现 managed capsule 必须先命中 durable row；malformed capability 进入应用层结构化错误；三 Runtime 用 workflow/task/dependency queued handoff compiler 在执行时注入上游结果。
- 2026-07-24：会话 `f7153c2b01e6a58b31e0406db9be56ec` 证明 workflow 合同本身正确、但 dev HMR 可让代码与缓存 SQLite handle 的 schema 暂时错位。两次 child 都在创建 durable row 前报 `no such column: workflow_id`。修复归 DatabaseSchema guardrail：code-owned revision 变化时重跑幂等结构迁移，但绝不随 HMR 重跑 runtime recovery。
- 2026-07-25：Claude follow-up 证明 durable gate 的 fail-closed 不能等同于永久隐藏：terminal managed run 首次 details 500 会停在 unknown，五次 404 后迟到 row 也无法恢复。现统一为 5 次快速 probe 后每 30 秒一次低频恢复，成功即清空冷却；Codex bridge 以行为测试证明 queued parent Stop 收口 durable cancelled。dependency deadline 最后查询一次以区分 never-created 与 active upstream；Codex signal 组合为 Node 18 增加兼容 fallback，turn registry/wire 改为行为测试、只把真实 app-server 集成留给 smoke。
- 2026-07-26：Codex Account 原生 collab 只能可靠表达 inherited-route worker，无法兑现用户指定的 CodePilot Provider+Model。产品采用双通道：保留 native collab 的 identity-bearing 诚实展示；指定外部 route 时由 app-server dynamic `codepilot_spawn_subagent` 进入既有 managed workflow/durable bridge。真实 smoke 发现 experimental capability 缺失、local/mirror lifecycle 重复、Stop 只中断 app-server turn 以及晚到 completion 覆盖取消，现分别用 initialize capability、per-thread dispatcher 去重、父 turn AbortController registry 和 terminal durable reread 收口。
- 2026-07-27：真实 Codex Account Kimi smoke 证明 exact route 成功仍不等于用户可见模型正确：app-server 会回报协议 selector `sonnet`。Codex 现与 Claude 共用同一语义——raw selector 先用于 route 核验并写 lifecycle breadcrumb，核验通过后 `effective_model` 使用具体 route display identity；真实 mismatch 保留 raw 值并 fail-closed。
- 2026-08-04：聊天等待与真实 reasoning 行接入 MIT `thinking-orbs@0.2.0` 的 20px Canvas preset。首 token 前使用 `working`，thinking delta 使用 `solving`；orb 标为 decorative，保留现有文字语义，并由上游组件负责 reduced-motion、离屏与后台暂停。该包采用时仍年轻，版本保持精确 pin；任何升级必须重新人工审阅发布 diff，不能把当前审计结论沿用到未来版本。reasoning 行用固定 20px 图标框，避免 streaming orb 切到完成图标时产生位移。
- 2026-08-04：用户实机发现 Codex `mcpServerReady` 经 `unknown_item → status` 显示成原始 JSON。现将 ready/starting 在 mapper 静默，startup failed 仍保留结构化诊断，但由共享 resolver 在首轮与后续流转换为本地化人类提示；旧 server 发来的 ready envelope 也由 renderer 防御性消费。generic fallback 只允许普通人类字符串直通，结构化对象及以 `{` / `[` 开头的残缺 JSON 统一降级为本地化状态，防止同类问题换 Runtime 复发。
- 2026-08-07：0.65 真实 Sentry stack 证明 `AI_MissingToolResultsError` 发生在下一轮 prompt conversion；根因是终止回合可持久化只有 tool_use 的 transcript。未来收口补诚实 missing-result，legacy replay 再防御性修复；真实 AI SDK 正/反对照证明修复前拒绝、修复后进入模型调用。
- 2026-08-24：marketplace 与 CLI/media subprocess stream 的 cancel/exit 同时争抢 controller，生产出现 closed-controller Sentry。统一由 `SingleOwnerStreamWriter` 认领终态；cancel 先 close owner 再 kill，迟到 callback 只会 no-op。行为测试覆盖 writer 的迟到写入，并逐条钉住四个 route attach/cancel/no-raw-controller 接线；`safe-stream.ts` 仅保留给尚未迁移的 callback-heavy 旧流，不再宣称每个 ReadableStream 都必须使用。
- 2026-08-27：生产 Sentry 暴露两条持久化边界：合法 JSON 但缺 `output_tokens` 会在历史 UI 崩溃；assistant insert 后非原子回读可能让 collector 访问 `saved.id`。UI 改为运行时 shape 验证且不补假 0，`addMessage` 改为 insert/update/select 同事务并以稳定错误回滚空读。


## 2026-09-14 #685：已选路由与运行时回报分离

- `chat_sessions.model` 是用户提交的 route model identity；SDK/Native `status.model` 是运行时观察值，collector 不得用它覆盖 route，也不得借 status 绕过 `route_revision` CAS。续接引用 `sdk_session_id` 仍由现有 lock owner gate 写入；模型观察值继续留在 SSE/usage 元数据中。
- `resolveChatMessageRoute` 是普通消息的 identity gate。Provider 未随请求回显时仍固定使用 session Provider，不能回退默认/env；明确不同 Provider 立即拒绝。
- 兼容旧版已写成 upstream 的会话只作读取：必须在同一 Provider 的 live enabled catalog 唯一匹配到本次请求的 modelId，并且当前 Runtime 兼容、实际 resolver upstream 一致。stored ID 若本身是另一条 catalog modelId，或多个 alias 共享它、映射隐藏/删除/修改，不能自动解释为同一路线。虚拟账号路线继续精确 identity。
- 兼容不改 owner、历史、Provider 或 route_revision；真正改 route 仍走用户显式 CAS。无法无歧义恢复的旧会话继续要求明确重选，不能按显示名或跨 Provider 猜测。
- 回归：`chat-message-route.test.ts`（多 Provider 连续/重开、旧 upstream、反例和 Native/Codex owner 兼容）、`chat-message-route-http.test.ts`（真实 POST 双回合与错路由在持久化/Runtime 前拒绝）、`collect-owner-gate.test.ts`（owner 也不覆盖 model、stale owner 不写续接状态）。
