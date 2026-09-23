# 同 Runtime 多模型 Sub-agent MVP

> 创建时间：2026-07-22
> 最后更新：2026-07-27
> 状态：🟡 Phase 7 `Code complete` / `Tests pass`；三 Runtime managed Qwen → DeepSeek → Kimi 依赖链与 packaged xAI OAuth / Grok 4.5（CodePilot + Codex Runtime）managed child 路径均已真实 smoke。Codex Account 原生协作已分离 action identity 与 child identity；匿名 wait/sendInput/close 不再制造 Sub-agent 胶囊，child 状态只读 app-server `agentsStates`；真实 identity-bearing native collab smoke 仍待 app-server 提供身份载荷
> 事实基线：[多 Runtime / 多模型 Sub-agent 协作调研](../../research/cross-runtime-multi-agent-orchestration-2026-07-22.md)
> P0 对标复核：[Sub-agent 编排竞品补充调研](../../research/subagent-orchestration-competitor-followup-2026-07-24.md)
> 交接：[same-runtime-multi-model-subagents](../../handover/same-runtime-multi-model-subagents.md)；产品复盘：[insights](../../insights/same-runtime-multi-model-subagents.md)

> 父会话 Runtime owner 职责补充（2026-09-01）：[Runtime 会话所有权计划](runtime-thread-ownership-and-handoff.md) 负责父聊天 binding 与 route CAS；本计划继续负责 child 的 exact Provider+Model route、durable lifecycle、权限和结果。managed child 的 Runtime 必须等于父 owner，child 不得绑定或修改父 route / Runtime refs / `route_revision`，跨 Runtime child 在 durable row 和 Provider 调用前 fail closed。

## 用户问题与取舍

用户希望当前会话选中的 Runtime / Provider / Model 始终担任父 Agent，同时允许父 Agent 创建同 Runtime、不同模型的子 Agent。固定 Profile 被否决：Agent 身份与执行路由分离，模型每次从当前 Runtime / Provider 的真实可用集合中动态选择。

首版保持 same-runtime foreground，但“同 Runtime”不再错误等同于“同 Provider”：CodePilot Runtime、Claude Code Runtime，以及使用 CodePilot Provider proxy 的 Codex Runtime 都通过目录校验后的显式 `provider_id + model` 启动独立 child。父会话 Runtime / Provider / Model 始终不变。Claude 原生 `Agent` 的 `sonnet / opus / haiku` 与 Codex 原生 collab 只保留为各自 Provider-relative 能力，不能冒充产品的精确跨 Provider 路由。跨 Runtime Broker、background 与独立 child cancel 继续后移；三条 managed Runtime 统一用 `subagent_runs` 保存 logical run 下的物理 attempt，并用 `subagent_run_events` 保存可审计 lifecycle。

## 状态

| Phase | 内容 | 状态 | 用户能看到什么 |
|---|---|---|---|
| Phase 0 | 合同、能力门与执行计划 | ✅ 完成 | requested / effective、scene、权限与取消语义已落地 |
| Phase 1 | Runtime 接线 | ✅ 代码完成 | CodePilot / Claude / Codex proxy 显式 Provider+Model child；不可达路由 fail-closed；原生 collab 保持可见 |
| Phase 2 | 聊天胶囊与侧边栏 | ✅ 代码完成 | 单行可换行胶囊；动态模型图标；运行中即可打开详情 |
| Phase 3 | 权限、取消与回归收口 | ✅ 代码完成 | parent tools/permission、depth 1、concurrency 2、显式 parent abort、三 Runtime durable run；individual cancel 后续 |
| Phase 4 | 文档与验证 | ✅ managed 核心 smoke 完成 | Claude Code、CodePilot、Codex Account 三条依赖链，以及 Native 长任务/无效路由/Stop 均有真实证据 |
| Phase 5 | P0 可信编排收口 | ✅ 代码完成 | 一逻辑任务一胶囊；attempt 审计、真实路由、收尾阶段、结构化结果与 lifecycle 详情 |
| Phase 6 | 三 Runtime 共用依赖编排（工作流仍 same-runtime） | ✅ 代码、合同与三 Runtime smoke 完成 | Claude Code、CodePilot Runtime、Codex Account 三段依赖链均由 durable DB 事实验证 |
| Phase 7 | Codex Account 双通道可信协作 | ✅ managed 精确路由完成；native identity 继续 fail-closed | 指定 CodePilot Provider+Model 走 managed dynamic tool；原生 inherited worker 只在有真实 identity 时显示 |

## Phase 0：合同与能力边界

### 用户结果

本阶段不改变 UI，只建立后续实现不能绕过的类型、能力与安全边界。

### 不做什么

- 不把任意 raw model ID 当作已支持；三条 managed route 都只接受当前 Runtime 目录中可用的精确 Provider+Model 对。
- 不把 requested model 冒充 effective model。
- 不创建跨 Runtime Broker，不开放 background 或写权限。

### 执行清单

- [x] 定义可由三条 Runtime 归一化消费的 sub-agent view / route 合同。
- [x] 新增 `delegated_interactive` Provider call scene；非 interactive 父调用 fail-closed。
- [x] child 继承父会话工具与权限 profile；普通模式保留审批，full access 只在父会话显式选择时继承；child session / permission request 带 parent + run 归属。
- [x] 本 MVP 不复制父历史；child 只收到显式 task prompt。

## Phase 1：Runtime 接线

### 用户结果

用户可以要求父 Agent 在相同 Runtime 下调用另一个 Provider 的模型。CodePilot / Claude / Codex managed 路径都复用对应 Runtime 模型选择器的兼容事实集，每个 child 执行精确 Provider+Model 路由。Kimi、GLM、DeepSeek、Qwen 等未置灰模型可用；对当前 Runtime 置灰/缺失的模型不进入路由，父 Agent 必须报 `SUBAGENT_MODEL_UNAVAILABLE` 并询问下一步。

### 不做什么

- managed child 可以在同一 Runtime 的兼容 Provider 间切换，但不能切 Runtime；Codex Account 不经过 CodePilot Provider proxy，仍只具备 Codex 原生 Provider-relative 协作能力。
- 不为拿不到 effective model 的上游路径显示伪“当前模型”。
- 不修改父会话模型或偷偷启动隐藏主控。

### 执行清单

- [x] Native Agent tool 增加精确 `provider_id + model` 参数、全 CodePilot-compatible catalog 校验和 child 专属 session / abort；child 工具装配与模型调用都使用目标 Provider，而非父 Provider。
- [x] Claude Code 注册 `codepilot_spawn_subagent` in-process MCP；exact route 启动独立 SDK 子进程，并继承父 query 的 built-ins / MCP / permission / approval callback。
- [x] managed tool 声明 one-shot foreground 合同：不允许 placeholder / stand-by / resume；有依赖的逻辑 child 必须等输入完整后只调用一次，重试是新的可审计 run。
- [x] route 只表示 catalog-compatible，不表示账号 entitlement；SDK `success + is_error=true`、403/429 等结构化错误永远不能归为 completed。
- [x] Claude managed tool input 必须声明 `required_capabilities`，用于核对 Claude SDK 父 query 的真实 built-in surface；任意 MCP 的存在不再自动授予 read/network/write，`codepilot-memory + 无 WebSearch/WebFetch` 必须对 live search fail closed。MCP 本身仍完整继承。Codex child 不使用该字段，由 app-server 原生 tools/MCP/sandbox/approval 决定能力。
- [x] 不再注入 synthetic inheriting/model-pinned AgentDefinition；指定模型必须走 managed tool。原生 Agent/Task 仍有 PreToolUse 冒充门禁。
- [x] `PreToolUse` shipping boundary 拒绝 prompt-level 模型冒充（例如 child 实际继承 DeepSeek 却写“你是 Grok 专家”）；`canUseTool` 只作 defence in depth，普通研究主题提及不拦截。
- [x] Codex `collabAgentToolCall` 不再被静默过滤；匿名/多 child action 作为普通协作活动，只有 app-server 精确证明一个 child identity 时才进入 Sub-agent 胶囊；模型来源缺失时诚实降级。
- [x] Codex Provider proxy 注册 `codepilot_spawn_subagent`，为目标 Provider+Model 新建独立 app-server thread；child 通知按 thread ID 与父 stream 隔离，managed child 禁止再次委派。
- [x] Codex child 继承父 sandbox / approval、Codex 原生工具与全部 MCP；dynamic MCP namespace/tool 无 CodePilot allowlist，统一交回 Codex MCP manager。`web_search` 对 xAI、OpenAI Responses、官方 Anthropic 翻译为真实 hosted tool。
- [x] proxy 内部执行的 `codepilot_spawn_subagent` 与 hosted tool 从 Codex-bound function-call stream 抑制，不能再次回传 app-server 形成 `unsupported call`。
- [x] Native child 将 SSE `error` 事件归一化为 failed / timed_out / cancelled；403/429/模型不可用不能再落成空 completed。
- [x] Native `runAgentLoop` 把 AI SDK `response.modelId` 作为 Runtime 事实写入 result；managed child 不再用 requested route 回填 effective model，报告不匹配时写 `route_warning` 并返回 `ROUTE_MISMATCH`。
- [x] 普通 Native chat 继续保持 timeout 默认关闭；blocking managed Native child 显式使用 connect/first-token 5 分钟、tool 6 分钟、total run 30 分钟预算，Provider 黑洞不能无限卡住父回合。
- [x] Agent tool / collab 保留 run breadcrumb 与真实 tool id，同时兼容已有纯文本历史。

## Phase 2：聊天胶囊与侧边栏

### 用户结果

子 Agent 以单行胶囊直接出现在聊天中，顺序为模型图标、Agent 名称、状态、详情、模型名；多个 child 在同一行按空间自动换行。胶囊跟在父输出之后，运行中即可打开 Workspace Sidebar 查看任务与等待态，终态后更新结果。

### 不做什么

- 不把完整 child token stream 全铺在主聊天。
- 不展示没有动作价值的 Runtime / Agent 框架胶囊。
- 不新增另一套右侧浮层，复用 Workspace Sidebar dynamic tab。

### 执行清单

- [x] 从 ToolActionsGroup 分流 Agent / Task 与 identity-bound Codex child；匿名 wait/sendInput/close 等 Codex collab action 留在普通工具活动。
- [x] 新增可键盘访问的紧凑 `SubagentCard` 胶囊，历史和 streaming 两条渲染链一致。
- [x] Workspace Sidebar 增加 `agent-run` dynamic tab 与 `AgentRunPanel`。
- [x] 卡片左侧根据 Kimi / Zhipu GLM / xAI Grok / DeepSeek / Anthropic / OpenAI 模型族动态展示品牌图标；未知模型才回退通用图标。
- [x] 隐藏 Runtime / 框架胶囊和主聊天提示词；“详情”在 running / terminal 都显示并紧跟状态，模型名同行显示。
- [x] 将卡片移到父 Agent 内容之后，避免流式文字把卡片顶出视口。
- [x] `/chat` 首轮创建 session 后立即同步 sidebar scope，确保父输出结束前也能打开详情。

## Phase 3：权限、取消与回归

### 用户结果

权限弹窗能说明由哪个子 Agent 发起；批准/拒绝只命中对应 run。停止父任务或退出后，子 Agent 不会继续占用会话。

### 不做什么

- 不允许 child 权限超过 parent ceiling。
- 不用父 session ID 作为 child permission 的唯一归属。
- 不把超时或 maxTurns partial 显示成 completed。

### 执行清单

- [x] child permission request 携带 runId / childSessionId；DB parentSessionId 保留真实 FK，permissionRequestId 定向响应。
- [x] parent abort 向 Native / Claude child 传播；Codex 以父聊天 turn 的同一个 AbortSignal 同时取消依赖等待、managed child 与 app-server turn，proxy request signal 只作 transport fallback。
- [x] 每父 session 并发上限 2；真实 tool id / child session 避免事件归属串台。
- [x] Claude managed child 权限 callback 注入唯一 runId / childSessionId / agentName；PermissionPrompt 显示发起者，timeout resolved 保持同一归属。
- [x] 声明 `write_workspace` 的 Claude managed child 按 working-directory realpath 串行；只读 child 仍可在并发 2 上限内并行。
- [ ] Native / Codex 与跨 Runtime 写任务尚无共享写锁；当前不得把 Claude-only 串行实现描述成三 Runtime 通用保证，见 tech-debt #58。
- [x] Claude `async_launched` 只表示已启动，保持 running；`task_notification` 才写入 completed / failed / cancelled 终态，终态不可被乱序回执回退。
- [x] Claude SDK 终态归一化：`is_error` / `api_error_status`、`error_max_turns`、timeout 分别进入 failed / partial / timed_out，并保留结构化 error metadata。
- [x] Claude managed child 不再使用固定五分钟墙钟 deadline：SDK 每条 activity 都续期五分钟 idle timer，另设三十分钟 hard cap；assistant 部分正文与 effective model 在 running 阶段写入 `subagent_runs`，timeout/cancel 终态保留已经产生的正文。
- [x] Claude research/事实 handoff 要求 claim 与来源 URL 同传；下游不得把无来源精确日期、数字、排名或引语包装成已验证事实。child 失败后父 Agent 若用自身工具接管，必须明确执行归属，不能把父产物记到失败 child 名下。
- [x] managed result wire 携带 `terminal=true/false`；UI 不再把普通 spawn acknowledgement 当 completed，background input 与 Codex `inProgress` 保持 running。
- [x] CodePilot / Claude / Codex managed spawn 都在启动 child 前写入 `subagent_runs.running`，持久化失败不调用 Provider，所有 terminal 路径只允许第一次原子收口；Codex 继续以 UI side-channel toolId 作为 durable runId，并在后续回合注入 lifecycle-only 快照。
- [x] Codex canonical sandbox 对 readOnly/workspaceWrite 开启真实网络访问，child 继承同一 wire；Qwen 等无 hosted search 的第三方 route 可使用 Codex 原生 Shell/Fetch，不再被固定 DNS 沙箱阻断。
- [x] Codex child 用结构化 outcome 区分“turn 正常结束”与“任务完成”；明确无法完成、partial 或 marker/正文冲突不会写成 completed。
- [x] Assistant 回复从首个有效事件开始写 durable checkpoint；刷新后同一消息自动追终态，进程重启显示 interrupted，不再丢正文/Sub-agent 胶囊。
- [x] 把 destructive restart recovery 从重复可达的 `initDb()` 中移出：DB path 级进程 owner 只在前 owner 缺失/死亡时执行一次；live process 的重复 Next module/route 初始化不再删除 lock、中断 permission/checkpoint/run。
- [x] renderer 切换聊天/刷新只 detach 本地 fetch，server collector 继续执行并落终态；显式 Stop 先调用 `/api/chat/interrupt`，再 abort 本地 fetch。
- [ ] individual child cancel（本版没有单 child cancel UI）。
- [x] 跨三 Runtime 的 logical run / physical attempt 聚合：重试复用 `logical_run_id`，SQLite 保留全部 attempt，父快照与 UI 只展示最新 attempt 的一个逻辑任务。
- [ ] usage measurement source：当前 `costUsd` 明确币种且只接收真实返回值，但尚未持久化该测量来自 Provider 还是 Runtime；未补 source breadcrumb 前不得扩展为估算费用。
- [ ] Provider entitlement health cache。
- [ ] 后续债务见 tech-debt #58：跨 Runtime 写锁、Codex terminal/thread/usage、结果存储钳制、详情 tab 独立轮询与展示收口、outcome marker 抗伪造、Claude settingSources 最小上下文和 ENTITLEMENT taxonomy。

## Phase 5：P0 可信编排收口

### 用户结果

同一个子任务因限流、鉴权或临时失败重试时，聊天里仍只有一个胶囊；详情保留每次真实调用。胶囊的完成态只来自 durable terminal result，不来自“提示词已下发”或 Runtime 回合结束。请求路由与实际路由分开显示；Runtime 报告了不同模型时，该 attempt 以 `ROUTE_MISMATCH` 失败，不允许静默 fallback。

### 执行清单

- [x] `subagent_runs` 增加 `logical_run_id + attempt_number`，旧 physical-only 行保守回填为独立 logical run / attempt 1；唯一索引禁止同一 logical attempt 重号。
- [x] 三条 managed tool 都支持首次省略、重试显式复用 `logical_run_id`；未传 ID 时始终新建 logical run，不按 agent name / prompt / model 猜测合并；父进展快照和胶囊按 logical run 聚合，详情展开全部 physical attempts。
- [x] logical ID 复用由应用层守卫：最新 attempt 为 running/settling 时返回 `LOGICAL_RUN_STILL_RUNNING`，为 completed 时返回 `LOGICAL_RUN_ALREADY_COMPLETED`；两者均在 Provider 启动前拒绝且不插入 physical row。
- [x] Claude SDK init / Codex thread start / Native AI SDK response 都对 Runtime 上报模型做 exact route 核验；不匹配写 `route_warning` 并返回 `ROUTE_MISMATCH`，不得接受 fallback；拿不到 Runtime report 时 effective model 保持 unknown，不回显 requested。
- [x] 增加 `running → settling → terminal` 内部 phase；child 停止输出后先写结构化结果/来源/provenance，再以原子 terminal 更新收口。
- [x] 统一 `DelegatedAgentResult`：status、summary、error、sources、artifacts、warnings、真实 usage 与 requested/effective provenance；缺失 usage 不显示假 0。
- [x] 新增 `subagent_run_events`：started/activity/tool/permission/partial/settling/terminal/route_warning；每个 physical attempt 只保留最近 200 次事件变更，coalesce 更新也推进 monotonic cursor；详情 API 首包有界、随后按 `after_cursor` 增量返回，卡片按 event id 合并。
- [x] Claude managed MCP 用 SDK `PreToolUse.toolUseId` 作为 physical attempt id；首次调用默认 logical id 与 transcript tool id 一致，显式 retry 仍保留旧 logical id + 新 physical id，运行中胶囊可直接命中 durable 详情。
- [x] Claude managed child 不受父回合通用 300 秒 tool timeout 误杀；child 自己的 5 分钟 idle renewal / 30 分钟 hard cap 是唯一超时 owner。
- [x] 详情查询对 spawn race 先快速探测 5 次；仍为 404、5xx 或网络异常时进入每 30 秒一次的低频恢复探测。404 才可标 missing，5xx/网络错误保持 unknown；不得永久放弃迟到 durable row，也不得维持每秒请求洪泛。stream error 先序列化为单个 JSON 字符串，避免 Next dev 控制台只留下 `{}`。
- [x] startup recovery 对遗留 non-terminal attempt 写 failed structured result、terminal phase 和 terminal event；历史完成 attempt 不回退。
- [x] bootstrap + additive migration + legacy backfill、终态 immutable、logical retry 聚合、路由 mismatch、UI source contracts 的定向回归。

## Phase 6：三 Runtime 共用依赖编排（工作流仍 same-runtime）

### 用户结果

父 Agent 可以在一次规划里声明 `research → copy → implementation`。CodePilot 接受任务后先写 durable run；下游在应用层等待上游真实终态，并在启动目标 Runtime 前由 CodePilot 注入上游结果。父模型不再需要把尚未产生的结果预写进不可变 tool input，也不能用“等待某 Agent”占位调用冒充已启动。

### 执行清单

- [x] 新增三 Runtime 共用的 `workflow_id + task_key + depends_on` 调度合同；同 workflow 内 task key 重复、自依赖、间接循环、缺失依赖和失败依赖均结构化 fail-closed。
- [x] `subagent_runs` additive 保存 workflow/task/dependencies 与 `queued → executing → settling → terminal` dispatch state；详情与胶囊从 SQLite 事实展示 queued，不从 tool call arrival 猜运行中。
- [x] 依赖结果由 app-side handoff compiler 在 child 真正启动前注入；未声明依赖的 wait/stand-by placeholder 在 Provider 调用前拒绝。
- [x] Claude 的 `required_capabilities` malformed input 进入应用层结构化校验，不再让 SDK schema error 制造幽灵 Sub-agent 胶囊。
- [x] 只有已创建 durable row 的 managed child 才渲染胶囊；`MessageItem/StreamingMessage` 传入的 transcript view 不再被误当成 durable evidence。无 row 的参数/schema/初始 route 预检失败由父 Agent 解释，不冒充 Agent run；已接受后 route 被移除等执行期失败仍按真实 durable attempt 显示。
- [x] Codex 初始 route 校验移到 `startSubagentRun` 之前，错误 Provider/Model 不占用 workflow task key、不留下幽灵 attempt；持久化后的二次 route 校验仍防止配置竞态。
- [x] 依赖等待区分 `DEPENDENCY_NOT_FOUND`（从未创建上游）与 `DEPENDENCY_TIMEOUT`（上游存在但未在 deadline 前终止）；Codex 等待和 child 执行共用父 turn Stop 信号。
- [x] 即使 `timeoutMs <= missingDependencyGraceMs`，deadline 边界也会做最后一次 durable lookup：从未创建仍为 `DEPENDENCY_NOT_FOUND`，只有已存在但未终止的上游才是 `DEPENDENCY_TIMEOUT`。
- [x] Codex bridge 提供窄依赖注入缝；行为测试穿透真实 tool execute/持久化收口，证明 dependency queued 时父 Stop 不启动 child，且 attempt 最终为 `cancelled + terminal + dispatch_state=terminal`。
- [x] Codex parent/transport AbortSignal 在支持 `AbortSignal.any` 时使用原生组合；Node 18 开发环境缺少该 API 时使用带 listener 清理的兼容路径，不提高仓库既有 Node 版本门槛。
- [x] Dev cached-handle migration 的行为测试同时保留一条 live `messages.stream_status=streaming`，证明 schema revision refresh 只补结构、不触发 startup recovery。
- [x] 三 Adapter 消费同一 dependency compiler；补 sequential、parallel wait、dependency failure、placeholder、duplicate/cyclic key、durable ownership 与 UI durable evidence 回归。
- [x] 将 Google ADK / LangGraph / AutoGen GraphFlow / Pydantic Harness + durable execution 的可借鉴边界写入 research/guardrail/handover。
- [x] 真实 smoke：Claude Code、CodePilot Native 与 Codex Account managed 已分别完成 Qwen research → DeepSeek copy/edit → Kimi implementation/review。三条链各只有 3 个 durable logical task，下游实际输入含上游 terminal result，无额外 schema/placeholder 胶囊；Native 证据由 DB `subagent_runs.runtime=codepilot_runtime` 独立确认。

## Phase 7：Codex Account 双通道可信协作

### 用户结果

Codex Account 按用户意图使用两条互不冒充的通道。用户只要求 Codex native worker 时，原生 collaboration action 继续使用继承父 route 的能力：app-server 没有暴露 child 身份时，wait/sendInput/close 只作为普通协作工具活动；只有载荷能精确证明一个 child thread 时才显示胶囊。用户明确指定 CodePilot Provider / Model 时，Codex Account 通过 app-server dynamic tool 调用既有 managed bridge，获得精确路由、workflow、durable lifecycle、详情与 Stop 语义。

### 执行清单

- [x] `collabAgentToolCall.id` 只作为单次 action id；`receiverThreadIds + agentsStates keys` 合并后恰好一个真实 thread id 才进入 `codex_subagent` 映射。
- [x] identity 为空或同时指向多个 child 的 action 使用 `codex_collaboration_<action>` 普通工具名，不进入 `MessageItem/StreamingMessage` 的 Sub-agent 分流。
- [x] Codex 原生 child 的 logical id 使用真实 child thread id；wait/sendInput 等多次 action 可按 child 聚合，不按 action id 制造重复胶囊。
- [x] outer `status=completed/failed` 只表示协作 action 终态；child 状态只读取同一 child 的 `agentsStates.status`。缺失 child lifecycle 时保持 running/unknown，不冒充 completed。
- [x] 真实事故协议反例进入测试：15 次 `tool=wait + receiverThreadIds=[] + agentsStates={}` 产生 0 个 Sub-agent 胶囊；单 child、多 child、outer failed + child running 均有反例。
- [x] `codex_account` 的 `thread/start` 注册 managed `codepilot_spawn_subagent` / `codepilot_list_subagent_runs` dynamic tools；指定 CodePilot route 时明确禁止 native worker fallback，route 不可用即结构化失败。
- [x] initialize 声明 dynamic tool 所需 `experimentalApi`，feature fingerprint 使旧 Account thread 进入支持新能力的新 thread；resume 不重复发送 start-only 参数。
- [x] dynamic dispatcher 按真实 Codex thread id 隔离并发会话；managed local tool 的 app-server mirror lifecycle 被抑制，单次物理调用只产生一组 tool_use/result。
- [x] Account 显式 Stop 同时 abort 父 turn controller 与发送 `turn/interrupt`；terminal wrapper 以 immutable durable row 为最终事实，晚到 completion 不能覆盖 cancelled。
- [x] 真实 Account smoke：Qwen research → DeepSeek edit → Kimi review 精确命中三条 Provider+Model route，3 个 durable logical 胶囊；running Qwen Stop 后 durable/wire/UI 均为 cancelled。
- [x] v0.60.0 OAuth route 回归：`xai-oauth` / `openai-oauth` 使用 picker、resolver、CodePilot/Codex managed Sub-agent 共享 catalog；未认证、disabled 与 Claude Code xAI 负例 fail closed；packaged Grok child 已在 CodePilot/Codex 两条 Runtime 真实通过并登记 Ledger。
- [ ] tech-debt #59 仅保留 native inherited worker 的可观测性：spawn 未进入 notification、wait 又无 identity 时，不猜测 child；如未来需要恢复其名称/模型/详情，另做 app-server typed ingestion。
- [x] Electron dev 历史 smoke：重载会话 `8c94f9c716fc80e4244d34cb32b2811b` 后 “Codex worker” 胶囊为 0，页面 console 0 error；旧 transcript 无需重跑 mapper 即按 identity 重新分流。
- [ ] 原生 inherited worker 的 identity-bearing smoke：若当前 app-server 上报 child identity，则一个 child 只显示一个胶囊且 action completed 不提前完成 child；这不阻塞 managed 精确路由能力。

## Phase 4：文档与验证

### 用户结果

用户和 Claude 可以按 Smoke Ledger 复测真实模型切换与 UI，不需要从实现细节猜是否成功。

### 执行清单

- [x] targeted unit / contract tests（最新 Codex collab + Sub-agent 两文件 147/147；前序 Sub-agent/Codex bridge/interrupt/persistence 四文件 120/120；覆盖真实匿名 wait 协议、child identity/status、历史 transcript 恢复、workflow/dependency/queued/compiler、生产 transcript durable gate、404/5xx 冷却恢复、invalid route 零持久化、queued Stop durable cancelled、dependency 边界、Node 18 abort fallback、HMR migration 不 recovery，以及前序 route/terminal/permission 合同）。
- [x] `npm run typecheck`、`lint:hooks`、`lint:docs-drift`。
- [x] 完整 `npm run test`：2026-07-26 typecheck 通过、unit suite 4659/4659；模型图标改为精确导入 `@lobehub/icons/*/components/Mono`，不再经品牌 barrel 连带加载 `@lobehub/ui`/CodeDiff，原 5 个 Widget/Harness 加载失败已关闭。
- [x] dev client / UI smoke：真实历史会话分别验证 terminal / running 胶囊；高度 30px、无提示词段落/第二行、详情按钮在 running 可点；P0 详情面板可展示请求/实际路由、logical run/current attempt 与 durable 结果，legacy 行不伪造 lifecycle；console 0 error。
- [x] 真实 Claude / Native / Codex managed 模型切换 smoke；三条 Runtime 的 Qwen → DeepSeek → Kimi 依赖链均有 session 与 durable DB 证据。原生 inherited worker 的 identity-bearing smoke 属 Phase 7 非 managed 范围，继续 fail-closed。
- [x] 更新 handover / insights / guardrail 与索引。

## 验收矩阵

| 场景 | 必须看到 | 失败判据 |
|---|---|---|
| CodePilot 父路由 A → 子路由 B | B 是 CodePilot-compatible 的精确 Provider+Model；工具装配与请求都由 B 执行；AI SDK `response.modelId` 与 B 核验后才成为 effective | 只传 model alias、沿用父 Provider、仍用 A，或把 requested B 冒充 effective |
| Native managed timeout | Provider 5 分钟无连接/首 token、tool 6 分钟未完成、总运行 30 分钟分别进入结构化 timed_out 终态；普通 Native chat 默认不变 | child Provider 黑洞让父回合无限 active，或擅自给普通 chat 加同一默认 |
| Claude managed child（正例） | 所有 Claude Code picker 未置灰模型均提供 exact Provider+Model route；Kimi / GLM / DeepSeek 由独立 child subprocess 执行 | 用 AgentDefinition/role slot 假装跨 Provider，或显示 Sonnet 代替目标模型 |
| Claude managed child（反例） | picker 置灰/缺失模型（用户实测 Grok/xAI）不在 route list；调用时 fail closed，父 Agent 询问改用可用模型还是切 Runtime | 静默继承、替换模型或继续宣称子任务成功 |
| Claude Provider 拒绝 | SDK 即使返回 `subtype=success`，只要 `is_error=true` 就显示 failed；403/429 保留结构化错误 | 错误正文被包装成 completed，或父 Agent继续使用该结果 |
| Claude one-shot 调度 | 有依赖的 child 等完整输入后只启动一次；重试显示为独立 attempt | 先启动“待命”child，再用同名 child 伪装续跑，导致 3 个逻辑 Agent 出现 6 次调用 |
| 共享 workflow DAG | 三 Runtime 都用同一个 `workflow_id/task_key/depends_on` 合同；下游 durable row 先显示 queued，只有上游 completed 后才转 executing，且 Runtime 收到的 prompt 含真实 terminal result | 父模型在同一批 tool input 里冻结“等待上游”的占位文本；三个 Adapter 各自实现不同等待语义 |
| workflow fail-closed | 重复 task、self/indirect cycle、失败/缺失依赖、durable ownership 丢失均在目标 Provider 前结构化失败 | A↔B 永久互等、上游失败后仍启动下游，或 DB row 丢失后继续运行不可审计 child |
| managed preflight UI | 参数/schema/route 预检失败且没有 `subagent_runs` row 时不渲染 Agent 胶囊；父 Agent 直接解释结构化错误 | SDK 收到 tool_use 就先画胶囊，导致一次非法调用同时出现“幽灵 Agent”和错误 |
| Claude 工具继承 | 父 turn 的 built-in WebSearch/WebFetch、写入、Shell 与所有 MCP 都继承；capability preflight 只认对应真实 built-in，Memory/未知 MCP 不伪造能力。权限条显示 Agent 名与 run 归属 | CodePilot 固定只读、child 绕过父审批、或 Memory MCP 让无搜索工具的 live research 错误放行 |
| Claude 写并发 | 两个声明 `write_workspace` 且指向同一 realpath 工作树的 child 严格串行；只读 child 仍可并发 | 两个模型同时写同一文件树，产生覆盖或交错 edit |
| Claude maxTurns / timeout | maxTurns 显示部分完成；child 连续五分钟无 SDK activity 才触发 idle timeout，持续 activity 最长运行三十分钟；父回合通用 tool timeout 不作用于 managed spawn；所有超时都不是 completed | 有正文就算成功、父回合在 300 秒整误杀健康 child，或持续噪声让 child 永久 active |
| Claude 后台生命周期 | `async_launched` 后保持运行中；收到同 run 的 terminal notification 后才显示终态 | 下发即完成、终态被乱序回执改回 running |
| managed foreground 生命周期 | tool call blocking 等到 child terminal；返回 wire 有 `terminal=true`，父模型立即消费结果且不得声称仍在后台；无结构化终态的 receipt 保持 running | 把提示词送达/工具调用成功当完成，或父回合结束后承诺稍后汇报 |
| Codex 跨回合进展 | 每次 physical run 在 `subagent_runs` 有 running→terminal 事实；后续回合先读 `codepilot_list_subagent_runs`，terminal 后不声称后台仍运行 | 用 `update_plan`、旧正文、耗时或工作区文件猜状态；重启/续聊后丢失 child 终态 |
| Codex managed child | 新 thread 写入目标 Provider+Model，继承父 sandbox/approval、native tools 与全部 MCP；CodePilot 不要求 capability 分类；支持的 SDK 接到 hosted Web/X Search；child 事件不串入父 stream | 固定 read-only、丢父工具/MCP、出现 `unsupported call: codepilot_spawn_subagent`、只口头扮演目标模型、或 child 关闭父回合 |
| Codex 第三方 Provider 联网 | readOnly/workspaceWrite turn 都发送 `networkAccess:true`；无 hosted search 的 route 可通过 Codex 原生 Shell/Fetch 联网 | 工具说明声称继承，实际 DNS 固定被 sandbox 阻断 |
| Codex 动态权限与 MCP | `item/permissions/requestApproval` 的 allow/deny 使用 `{ permissions, scope }` 且 grant 不超出原请求；namespace MCP 对第三方 Provider 可见并以原始 `(namespace, name)` 回给 app-server | 用户点允许但回包 shape 错误仍被拒；descriptor 虽保留却未暴露给模型；代理伪造更宽权限 |
| Codex proxied 委派入口 | CodePilot Provider proxy 只暴露 exact-route `codepilot_spawn_subagent`；原生 `multi_agent_v1` 仅保留在不经过 proxy 的 Codex Account | 同一逻辑 child 同时创建 managed run 与 inherited-model Codex worker；把 `spawn/wait` 控制动作各显示一枚胶囊 |
| Codex 任务语义终态 | child structured outcome 决定 completed/partial/failed；turn completed + “无法完成”必须 failed | 把“模型回答完了”显示成“任务完成” |
| Codex Account / 原生 collab | outer action 与 child lifecycle 分离；只有 `receiverThreadIds/agentsStates` 精确证明一个 child 时才显示/聚合胶囊，状态只读该 child 的 `agentsStates`；匿名/multi-child wait 作为普通协作活动。只展示 app-server 实际上报的模型 | 每次 wait/sendInput/close 各生成 “Codex worker” 胶囊；outer action completed 冒充 child completed；未经 proxy 却宣称跨 CodePilot Provider 成功 |
| Agent UI | 单行胶囊位于父输出之后并可横向容纳多个 child；左侧为模型族品牌图标；不显示提示词/Runtime 胶囊 | 全尺寸卡片、第二行模型、被固定在文本上方或图标不符 |
| logical retry | 只有显式复用同一 `logical_run_id` 的调用才聚合为一个逻辑任务；详情保留 attempt 1..N 和各自终态。未声明 retry 关联时即使名称相同也平铺为不同胶囊 | 按 agent name / prompt / model 猜测合并，或为了去重删除真实物理调用 |
| logical retry guard | active/settling logical ID 返回 `LOGICAL_RUN_STILL_RUNNING`；completed logical ID 返回 `LOGICAL_RUN_ALREADY_COMPLETED`；均不新增 attempt、不启动 Provider | 并行创建同 logical attempt，或让失败 retry 遮蔽已交付的 completed 结果 |
| effective route | 请求 Provider+Model 与 Runtime 实际报告分别展示；报告不一致时当前 attempt 失败为 `ROUTE_MISMATCH` | 静默接受 Sonnet/GPT 等 fallback，或用 requested 冒充 effective |
| durable terminal | child 停止输出后先处于 settling；结构化 result/provenance 和 terminal event 同事务落库后才显示终态 | tool dispatch/turn completed 就显示已完成，或完成态没有 durable result |
| lifecycle 详情 | running 时显示当前活动/工具/权限事件；terminal 后保留 attempt 与最近 200 次事件变更；1 秒轮询只拉取 cursor 之后的增量 payload | 只显示自由文本提示词、每秒重拉全部历史，或事件/payload 随运行时长无限增长 |
| 详情侧栏 | running 与 terminal 都显示“详情”并打开对应 run；Claude transcript tool-use id 与 durable physical attempt id 相同；首轮输出期间 sidebar 已可挂载。404/5xx/网络异常先快速探测，随后每 30 秒一次低频恢复；迟到 row 或 API 恢复后无需整页刷新即可出现 | 运行中点不开、首轮点不开、打开错误 run；terminal 首次 500 后永久消失；或 legacy/mismatch id 每秒永久请求 |
| 刷新/切换恢复 | 输出中刷新或切换聊天后 server-owned task 继续；返回会话时保留正文/工具/Sub-agent 胶囊并自动更新到真实终态；只有真正进程重启才显示 interrupted | 页面 detach 被当成 Stop、活进程重复 init 把 checkpoint/permission 改成 Process restarted、Assistant 整条消失或最终回复重复 |
| 权限归属 | 显示 Agent / run；响应命中正确 child | 只显示父 session 或批准错 run |
| 父取消 | child 终止，父 snapshot 离开 active | child 遗留、结果回灌取消回合 |
| unknown / usage 缺失 | 隐藏或标 unknown | 假 0、假 effective model |

## Smoke Ledger

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|---|---|---|---|---|---|---|---|
| 2026-07-27 | codepilot_runtime / codex_runtime（Claude negative） | xAI OAuth / OpenAI OAuth virtual | grok-4.5 / shared GPT catalog | isolated authenticated token fixtures | v0.60.0 picker ↔ managed Sub-agent route parity；未认证/disabled/Claude Code 负例 | ✅ automated contract | 新增 `subagent-virtual-provider-routes.test.ts`；组合定向 93/93、完整 unit 4703/4703、production build 通过。只证明路由目录与 resolver 接线，不替代另一台 packaged 客户端的真实 Grok child smoke |
| 2026-07-27 | packaged macOS arm64：codepilot_runtime / codex_runtime | xAI OAuth | grok-4.5 | 用户已认证 SuperGrok browser OAuth | Grok 4.5 managed Sub-agent 文本 + `x_search` + durable 胶囊/详情 | ✅ 路由/调用/UI；⚠️ lifecycle 去重 | 当前提交 `7ea8100e` 构建的 `CodePilot.app`（0.60.0，`codesign --verify --deep --strict` 通过）。CodePilot session `d14f966d847de5a16c7f7714d824ac96`：1 次 `Agent`、child 实际执行 5 次 `x_search`，DB 恰好 1 行 `runtime=codepilot_runtime / requested=effective=xai-oauth/grok-4.5 / completed`；Codex Account session `2818c311bea4e0cd5f54c5a2760a95fe`：恰好 1 次 `codepilot_spawn_subagent`，DB 1 行 `runtime=codex_runtime / requested=xai-oauth/grok-4.5 / effective=xai-oauth/Grok 4.5 / completed`。真实 Electron renderer 中两会话各 1 个 completed Grok 胶囊，详情均显示请求/实际路由与正确 Runtime。Codex proxy 的命名 `x_search` 另由 packaged direct session `7ef47943f864e9c58728a2b863cd8ffb` 证明。首次 GUI 启动曾出现 47823 TCP 已监听但 HTTP 无响应；干净退出重启后 `/api/health` 与实际 renderer 验证均通过，暂记为一次性未复现观察，不归因于 Grok。其余残留为 hosted-tool 增量事件重复与 Codex child 详情只显示匿名 item，已记 tech-debt #58。 |
| _待跑_ | codepilot_runtime | configured providers | parent A / child Qwen、DeepSeek、Kimi | API key / token plan | Provider+Model + external MCP/写入工具继承 + approval + card/sidebar | 📋 | |
| _待跑_ | claude_code | Claude-Code-compatible providers | parent A / child Kimi、GLM、DeepSeek；Grok negative | key/login | Provider+Model + WebSearch/WebFetch/MCP/写入继承 + approval | 📋 | |
| _待跑_ | codex_runtime | CodePilot configured providers | parent A / child Qwen、DeepSeek、Kimi | API key / token plan | child thread + sandbox/approval/MCP + hosted Web Search | 📋 | Grok/xAI OAuth managed child + X Search 已由上方 packaged 行覆盖；本行保留其他 Provider、权限与 MCP 组合 |
| 2026-07-26 | codex_runtime | codex_account + CodePilot managed routes | GPT-5.6 parent / Qwen 3.8 Max Preview → DeepSeek V4 Pro → Kimi for Coding | login + 用户本地 Provider 凭据 | Account dynamic tool 精确 Provider+Model、workflow handoff、durable card/sidebar | ✅（路由）/ ⚠️（旧显示） | session `aceb4956ff3c498aa3f054fb95571c88`：三条 Runtime-reported selector 均通过 exact route 校验，3 个 logical 胶囊与依赖 marker 正确；但历史 Kimi row 把 wire selector `sonnet` 直接存为用户可见 effective model。2026-07-27 已修新调用归一化，旧 row 保留为事故证据，不反写用户历史。 |
| _待跑_ | codex_runtime | codex_account | parent / native inherited child | login | native identity-bearing collab visibility / Provider-relative provenance | 📋 | 只验证 inherited native worker；指定 CodePilot Provider+Model 已由上一行 managed 路径覆盖 |
| _待跑_ | claude_code / codex_runtime | configured Provider | catalog short/alias ID ↔ Runtime version-suffixed full ID | 用户本地凭据 | Runtime-reported route identity：合法版本后缀/alias 不误杀，真实替换仍 `ROUTE_MISMATCH` | 📋 | 首次真实 init report 若误杀，先核对 Provider 返回的 canonical/versioned model ID，不扩大成任意前缀匹配 |
| _待跑_ | codepilot_runtime | configured providers | 任意可用长任务 child | 用户本地凭据 | 启动 child → 切换其他聊天 → 等待终态 → 切回；再用显式 Stop 对照 | 📋 | 期望页面切换不取消，Stop 才取消；`subagent_runs` 与 assistant checkpoint 均到真实终态 |
| 2026-07-22 | UI adapter | isolated temp DB | synthetic Native Agent tool pair | 无外部凭据 | historical card + model/runtime + agent-run sidebar + transcript + reload rebuild（首轮实现） | ✅ | DOM: `data-subagent-card=1`、`data-tab-id=agent-run:agent-smoke-1`、console error=0；临时 DB 已删除 |
| 2026-07-22 | unit contracts | synthetic provider capability snapshots | Kimi / GLM / DeepSeek positive；Grok/错路由 negative；PreToolUse gate + lifecycle + brand/order/sidebar contracts | 无外部凭据 | 用户反馈回归 targeted suite | ✅ | 164 pass, 0 fail；typecheck pass；permission allowlist 闭集已同步；Kimi/GLM 的 `sonnet` 协议槽位会还原为真实 route display |
| 2026-07-22 | dev client | existing local history | Sonnet historical Agent cards | 无外部调用 | card-after-text + Anthropic icon + no Runtime capsule + terminal Details + correct run sidebar | ✅ | console error=0；只读检查，未写用户数据 |
| 2026-07-22 | dev client | existing local terminal + running history | historical Claude Agent tools | 无外部调用 | 单行胶囊 + running Details + immediate sidebar | ✅ | terminal/running capsule 均高 30px、`paragraphCount=0`、`buttonCount=1`；running 点击后 `data-workspace-sidebar=1` 且显示“等待子 Agent 返回结果…”；console error=0 |
| 2026-07-23 | claude_code | Aliyun Token Plan（用户当前配置） | Qwen 3.8 Max Preview / Qwen 3.7 Max | 用户本地 Token Plan | 三个逻辑 child 的真实 managed subprocess 调度 | ❌ | session `59536810d349cebf79eb12655c88058c`：实际产生 6 次物理调用；Qwen 两个模型均返回 403 Access to model denied，但旧实现错误标 completed；DeepSeek/Kimi 又经历 placeholder + actual 两次调用 |
| 2026-07-23 | unit contracts | synthetic SDK terminal/capability fixtures | clean success / Qwen 403 / no-status error / maxTurns / abort / timeout | 无外部凭据 | SDK envelope matrix、one-shot guidance、capability fail-closed、partial/timed_out | ✅ | `subagent-orchestration.test.ts` 28/28；`npm run typecheck`、`lint:hooks`、`lint:docs-drift` 通过；最终全量 unit 4456/4461，5 个既有依赖加载阻断 |
| 2026-07-23 | route contracts | 当前本地 Provider catalog + synthetic terminal events | Qwen 3.8 Max Preview / DeepSeek V4 Pro / Kimi for Coding | 不发外部请求 | CodePilot / Codex route 枚举、exact Provider+Model、Codex thread isolation、Native 403 | ✅ | 两条 Runtime 的 tool schema 均包含三条真实配置 route；定向 98/98，`npx tsc --noEmit` 通过；未计作真实 Provider smoke |
| 2026-07-23 | tool inheritance contracts | synthetic parent tool/permission snapshots | Claude WebSearch/WebFetch/MCP；Codex xAI/OpenAI/Anthropic hosted search；Native full surface | 不发外部请求 | parent permission inheritance、depth 1、capability negative、hosted tool translation、Runtime adapter single-source | ✅ | 定向 195/195、`npx tsc --noEmit` 通过；真实 Provider/MCP/审批仍待 smoke |
| 2026-07-23 | codex_runtime | GLM parent → Qwen/OpenRouter child | Qwen 3.8 Max Preview / Claude Opus 4.7 | 用户本地凭据 | 真实 child spawn 与联网请求 | ❌ | session `1d154cca69c53c23091b43d8f55100a6`：两次 `codepilot_spawn_subagent` 均已在 proxy 执行，却又被回传 app-server，得到 `unsupported call`；父模型据此错误归因为目标模型均无联网能力 |
| 2026-07-23 | Codex tool ownership contracts | synthetic bridge + MCP calls | arbitrary inherited MCP namespace/tool | 不发外部请求 | 删除 capability gate、MCP 全透传、bridge call suppression | ✅ | 定向 145/145；真实 Codex child native tools/MCP/approval 待用户与 Claude复测 |
| 2026-07-23 | codex_runtime | GLM parent → Qwen/DeepSeek/Kimi child | 三条 managed route | 用户本地凭据 | blocking lifecycle 与父模型结果消费 | ❌ | session `da6880f2bd89ed3fd030ee20abcf63d0`：三次调用实际分别等待数十秒至约 2.7 分钟并已终态返回，但父模型仍称“已提交、正在处理中/等待输入”，随后结束父回合；不存在它承诺的后台继续 |
| 2026-07-23 | lifecycle contracts | synthetic managed/background/collab fixtures | all runtimes | 不发外部请求 | terminal wire、receipt fail-closed、Codex payload.status | ✅ | 定向 129/129；`npx tsc --noEmit` 通过 |
| 2026-07-23 | Codex durable lifecycle contracts | isolated empty SQLite + synthetic unavailable route | Codex managed physical runs | 不发外部请求 | running→terminal、terminal immutable、parent FK/cascade、toolId=runId、跨回合状态快照、结果按需查询 | ✅ | `subagent-run-persistence.test.ts` 5/5；组合定向 131/131；测试显式禁用 legacy DB migration |
| 2026-07-23 | codex_runtime | GLM parent → Qwen child | Qwen 3.8 Max Preview | 用户本地 Token Plan | 第三方 route 联网 + 任务语义终态 | ❌ | session `1ff7d214c15e2ed2ba590b3183fe1293`：两次 Qwen 均真实执行，但 canonical sandbox 为 `networkAccess:false`；child 明确“无法完成此任务”仍因 app-server turn completed 被记录成 completed |
| 2026-07-23 | Codex network/outcome contracts | actual app-server generated schema + synthetic child terminal text | default/auto/plan + completed/partial/failed | 不发外部请求 | networkAccess boolean、父子 wire 一致、marker 清理、旧失败正文和矛盾 marker fail-closed | ✅ | 权限/Sub-agent/bridge/persistence/policy 组合定向 160/160；`npx tsc --noEmit`、hooks、docs drift、diff check 通过；真实 Qwen smoke 待用户/Claude |
| 2026-07-23 | codex_runtime | GLM parent → Qwen/Kimi child | Qwen 3.8 Max Preview / Kimi for Coding | 用户本地凭据 | Codex 原生联网、权限升级、MCP 工具与失败终态 | ❌ | session `7fc82cb65f2dbb40a10856feac84595e`：sandbox 已声明网络可用，但 `item/permissions/requestApproval` 被错误映射成 command-style `{ decision }`，批准无法生效；第三方 Provider proxy 还丢失 namespace/MCP callable surface；Kimi 的正文后置 outcome marker 被漏解析并误记 completed |
| 2026-07-23 | Codex permission/MCP contracts | current app-server generated schema + synthetic namespace stream | third-party Provider routes | 不发外部请求 | permission subset/scope、session hint、namespace definition/call/result round trip、Kimi mid-text failure marker | ✅ | 相关定向 209/209；`npx tsc --noEmit`、`git diff --check` 通过。全量复跑 4463/4468；5 个失败均为既有 `@pierre/diffs/react` package export 阻断。真实 Provider approval/MCP smoke 待用户/Claude |
| 2026-07-23 | codex_runtime | CodePilot Provider proxy | Qwen 3.8 Max / DeepSeek / Kimi | 用户本地凭据 | 三个指定模型 Sub-agent + Codex native collab 冲突 | ❌ | session `0b385950a86ec7fbeff5bb44508ec76c` 与 parent rollout：除 4 个 managed physical run 外又创建 3 个 native child thread；首个 `spawn_agent(model=qwen3.8-max)` 明确报 unknown model，随后 native workers 全继承父 route；`spawn_agent/wait_agent` 均被显示为 “Codex worker” 胶囊 |
| 2026-07-23 | Codex delegation exclusivity contracts | synthetic native-collab namespace + managed bridge | CodePilot Provider proxy / Codex Account boundary | 不发外部请求 | proxy 移除 `multi_agent_v1`、managed instruction 唯一入口、普通 MCP namespace 保留 | ✅ | 定向 72/72，typecheck 通过；全量 4464/4469，5 个失败仍为既有 `@pierre/diffs/react` package export 阻断。真实三模型胶囊 smoke 待用户/Claude |
| 2026-07-26 | codex_runtime | codex_account + installed app-server rollout | parent/3 native child threads | 用户本地登录 | 原生 collab action/child identity/status 可信展示 | ❌→✅ | session `8c94f9c716fc80e4244d34cb32b2811b`：DB 无 `subagent_runs`，CodePilot transcript 只收到 15 个匿名 `tool=wait`（`receiverThreadIds=[] / agentsStates={}`），spawn 未进入 notification；旧 mapper 因每个 action id 创建胶囊而显示 15 个 “Codex worker 已完成”。修复后真实协议 fixture 断言匿名 15 wait = 0 胶囊；历史 transcript 也按 identity 重新分流；单 child 以 thread id 聚合，outer action status 不再决定 child 状态。定向 147/147、typecheck/ESLint、完整 4659/4659 通过；Electron dev 重载该历史会话实测 “Codex worker”=0、console error=0。identity-bearing live child smoke 仍待跑 |
| 2026-07-23 | stream persistence contracts | isolated SQLite + controllable SSE | text + managed Sub-agent tool blocks | 不发外部请求 | 流中 checkpoint、真实 tool id、同 message id terminal、startup interrupted、stale owner、刷新 UI polling | ✅ | 组合定向 60/60；typecheck/hooks/docs/diff 通过；全量 4467/4472，5 个失败均为既有 `@pierre/diffs/react` package export 阻断 |
| 2026-07-23 | Claude capability/permission/write contracts | synthetic tool surface + approval callback + deferred writers | Memory MCP negative / explicit WebSearch+Write positive | 不发外部请求 | capability fail-closed、MCP 透传、request/timeout run attribution、同目录写串行 | ✅ | `subagent-orchestration.test.ts` 50/50；权限相关组合定向 152/152；typecheck、ESLint（0 error）、hooks、docs drift、diff check 通过。全量 4470/4475；仅 5 个既有 `@pierre/diffs/react` export 加载阻断：`codex-widget-format-contract`、`harness-artifact-contract`、`harness-capability-contract`、`harness-context-compiler`、`widget-system`。真实审批/Provider smoke 仍待用户与 Claude |
| 2026-07-23 | DB isolation cleanup | electron-dev local API + bare targeted test | `collect-owner-gate` synthetic sessions | 不发外部请求 | 精确清理 12 条误写测试会话；裸跑测试不得再次改变 Dev 最近列表 | ✅ | 裸跑定向 4/4、typecheck、docs drift、diff check 均通过；测试后 API `collect-*` 仍为 0，真实五个最近测试会话保持前五 |
| 2026-07-23 | codepilot_runtime | session `ba4855b4c4d272afc85f3a70bbb5b5f4` | Qwen / DeepSeek / Kimi | 用户本地凭据 | 三个 Sub-agent 完成后切到其他会话再切回；完整正文、tool result 与真实终态仍在 | ❌ | 主回合约 39 分钟后确实返回终态，但 session lock 在首个 60s renewal 前已被清除；collector 因 stale owner 丢弃最终 Assistant 内容，只把 1069-byte 早期 tool_use checkpoint 收口为 `interrupted`。两个 permission row 在创建 2 秒后被写成 `aborted / Process restarted`，而 Dev 主进程未重启，直接证明另一个模块实例执行了 `initDb()` startup sweep；该 sweep 随后全局删除 locks。DB 无任何 Native `subagent_runs`，session 还残留 `runtime_status=streaming`；切回只能读取不完整 checkpoint |
| 2026-07-24 | claude_code | session `67d5266867332d91b8a5f88ddbe1d1be` | Qwen 3.8 Max / DeepSeek V4 Pro / Kimi for Coding | 用户本地凭据 | 三 child 研究→写作→页面；核对终态、执行归属和事实来源 | ❌ | 三条 exact route 均真实启动；DeepSeek completed，Qwen/Kimi 均精确 300 秒 timed_out，证明固定墙钟 timeout 误杀仍有活动的 child。旧路径直到 terminal 才写 `result_text`，超时丢失部分正文；父 Agent 后续自行删除旧页面并写新 `index.html`，并非 Kimi 完成。成品还把官方/结果站 `3:41:13` 写成 `3:41:03`，暴露无来源精确事实经 child handoff 被补写。修复后以 5 分钟 idle activity renewal + 30 分钟 hard cap、running partial checkpoint、来源/接管归属合同收口；真实复测待跑。 |
| 2026-07-24 | P0 orchestration contracts | isolated legacy/new SQLite + synthetic Claude/Codex route reports | all managed runtimes | 不发外部请求 | logical run / attempt、active/completed reuse guard、migration、settling、structured result/provenance、typed lifecycle、route mismatch、一个逻辑胶囊 | ✅ | `subagent-run-persistence.test.ts` + `subagent-orchestration.test.ts` + `codex-builtin-bridge.test.ts`：82/82；`npx tsc --noEmit` 通过；active/settling 与 completed 复用反例均未插入新 attempt，三 Runtime Adapter 均保留结构化 conflict code。完整 unit 4484/4489，5 个仍为既有 `@pierre/diffs/react` CommonJS export 阻塞；真实 Provider route report 与 UI retry smoke 仍待用户/Claude。 |
| 2026-07-24 | electron-dev P0 UI | session `67d5266867332d91b8a5f88ddbe1d1be` historical durable rows | Qwen / DeepSeek / Kimi | 无新外部调用 | 三个 logical capsule、terminal 详情、请求/实际路由、logical run/current attempt、durable result | ✅ | DOM 只展示三个历史逻辑任务胶囊；DeepSeek 详情面板可打开并展示 route、Runtime、logical/attempt ID 与结果；legacy migration 未生成虚假事件或 usage；console error=0。该行不代替真实 retry ×N 与 Runtime-reported route mismatch smoke。 |
| 2026-07-24 | Native route/timeout + lifecycle payload contracts | scripted AI SDK response + isolated legacy/new SQLite | CodePilot managed child | 不发外部请求 | `response.modelId` 透传、route mismatch predicate、5/6/30 分钟预算、legacy cursor migration、coalesce 增量、200-event cap、UI merge | ✅ | 本轮组合定向 101/101；typecheck、touched ESLint、hooks、docs drift、diff check 通过。完整 unit 4487/4492；5 个失败逐文件复跑均为既有 `@pierre/diffs/react` `ERR_PACKAGE_PATH_NOT_EXPORTED`。真实 Native fallback/timeout 仍待凭据 smoke。 |
| 2026-07-24 | claude_code | GLM parent → Qwen child | Qwen 3.8 Max Preview | 用户本地 Token Plan | 长联网 child + running 详情 | ❌ | session `76e108aa3eb500ed43e977d3101cba49`：Qwen 持续产生 WebSearch/WebFetch activity，但父回合通用 300 秒 tool timeout 在约 21:08:54 abort 整个 turn，child 被记 cancelled，后续 DeepSeek/Kimi 未启动；transcript id=`call_e65709ee20b14e148f63181b`、DB id=`claude-subagent-7f92c6d0-cb3e-4f5b-95fc-43b401b71779` 导致详情每秒 404；stream error 日志仅 `{}`。 |
| 2026-07-24 | Claude lifecycle contracts | synthetic SDK tool calls/errors + isolated SQLite | managed Claude child | 不发外部请求 | tool-use→attempt correlation、outer timeout exemption、JSON diagnostic、404 bounded polling | ✅ | Sub-agent/persistence 组合定向 72/72；`npx tsc --noEmit`、touched ESLint（0 error，3 个既有 warning）、hooks、docs drift、`git diff --check` 通过。完整 unit 4490/4495；失败仍为既有 5 个 `@pierre/diffs/react` export 加载阻断。 |
| 2026-07-24 | claude_code | GLM parent → Qwen/DeepSeek/Kimi child | Qwen 3.8 Max / DeepSeek V4 / Kimi for Coding | 用户本地凭据 | research → copy → implementation 依赖链 | ❌ | session `3f0085c5fc664deca85005d70b1abfca`：父模型在同一 assistant 批次预生成全部 tool input。Qwen 后来真实完成，但 DeepSeek 的 prompt 已冻结为“等待/目前处于等待状态”，因此未消费 Qwen terminal result，而是另行检索；两次 malformed `required_capabilities=[null,true]/[null]` 又在 durable row 创建前被 SDK schema 拒绝，却被 UI 画成幽灵胶囊。证明 Runtime 的串行 tool execution 不等于依赖结果传递。 |
| 2026-07-24 | shared workflow contracts | isolated SQLite + 三 Adapter source contract | all managed runtimes | 不发外部请求 | queued DAG、terminal handoff、parallel wait、failed/missing dependency、reverse-order deadlock、duplicate/cycle、malformed Claude input、durable-only capsule | ✅ | `subagent-orchestration.test.ts` + `subagent-run-persistence.test.ts`：83/83；`npx tsc --noEmit` 通过。三 Adapter 均消费同一 app-side resolver/compiler；无 durable ownership 不启动 Provider；缺失上游有 5 秒创建宽限，避免串行 Runtime 反序 tool call 永久互等；完整 unit 4501/4506，5 个仍为既有 `@pierre/diffs/react` export 加载阻断。 |
| 2026-07-24 | claude_code | GLM parent → Qwen/DeepSeek/Kimi child | Qwen 3.8 Max / DeepSeek V4 / Kimi for Coding | 用户本地凭据 | workflow migration 首次真实调用 | ❌ | session `f7153c2b01e6a58b31e0406db9be56ec`：父模型正确传入 `workflow_id/task_key/depends_on`，但 dev 进程沿用 migration 前已打开的 SQLite handle；两次 Qwen 调用都在 child 启动前返回 `SUBAGENT_RUN_PERSISTENCE_UNAVAILABLE: no such column: workflow_id`，没有任何 Provider 调用或 durable row。 |
| 2026-07-24 | DB HMR migration contracts | cached isolated SQLite handle + live dev DB | all managed runtimes | 不发外部请求 | 新 migration 在不重启 Dev 客户端时生效，且不重跑 runtime recovery | ✅ | `getDb()` 增加 code-owned schema revision；缓存 handle 的反例测试先移除 workflow index、模拟 stale revision，再验证同 handle 自动重建。组合定向 84/84；完整 unit 4502/4507，5 个仍为既有 `@pierre/diffs/react` export 加载阻断。真实 Dev DB 已自动补齐 `workflow_id/task_key/dependencies_json/dispatch_state`。 |
| 2026-07-25 | Claude review correctness closure | synthetic managed transcript + invalid Codex route + active dependency + cached SQLite handle | codex_runtime / shared UI + workflow | 不发外部请求 | transcript 不冒充 durable row、invalid route 不占 task key、父 Stop 取消 dependency/child、timeout taxonomy、HMR 不 recovery | ✅ | 四文件定向 114/114，typecheck 通过；完整 unit 4505/4510，5 个失败仍精确为既有 `@pierre/diffs/react` export 加载阻断。Dev 客户端 HMR 编译成功；该行不代替真实 Provider/Stop smoke。 |
| 2026-07-25 | Claude follow-up closure | synthetic 404/500 probe、Codex bridge route fixture + queued dependency、short deadline、abort fallback | codex_runtime / shared UI + workflow | 不发外部请求 | terminal 首次 500 可恢复、404 冷却后可恢复、queued Stop durable cancelled、timeout≤grace taxonomy、Node 18 signal compatibility、interrupt registry/wire behavior | ✅ | 四文件定向 120/120；typecheck 与 touched ESLint 通过；完整 unit 4511/4516，新增 6 条均通过，失败仍维持既有 5 个 `@pierre/diffs/react` export 加载阻断。Dev HMR 编译成功；真实 Provider/Stop smoke 仍待跑。 |
| 2026-07-25 | electron-dev 历史会话恢复 | fresh Dev process + Chromium，session `7d3e2a115a9f8fc72854fed1b9b95fbb` | shared UI / details API | 本地既有数据 | durable capsule 恢复、ghost id 有界探测、冷却后低频恢复 | ✅ | 三个 durable logical run 均返回 200 并只展示三个胶囊；历史无 row 的 `cpb_439c8b28aba42969` 先请求 5 次 404，随后 30 秒内仅恢复探测 1 次，无 500、无每秒无限轮询、无 Hook/HMR 告警。该行不代替 terminal 首次 500 mock 或真实 Provider/Stop smoke。 |
| 2026-07-25 | Node test import closure | Widget/Harness 五文件 + Sub-agent 图标回归 + full suite | shared chat UI | 不发外部请求 | 品牌图标导入不得连带加载 Lobe UI/CodeDiff；原 `@pierre/diffs/react` CJS resolver 失败关闭 | ✅ | 六文件定向 211/211；`npm run test` typecheck + unit 4654/4654。反例：品牌目录 `index` 会静态挂载 Avatar 并引入 `@lobehub/ui` barrel；精确 `components/Mono` 导入不触发该链路且仍渲染真实品牌 SVG。 |
| 2026-07-26 | claude_code | Aliyun Token Plan + configured providers | Qwen research → DeepSeek copy → Kimi implementation | 用户本地凭据 | 同一 workflow 的三段真实依赖链 | ✅ | session `01ad12843924e28124a2c679a21deb3f`：DB 三条 child row 的 `runtime=claude_code`；恰好 3 个 durable logical task，依赖按 research→copy→implementation handoff，三条 terminal completed，无 placeholder/ghost 胶囊。原 `codepilot_runtime` 标注错误已于 2026-07-27 更正。 |
| 2026-07-27 | codepilot_runtime | configured Qwen / DeepSeek / Kimi providers | Qwen research → DeepSeek copy → Kimi implementation | 用户本地凭据 | Native 同一 workflow 的三段真实依赖链（同一步并发反例） | ❌ | session `556a136a55617207797385a4322b5b2b`：父模型在同一 assistant step 并发发出三次需审批的 Agent 调用；审批 UI 先放行 Kimi，upstream durable row 尚不存在，implementation 以 `DEPENDENCY_NOT_FOUND` fail-closed。该尝试不计作通过，也没有用 Claude 子进程冒充 Native；暴露的 ask-mode 审批排序限制记入 tech-debt #58。 |
| 2026-07-27 | codepilot_runtime | Qwen Token Plan Personal / DeepSeek / Kimi Coding Plan | Qwen research → DeepSeek copy → Kimi implementation | 用户本地凭据 | Native 同一 workflow 严格顺序三段真实依赖链 | ✅ | session `a71b037dc35f20dc7c8efd31427d4dff` / workflow `native-chain-smoke-sequential-20260727`：UI 恰好 3 个 completed 胶囊；DB 恰好 3 个 logical run，`runtime=codepilot_runtime` 3/3、`terminal=1 + phase=terminal + dispatch_state=terminal` 3/3，依赖为 `[] → [research] → [copy]`；effective model 依次 `qwen3.8-max-preview / deepseek-v4-pro / kimi-for-coding`，最终 JSON 完整保留两个 marker 与 `17/29/43`。父 session `runtime_pin=codepilot_runtime`、`runtime_status=idle`。 |
| 2026-07-27 | Codex model display contracts | synthetic Kimi route + raw app-server selector | `sonnet` → Kimi for Coding；真实 mismatch → raw report | 不发外部请求 | route identity 校验与用户可见 effective model 分离 | ✅ | `normalizeCodexSubagentEffectiveModel` 仅在 raw report 属于已验证 route 时返回 `route.displayName`；`runtime-init.payload.runtimeReportedModel` 保留原始 `sonnet` breadcrumb，`gpt-5.6` 等 mismatch 不会被改名。 |
| 2026-07-26 | codepilot_runtime | Aliyun Token Plan | Qwen 3.8 Max Preview | 用户本地凭据 | child 持续 activity 超过 300 秒；切换聊天后再返回，durable result/胶囊/详情恢复 | ✅ | session `c2a85dbea347a9ff40cad2a59f7f7201`：15:31:04→15:36:32 共 328 秒后真实 completed；切回后一个 completed 胶囊、完整结果与详情仍可读，SSE/DB 已终态。 |
| 2026-07-26 | codepilot_runtime | invalid configured route | 不可用 child route/capability | 用户本地配置 | spawn 前 route/capability fail-closed | ✅ | session `0748bf2717460da4cfdd5a2752856d31`：结构化拒绝并要求用户处理，0 个 child durable row，不伪造执行。 |
| 2026-07-26 | codepilot_runtime | Aliyun Token Plan | running Qwen + queued dependent child | 用户本地凭据 | parent Stop 贯穿 executing/queued child | ✅ | session `bdf81a0052a36d0ae0889f5d876a8106`：两条 child 均 durable cancelled，parent runtime idle、lock=0；queued child 未被误启动。 |
| 2026-07-26 | codex_runtime | codex_account + CodePilot Qwen route | GPT-5.6 parent / Qwen child | login + 用户本地 Provider 凭据 | Account dynamic local tool running 时显式 Stop | ✅ | session `6ac2347949089dd8bacee7c224b32181`：单次 tool_use、单胶囊；Stop 同时终止父 turn 与 child，wire/result/DB/UI 均 cancelled，runtime idle、lock=0。 |
| _待跑_ | electron-dev | 任意长回复 + Sub-agent | 任意 | 用户本地配置 | Sub-agent 运行中刷新；正文/胶囊不丢、状态非假完成、最终不重复 | 📋 | |

## 决策日志

- 2026-07-22：用户明确授权 Codex 实现。选择 same-runtime foreground 作为首版；固定 Profile 与跨 Runtime Broker 后移。
- 2026-07-22：UI 历史首版复用已持久化 tool/collab transcript，不以新 DB 表作为模型切换的阻塞条件；如果无法从 transcript 稳定恢复 run，再启动 `agent_runs` schema spike，不能用 local-only 假历史冒充 durable session。
- 2026-07-22：Codex 仅在实际 app-server schema 可证明时开放；宿主 PATH 版本不是能力事实源。
- 2026-07-22：agent-run tab 不持久化 prompt/result 到 localStorage；chat tool blocks 是 durable source，点击历史卡片重建，减少敏感内容副本。
- 2026-07-22：用户首轮验证证明当前 Claude Code 路由不能跨到 Grok/xAI；unsupported model 必须 fail-closed 并询问用户下一步。
- 2026-07-22：第二轮反馈纠正“三档白名单”过度修复：AgentInput 的三项是 Provider-relative role slot，不代表 Claude Code 只能运行 Anthropic 模型；`AgentDefinition.model` 可承载当前兼容 Provider 的完整模型 ID。门禁改为 catalog / role mapping / effective route 驱动，Kimi、GLM、DeepSeek 等不再按品牌误杀。
- 2026-07-22：真实历史会话证明“model 留空/sonnet + prompt 写你是 Grok 专家”也会制造假切模；shipping boundary 增加窄范围角色伪装检测，同时保留普通 Grok 主题研究任务。
- 2026-07-22：用户首轮验证还暴露 async launch 被误判完成、Runtime 胶囊无动作价值、卡片顺序与首轮 sidebar mount 时序问题；对应修复已通过 164 项定向回归与 dev client UI smoke，首轮旧 smoke 不作为新行为证据。
- 2026-07-22：第二轮验证证明 `AgentDefinition.model` 仍复用父 subprocess 的 Provider endpoint，不能承担产品级跨 Provider 模型切换；改为 managed MCP + 独立 SDK child。产品路由唯一规则是 Claude Code picker 未置灰集合，不再生成“继承主 Agent”Profile。
- 2026-07-22：UI 从两行卡片收敛为可换行的单行胶囊；提示词只留详情面板，详情在 running 阶段即可打开。
- 2026-07-23（Signal/Triage）：用户要求 3 个逻辑 Sub-agent，却看到 6 个胶囊；数据库与 transcript 证明不是 UI 重复渲染，而是父 Agent 把 one-shot child 当成可待命/续跑 worker，实际发起了 6 次 managed tool 调用。Qwen 的 403 又被 SDK `success` envelope + 错误正文误判为完成，并触发 fallback 链。
- 2026-07-23（Fix/Guardrail）：终态改以 `is_error` / `api_error_status` 为事实源；新增结构化 error、partial/timed_out；managed tool 强制声明任务能力并明确 one-shot/no-placeholder/no-resume。无真实搜索工具时 live research 仍 fail closed。物理 attempt 不做 UI 去重，后续以 logical run + attempt 模型真实聚合。
- 2026-07-23（Signal/Triage）：用户复测发现 CodePilot Runtime 只能看到父 Provider 的 `sonnet / haiku` 协议槽位，Codex Runtime直接回答无法调用。根因分别是 Native Agent 错误使用 same-provider allowlist，以及 Codex 仅做 collab 可见性、没有可执行的 per-child route bridge；`sonnet / haiku` 在该会话实际是 GLM Provider 的内部 alias，不是 Claude 调用，但暴露给父模型的选择语义仍然错误。
- 2026-07-23（Fix/Guardrail）：CodePilot Native 改为 Runtime-compatible 的 exact Provider+Model route，并将目标 Provider贯穿工具装配与 `runAgentLoop`。Codex 原生 spawn 只能继承父 provider config，因此不拿它冒充跨 Provider；改由已有 Provider proxy bridge 新建显式目标 route 的 child thread，并以 thread ID 隔离父子通知。Codex Account 继续保持原生能力边界。
- 2026-07-23（Signal/Triage/Fix）：用户指出 Claude Code / Codex 原生已有工具权限与 sandbox，CodePilot 固定 Read/Glob/Grep 属于过度限制。三条 managed path 改为继承父工具与权限：Native 保留 permission wrapper，Claude 透传 tools/MCP/permission/canUseTool，Codex 透传 sandbox/approval/MCP；仅硬移除递归委派。Codex proxy 同时接通支持 Provider 的 hosted Web/X Search。
- 2026-07-23（Signal/Triage）：真实 Codex 会话 `1d154cca69c53c23091b43d8f55100a6` 不是“Qwen 缺联网工具”的单点问题。`codepilot_spawn_subagent` 已被 AI SDK bridge 执行，但 suppression set 只取 Runtime capability catalog，漏掉 spawn 名称，随后重复回传 app-server 并报 `unsupported call`；同时 dynamic bridge 只允许 Memory MCP，形成第二套非 Codex 原生边界。
- 2026-07-23（Fix/Guardrail）：保留独立 child thread 以精确切换 CodePilot Provider+Model，但把工具所有权还给 Codex。删除 Codex `required_capabilities` schema/gate 和 Memory-only dynamic allowlist；所有 namespaced MCP call 交给 Codex MCP manager，父 sandbox/approval/elicitation 原样生效；所有 proxy 内已执行 bridge/hosted tool 都进入 suppression set。只保留递归 spawn 禁止。
- 2026-07-23（Signal/Triage）：会话 `da6880f2bd89ed3fd030ee20abcf63d0` 证明 UI 与父模型都缺少 fail-closed lifecycle 合同。实际 managed call 已 foreground 等待并返回终态，但父模型仍按“launch receipt”叙述；`subagent-view` 对未知非错误 result 又默认 completed，二者会产生“胶囊完成、正文说仍运行”的矛盾。
- 2026-07-23（Fix/Guardrail）：所有 managed result wire 增加 `terminal` 布尔值；三 Runtime 工具说明明确 blocking/no-background/依赖输出传递。UI 仅以结构化 terminal metadata 或 Codex collab payload.status 判终态，managed plain receipt、显式 background 与 Codex inProgress 一律保持 running。
- 2026-07-23（Signal/Triage）：继续复核会话 `da6880f2bd89ed3fd030ee20abcf63d0` 发现更深一层：Codex proxy 为避免 bridge tool 回传 app-server 触发 `unsupported call`，会抑制 function_call 并丢弃 tool-result，只通过瞬时 side-channel 给 UI；所以下一回合没有 child run 事实。用户问“进展怎么样”时父 Agent 只能 `ls` 猜测，还把聊天前 11 小时已存在的 HTML 误认成 child 产物。
- 2026-07-23（Fix/Guardrail）：保留 bridge suppression，但新增 additive `subagent_runs` 表作为 Codex managed physical-run 事实源。spawn 必须先持久化再启动，持久化失败则 child 不启动；terminal update 带 `WHERE terminal=0`，迟到事件不能改写。后续 proxy 回合自动注入不含 prompt/result 的状态快照，并挂载只读 `codepilot_list_subagent_runs`，明确禁止从 plan/正文/文件猜进度。验证：持久化 5/5、组合定向 131/131；真实 Provider 两回合 smoke 待用户/Claude。
- 2026-07-23（Signal/Triage）：会话 `1ff7d214c15e2ed2ba590b3183fe1293` 里 requested/effective model 都是 Qwen 3.8 Max，证明不是换模失败。根因是 canonical Codex permission wire 对 default/auto/plan 全部发送 `networkAccess:false`，而 Qwen Token Plan 不具备官方 hosted search；child 只能用被断网的原生 Shell。同时 `normalizeCodexSubagentTurn` 把 app-server turn completed + 非空失败说明误当任务成功。
- 2026-07-23（Fix/Guardrail）：用当前实际 app-server `0.145.0-alpha.27` 生成 `SandboxPolicy` 证明 networkAccess 是 boolean；readOnly/workspaceWrite 统一改为 true，child 继续继承父 wire，文件 sandbox/reviewer 不变。child final answer 增加结构化 task outcome，normalizer 分离 turn terminal 与 task success；明确失败正文和 completed marker 冲突时 fail closed。验证：组合定向 160/160、typecheck/规则检查通过、全量 4456/4461（5 个既有依赖加载阻断）；真实 Qwen 联网 smoke 待用户/Claude。
- 2026-07-23（Signal/Triage）：真实会话 `7fc82cb65f2dbb40a10856feac84595e` 继续失败并非 Qwen/Kimi 天生无工具。Codex child 已收到 `networkAccess:true`，但升级网络/文件权限走 `item/permissions/requestApproval` 时，CodePilot 仍按 command approval 回 `{ decision }`；当前 app-server 要求 `{ permissions, scope }`，所以用户批准也不会变成真实 grant。另一路，proxy 虽保留 `namespace` descriptor，却未向第三方 Provider 展开嵌套 MCP tools；Kimi 还把 outcome marker 放在正文末尾，旧 parser 只认开头。
- 2026-07-23（Fix/Guardrail）：按当前 app-server 生成 schema 实现 method-specific permissions response：allow 只回显原请求 subset，session/turn scope 由真实 UI 决策决定，deny 回空 permissions。namespace MCP member 以 definition-only function 暴露给第三方 Provider，历史 call 名与新 tool call 都双向恢复 `(namespace, name)` 后交回 Codex 执行；不在 CodePilot 复制 Shell/文件工具。outcome parser 改为扫描正文中任意位置的平衡 JSON marker，并补“无法完成这个任务”失败语义。验证：定向 209/209、typecheck/diff check 通过；真实 Provider approval/MCP smoke 待用户与 Claude。
- 2026-07-23（Signal/Triage）：会话 `0b385950a86ec7fbeff5bb44508ec76c` 的多余 “Codex worker” 不是 UI 重复同一 managed run。parent rollout 记录了 `multi_agent_v1.spawn_agent/wait_agent`：首个 Qwen native spawn 明确返回仅支持 GPT 模型，后续三个 native worker 未带目标模型、继承父 route；同时 proxy side-channel 又产生 4 个真实 managed physical run。event mapper 会把每个 collab 控制 call 当 Sub-agent card，因而胶囊数量进一步膨胀，正文还错误声称 native workers 分别是指定模型。
- 2026-07-23（Fix/Guardrail）：namespace 兼容桥继续透传普通 MCP，但在 CodePilot Provider proxy 精确过滤 `multi_agent_v1`，只保留 `codepilot_spawn_subagent`；managed tool description 与 provider system instruction 同时写明不得用 native spawn/wait 包裹。Codex Account 不经过该 proxy，因此原生 collab 能力不受影响。验证：定向 72/72、全量 4464/4469（5 个既有依赖导出阻断）；真实三模型 UI smoke 待用户与 Claude。
- 2026-07-23（Signal/Triage）：用户刷新 dev 客户端后，刚完成的测试会话看似“记录全没了”。数据库核验发现 session 与 `subagent_runs` 仍在，但 Assistant message 为 0、runtime_error 为 `Process restarted`；根因是 server collector 只在 SSE 完整结束后一次性 `addMessage`，刷新/重启杀掉 collector 时没有 durable transcript。
- 2026-07-23（Fix/Guardrail）：Assistant 从首个有效 text/thinking/tool block 开始写 `messages.stream_status=streaming` checkpoint，120ms 节流且 tool/result 强制即时写；终态更新同一 message id，刷新后的 ChatView 只在存在 streaming row 时轮询并显示真实状态。startup 将遗留 streaming 幂等改为 interrupted，stale owner 只能收口旧 checkpoint、不能回灌新内容。
- 2026-07-23（Signal/Triage）：Claude review P2 复核确认 `hasMcp` 让常驻 `codepilot-memory` 同时获得 read/network/write，导致 live research preflight 实际 fail-open；managed child 裸透传父 `canUseTool` 让权限 UI 无 child 归属；并发 2 在写权限开放后允许两个模型同时改同一工作树。
- 2026-07-23（Fix/Guardrail）：capability 改为 Claude built-in surface 逐项证明，MCP 完整继承但不再凭 server presence 生成能力；permission callback 用隐藏 transport metadata 注入唯一 run/session/name，request 与 timeout 事件同源，UI 显示 Agent；声明 `write_workspace` 的 child 按 working-directory realpath 排队。50/50 单文件定向、152/152 权限相关组合定向与 typecheck/规则检查通过；全量 4470/4475，仅余 5 个既有依赖 export 加载阻断。真实审批/Provider smoke 仍按 Ledger 待跑。
- 2026-07-23（Signal/Triage）：刷新后“最近几个仍没展示”不是 sidebar 排序失败。定位到本轮曾裸跑 `collect-owner-gate.test.ts`，漏带全局 DB isolation preload，三轮共 12 条 `collect-*` synthetic session 写入真实 Dev DB，占满最近列表；用户会话本身仍存在。
- 2026-07-23（Fix/Verify/Guardrail）：通过本机 session DELETE API 按已核对 ID 精确删除 12 条测试会话，未删除用户会话；API 复核 `collect-*`=0，`0b385…`、`7fc82…`、`1ff7…`、`da688…`、`1d154…` 恢复为最近前五。`collect-owner-gate.test.ts` 现在首 import `db-isolation.setup.ts`，使单文件裸跑也只能写 per-worker temp DB，避免同类污染。
- 2026-07-23（Signal/Triage）：真实 CodePilot Runtime 会话 `ba4855b4c4d272afc85f3a70bbb5b5f4` 推翻“checkpoint 已解决切换/刷新防丢”的结论。日志证明主回合继续执行约 39 分钟并到达终态，但 lock 在首个 60s renewal 前已消失；owner gate 随后按设计拒绝 terminal 回灌，并把早期 checkpoint 标成 interrupted。数据库只剩两个 Native Agent tool_use、没有 tool_result，且 `subagent_runs` 的生产者实际只有 Codex bridge，Native/Claude child 没有独立 durable result。决定性证据是两个 permission row 在创建 2 秒后均变成 `aborted`，message 精确为只有 startup sweep 才写入的 `Process restarted`，而 Electron/Next 主进程未重启：`initDb()` 被另一个 Next route/module 实例执行，先中断所有 streaming row / pending permission，再 `DELETE FROM session_runtime_locks`。此外 `request.signal → abortController → 8s settle` 仍会把真正的客户端断连等同显式 Stop。修复应同时区分“显式用户取消 / 客户端离开 / 真正进程重启”，把 recovery sweep 移到单一 app-start owner，并让三 Runtime child lifecycle 都落 durable run；不能仅放宽 stale-owner gate。
- 2026-07-23（Fix/Verify/Guardrail）：`initDb()` 现只负责 schema/migration；运行态 recovery 由按绝对 DB path 共享的进程 owner file + exclusive lock 守门，owner PID 存活时重复模块初始化严格 no-op，真正重启才回收 streaming/permission/lock/unfinished run。`/api/chat` 不再把 request transport abort 接到 Runtime，renderer 切换聊天只 detach；首轮显式 Stop 会先调用 interrupt API。Native `Agent`、Claude managed MCP 与 Codex bridge 都在 Provider 调用前创建 durable run，并在 completed/partial/failed/cancelled/timed_out 收口，创建/收口失败均 fail closed。69/69 最新定向与数据库兼容组合通过；真实长任务切换聊天 smoke 待跑。
- 2026-07-24（Signal/Triage）：会话 `67d5266867332d91b8a5f88ddbe1d1be` 没有复发切换聊天即取消，但 Claude managed Qwen/Kimi 都在启动后精确 300 秒进入 timed_out。代码核对确认 timeout 是从 spawn 开始固定计时，不读取 SDK activity；运行中 `subagent_runs.result_text` 始终为空，timeout normalizer 也丢弃 `partialText`。同时父 Agent 在 Kimi 超时后自行完成页面，却未清晰标注接管；DeepSeek 获得的稀疏无来源事实最终产生十秒成绩误差。
- 2026-07-24（Fix/Verify/Guardrail）：Claude child 改为每条 SDK message 续期五分钟 idle timer，三十分钟 hard cap 不续期；assistant 文字以 64 KiB bounded checkpoint 写入仍为 running 的 durable row，terminal 后迟到 checkpoint 原子 no-op，timeout/cancel 保留部分正文。父 routing 与 child system contract 增加来源 URL、反补写精确事实、文件完成证据和父接管归属。定向 59/59、`npm run test`（typecheck + 全量 unit）、hooks、docs drift 与 diff check 全部通过；真实长任务/来源 smoke 待用户与 Claude。
- 2026-07-24（Signal/Triage）：对标补充调研与既有六胶囊/假完成事故共同证明，physical tool call 不能同时承担用户任务身份、重试身份和完成事实；只靠提示词约束 one-shot 也无法解释真实重试。请求路由同样不能证明实际生效路由，child 回合停止更不能证明结果已经 durable。
- 2026-07-24（Fix/Verify/Guardrail）：新增 logical run / physical attempt 分层与 additive legacy backfill；重试复用 `logical_run_id`，SQLite 保留全部 attempt，父快照/UI 聚合为一个胶囊。Claude/Codex 核验 Runtime 报告模型并对静默替换返回 `ROUTE_MISMATCH`；终态增加 settling 屏障、统一 structured result/provenance 和 typed lifecycle event。定向 79/79、typecheck/hooks/docs/diff 通过；完整 unit 4481/4486，5 个仅为既有 `@pierre/diffs/react` export 阻塞；真实 Provider/UI smoke 保持 Ledger 待跑，不把合同测试冒充凭据验证。
- 2026-07-24（Review reconcile）：Claude 对 research 文档复核后补齐 attempt 关联缺省、structured error、budget 现状、settling schema 落点及 capability/permission 已知项。执行事实确认：只有显式 `logical_run_id` 才聚合，缺省新建 logical run；`error_max_turns → partial`，`error_max_budget_usd → failed / MAX_BUDGET`；`settling` 使用独立 phase 列；`hasMcp` fail-open 与 child 权限归属已在前序切片修复。`costUsd` 已明确币种，measurement source 留 P1。
- 2026-07-24（Signal/Triage）：Claude P2 复核确认 prompt-only 的 retry 约束不足。父模型若复用 active logical ID 会产生同逻辑并行 attempt；复用 completed ID 会让最新失败 attempt 在胶囊上遮蔽已交付成功结果。
- 2026-07-24（Fix/Verify/Guardrail）：`startSubagentRun` 在同一事务内检查显式 logical ID 的最新 attempt；active/settling 与 completed 分别结构化拒绝为 `LOGICAL_RUN_STILL_RUNNING` / `LOGICAL_RUN_ALREADY_COMPLETED`，三 Runtime 都在 Provider 启动前消费该拒绝且不伪造 durable attempt。两条 DB 反例、error wire 与三 Adapter source contract 进入 82/82 定向套件；完整 unit 4484/4489，仅余 5 个既有依赖 export 加载失败。版本后缀 route report 进入真实 Smoke Ledger，settling 重启副作用风险留 tech-debt #58。
- 2026-07-24（Signal/Triage）：Claude smoke 前复核发现 Native 仍把 requested route 直接回填成 effective、managed child 沿用全关闭 timeout；同时 lifecycle card 每秒拉取全部 attempts + 最多 500 条完整事件，事件表没有 retention。另确认写串行实际只有 Claude adapter，Native/Codex/跨 Runtime 没有共享锁，guardrail 不得超前宣称通用保证。
- 2026-07-24（Fix/Verify/Guardrail）：Native `runAgentLoop` 透传 AI SDK `response.modelId`，managed adapter 做 exact route 核验并对 fallback 记录 `route_warning/ROUTE_MISMATCH`；只给 managed child 加 connect/first-token 5 分钟、tool 6 分钟、total 30 分钟预算，普通 Native chat 默认不变。事件表增加 additive monotonic cursor（legacy rowid backfill）与 `(logical_run_id,cursor)/(run_id,cursor)` 索引，coalesce 更新也推进 cursor；每 attempt 保留最近 200 条，API/UI 按 `after_cursor` 增量合并。写并发边界已在 PermissionBoundary 与 tech-debt #58 改成 Claude-only 事实。组合定向 101/101；完整 unit 4487/4492，5 个仍为既有 `@pierre/diffs/react` export 加载阻断；真实 Provider smoke 继续待跑。
- 2026-07-24（Signal/Triage）：真实会话 `76e108aa3eb500ed43e977d3101cba49` 中 Qwen child 持续执行 WebSearch/WebFetch，却在父回合启动后约 300 秒被取消。根因不是 child idle timeout，而是 `claude-client` 的通用 `tool_progress` timeout abort 了整个父 AbortController；MCP handler 又另造 UUID，运行中 transcript 的 `call_*` 无法查询 durable row，形成每秒 404；Next dev 对对象式 Error 日志只输出 `{}`。
- 2026-07-24（Fix/Verify/Guardrail）：managed spawn 从通用 tool timeout 排除，保留 child 自有 5 分钟 idle renewal / 30 分钟 hard cap。每个 parent stream 建立有界 one-shot correlation，PreToolUse 的真实 tool-use id 成为 physical attempt/权限/详情共同身份；显式 retry 仍用旧 logical id 聚合。详情 404 在 5 次 spawn-race 宽限后跨 remount 停止，stream error 改为单 JSON 字符串。组合定向 72/72、typecheck、touched ESLint、hooks/docs/diff 通过；完整 unit 4490/4495，5 个失败仍为既有依赖加载阻断；真实 >300 秒 Provider smoke 保持待跑。
- 2026-07-24（Signal/Triage）：会话 `3f0085c5fc664deca85005d70b1abfca` 证明 one-shot 文案仍不足以表达真实依赖。Claude 在同一 assistant 批次先冻结 Qwen、DeepSeek、Kimi 三个 tool input；SDK 后续即使串行执行，也不会把 Qwen 结果回填进已生成的 DeepSeek prompt。另有两个 malformed capability call 在应用 handler 前被 schema 拒绝，UI 仍按 tool arrival 生成幽灵胶囊。
- 2026-07-24（Fix/Verify/Guardrail）：不再分别修 Claude/Native/Codex 的“等待”行为。新增 app-owned workflow DAG：三 Adapter 只声明 `workflow_id/task_key/depends_on`，SQLite 保存 queued/executing 与依赖边，统一 resolver 等待 durable terminal，统一 compiler 在 Runtime 启动前注入上游结果。重复 task、self/indirect cycle、失败依赖、durable ownership 丢失全部 fail-closed；缺失上游只给并行创建 5 秒宽限，随后明确要求先创建 upstream，避免串行 Runtime 因反序 tool call 卡死。Claude malformed capability 进入应用层结构化错误；managed 胶囊只认 durable row。83/83 定向与 typecheck 通过，真实三 Provider 链保持 Ledger 待跑。
- 2026-07-24（Signal/Triage）：会话 `f7153c2b01e6a58b31e0406db9be56ec` 中父模型已正确声明 workflow DAG，但两次 Qwen 调用均在 durable row 创建前报 `no such column: workflow_id`。根因是 Next dev HMR 保留进程级 SQLite handle；新增 migration 只在 `state.db` 首次打开时执行，热更新后的 SQL 与旧表形状直接相撞。
- 2026-07-24（Fix/Verify/Guardrail）：`getDb()` 增加 code-owned `DATABASE_SCHEMA_REVISION`，新模块加载后即使复用同一 handle 也会在 migration lock 下重跑纯结构、幂等 `initDb/migrateDb`；runtime startup recovery 仍只在真正打开 DB 时运行，避免重现活任务被 HMR 中断。缓存-handle 反例进入持久化测试；定向 84/84、typecheck、touched ESLint/hooks/docs-drift 通过，完整 unit 4502/4507（5 个既有依赖 export 阻断）。Dev DB 已无需重启补齐 workflow 四列，真实三 Provider 链仍待复测。
- 2026-07-25（Review/Triage）：Claude 复核指出生产渲染链始终传 `run`，导致原 durable gate 把 transcript 误当 DB 证据；Codex 又先占 workflow task key 再检查初始 route，并只把 proxy transport signal 接到依赖等待。另有 timeout 仍复用 `DEPENDENCY_NOT_FOUND`、cached-handle 测试未直接证明 recovery 不会触发。
- 2026-07-25（Fix/Verify/Guardrail）：`SubagentRunView` 显式携带 `requiresDurableEvidence`，卡片只有 details API 200 才展示 managed run；Codex 初始 route 在持久化前拒绝，持久化后仍二次核验；父 Runtime AbortSignal 通过进程级 context 贯穿 dependency wait 与 child，transport abort 合并为 fallback；deadline 使用 `DEPENDENCY_TIMEOUT`。HMR 测试保留 live streaming row 证明不 recovery。四文件定向 114/114、typecheck 通过；完整 unit 4505/4510，仅余 5 个既有依赖 export 阻断；真实 Provider/Stop smoke 仍待用户与 Claude。
- 2026-07-25（Review/Triage）：Claude follow-up 发现 terminal managed 胶囊首次 details 请求若遇 500/网络异常会永久停在 unknown；404 五次上限也会让迟到 row 只能靠整页刷新恢复。queued parent Stop 只有 resolver 分段测试，没有穿透 Codex bridge 的 terminal 持久化证据；另有 `timeoutMs <= grace` 误报 TIMEOUT、`AbortSignal.any` 对 Node 18 开发基线缺少 fallback，以及 interrupt 合同过度依赖 source regex。
- 2026-07-25（Fix/Verify/Guardrail）：详情探测改为 5 次快速 burst 后每 30 秒一次恢复 probe，404 与 transient 语义分开且成功后清空状态；Codex bridge 增加窄 DI seam，真实 execute 测试证明 queued Stop 不启动 Provider，并收口为 durable cancelled。dependency loop 在 deadline 边界最后查询一次；signal 组合提供清理 listener 的 fallback；turn interrupt 抽出行为可测 registry/wire，仅保留 live app-server 集成点 source pin。四文件定向 120/120、typecheck/touched ESLint 通过；完整 unit 4511/4516，5 个失败仍为既有依赖 export 阻断；真实 Provider/Stop smoke 继续待跑。
- 2026-07-25（Smoke）：干净重启 electron-dev 后打开历史 session `7d3e2a115a9f8fc72854fed1b9b95fbb`；三个 durable run 恢复为三个胶囊，单个历史 ghost id 的请求节奏为 5 次快速 404 + 30 秒后一次恢复 probe，未复现 500、无限轮询或 HMR Hook 告警。真实 Provider/Stop 与首次 500 注入 smoke 仍保留为待跑。
- 2026-07-25（Signal/Triage）：正常提交门禁暴露 5 个长期被归为“既有依赖”的加载失败。实际根因是 `SubagentModelIcon` 从 `@lobehub/icons/es/<Brand>` 品牌 barrel 导入；该入口为默认组件挂载 Avatar，Avatar 继续引入 `@lobehub/ui` 全量 barrel 和 CodeDiff。tsx 的 CommonJS 测试加载器随后解析到仅声明 `import` condition 的 `@pierre/diffs/react`，在测试正文执行前报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- 2026-07-25（Fix/Verify/Guardrail）：模型胶囊只需要 Mono SVG，现精确导入十个品牌的 `components/Mono`，不修改第三方 package exports、不为测试伪造 alias，也不把无关 UI/Diff 子系统带进聊天组件。新增真实 server-render 图标回归；原五文件加 Sub-agent 定向 211/211，完整 `npm run test` typecheck + unit 4654/4654，全量门禁恢复为绿。
- 2026-07-26（Signal/Triage）：真实 Codex Account 会话 `8c94f9c716fc80e4244d34cb32b2811b` 要求 3 个 native child，却显示 15 个无名称/模型的 “Codex worker 已完成”。SQLite 中该会话无 managed `subagent_runs`；CodePilot transcript 的 15 个 `collabAgentToolCall` 全是匿名 `wait`，spawn 根本未进入客户端 notification。旧 event mapper 无视 `item.tool` 和 child identity，把每个 action id 当独立 child；`subagent-view` 又把 outer wait `status=completed` 当 child completed。该事故属于 Codex Account 原生协作的产品可观测性缺口，不是 managed bridge 路由回归。
- 2026-07-26（Fix/Verify/Guardrail）：Codex collab mapper 现在只有在 `receiverThreadIds + agentsStates keys` 恰好证明一个 child thread 时才生成 `codex_subagent`；匿名/多 child action 降级为普通 `codex_collaboration_<action>` 工具活动。历史与 streaming 渲染链都增加 instance-level identity gate，因此旧 transcript 的匿名 `codex_subagent` 也不会在刷新后复活。原生胶囊用 child thread id 聚合，并只从该 child 的 `agentsStates` 读取 running/completed/errored/interrupted/shutdown；outer action status 不再抬升 child。真实协议反例覆盖 15 个匿名 wait、单 child、多 child和 action-failed/child-running 冲突；定向 147/147、typecheck/ESLint、完整 unit 4659/4659 通过。Codex Account 原生 durable ingestion 与跨 Provider 拦截保持为独立产品决策。
- 2026-07-26（Smoke）：在运行中的 Electron dev 客户端直接重载事故会话 `8c94f9c716fc80e4244d34cb32b2811b`，历史正文与普通工具活动仍在，“Codex worker” 胶囊数量从旧行为 15 降为 0，浏览器 console error 为 0。该 smoke 证明 legacy transcript identity gate 生效；当前 app-server 若未来上报 identity-bearing child 的真实聚合/状态仍保留独立 smoke。
- 2026-07-26（Product decision）：Codex Account 不再被迫在“native worker 可执行但不能指定 CodePilot route”和“完全没有多模型能力”之间二选一。采用双通道：native collab 继续服务继承父 Codex route 的 worker，并对缺失 identity fail-closed；用户明确指定 CodePilot Provider+Model 时，app-server 注册 managed dynamic tools，复用三 Runtime 共用的 route/workflow/durable bridge。主 Agent 仍是用户当前选择的 Codex Account GPT-5.6，不偷换父会话。
- 2026-07-26（Signal/Triage）：Codex Account 第一次 managed smoke 先因 initialize 未声明 `experimentalApi` 被 app-server 拒绝；接通后同一 physical call 又同时从本地 side-channel 与 app-server mirror 产生重复 tool_use/result。第一次 Stop smoke 中，`turn/interrupt` 没有打断阻塞的本地 `item/tool/call`，child 继续运行；其晚到 completed 结果还试图覆盖已经落库的 cancelled。
- 2026-07-26（Fix/Verify/Guardrail）：initialize 明确声明 experimental API；dynamic tools 只在 `thread/start` 注入，feature fingerprint 让旧 thread 安全换新；HMR-safe dispatcher 按真实 Codex thread id 路由并只清理同 owner，managed local mirror lifecycle 被抑制。Codex turn 注册父 AbortController，显式 Stop 同时本地 abort 与发送 `turn/interrupt`；三 Adapter terminal wrapper 都重读 immutable durable record。相关定向 122/122、start/resume/session 兼容回归 47/47、最终 `npm run test` 4675/4675 通过；touched ESLint 0 error，hooks/docs-drift/diff check 全绿。
- 2026-07-26（Real smoke，2026-07-27 更正 Runtime）：Claude Code session `01ad12843924e28124a2c679a21deb3f` 与 Codex Account session `aceb4956ff3c498aa3f054fb95571c88` 均完成 Qwen→DeepSeek→Kimi 三段真实依赖链，只有 3 个 logical 胶囊；前者 DB 三行 `runtime` 均为 `claude_code`，此前写成 CodePilot Native 属台账错误，Native 三段依赖链恢复待跑。长任务 session `c2a85dbea347a9ff40cad2a59f7f7201` 连续运行 328 秒后完成并可跨聊天恢复；invalid route session `0748bf2717460da4cfdd5a2752856d31` 在 child 启动前 fail-closed。CodePilot Stop `bdf81a0052a36d0ae0889f5d876a8106` 与 Codex Account Stop `6ac2347949089dd8bacee7c224b32181` 均收口 durable cancelled、parent idle、lock=0。
- 2026-07-27（Review/Triage）：Claude 复核直接查询六个 smoke 会话后发现 `01ad…` 三条 durable row 实际均为 `claude_code`，推翻 Native 依赖链已 smoke 的台账声明；受影响的不只是 Ledger 行，还包括 Phase 4/6 状态、Phase 6 checklist 与决策日志。同时 `aceb…` 的 Kimi row 把 app-server 协议 selector `sonnet` 直接存入 `effective_model`，导致胶囊/详情违背“协议槽位不得冒充用户模型”的合同。
- 2026-07-27（Fix/Verify/Guardrail）：台账所有受影响声明已统一降级，Native 三段链新增独立待跑行并要求 DB `runtime=codepilot_runtime` 为证。Codex 新增与 Claude 对齐的 effective-model 归一化：先用 raw report 做 exact route 校验，成功后用户可见值使用 `route.displayName`；原始 `sonnet` 保存在 `runtime-init` lifecycle payload 的 `runtimeReportedModel`，真实 mismatch 仍保留原值并 fail-closed。历史 `aceb…` row 不静默反写，继续作为旧显示事故证据。Sub-agent 定向 114/114、最终 `npm run test` 4677/4677、touched ESLint、hooks/docs-drift 与 diff check 全部通过。
- 2026-07-27（Smoke/Verify/Commit）：commit `483cac1a` 收口三 Runtime managed delegation。Native session `a71b037dc35f20dc7c8efd31427d4dff` 的 UI 恰好 3 个 completed 胶囊；DB 恰好 3 个 logical run，`runtime=codepilot_runtime` 与 terminal/dispatch 不变量均为 3/3，Qwen → DeepSeek → Kimi 结果完整透传。反例 session `556a136a55617207797385a4322b5b2b` 在同一步并发审批时因 Kimi 先于 upstream durable row 放行而 fail-closed，没有计作通过，审批排序限制转入 tech-debt #58。提交前与 pre-commit 两轮 `npm run test` 均为 4677/4677，typecheck、touched ESLint（0 error）、hooks、docs drift、diff check 全绿；据此 Phase 4/6 的 managed 核心状态更新为 `Smoke passed`，native inherited worker identity 仍保持 Phase 7 fail-closed 待续。
- 2026-07-27（v0.60.0 正式发布）：多模型 Sub-agent 编排随 `v0.60.0` 正式发布（feature commits `84e12513` + `483cac1a`，release commit `d6c4090e`）；GitHub Actions run `30272492570` 双平台构建与 release 全绿。发布口径：三 Runtime managed 依赖链 `Smoke passed`；Release Notes 已知限制注明 codex_account 原生 worker 无身份上报时不显示胶囊（tech-debt #59）。Phase 7 剩余项（identity-bearing native collab smoke）依赖上游 app-server 身份载荷，不阻塞本次发布。
- 2026-07-27（Signal/Triage/Fix/Verify）：v0.60.0 用户在另一台已更新电脑上可以把 `xai-oauth/grok-4.5` 用作主模型，managed Sub-agent 却报告 route 不存在。代码核验确认主 picker 单独读取 OAuth status 并手工追加虚拟 Provider，而 `listSubagentRoutes()` 只遍历 env + DB providers，导致非 DB 的 xAI/OpenAI OAuth 在委派前即被漏掉。新增共享 managed virtual catalog，并让 picker、resolver、CodePilot/Codex Sub-agent route 同源消费；未认证/disabled fail closed，Claude Code 继续因 xAI 协议不兼容而排除。新增正反例并把 Codex proxy registry source contract 扩展到共享 catalog；组合定向 93/93、完整 unit 4703/4703、production build 通过，真实 packaged child 调用仍按 Ledger 待跑。
- 2026-07-27（Review/Fix/Verify）：Claude 变异验证指出 Claude negative 原本因候选集漏掉 virtual Provider 而恒绿，且 Codex proxy 仍硬编码第二份 compat。Claude route 现同样枚举已认证 virtual catalog，再由 `getModelCompat` 排除 xAI/OpenAI；测试直接锁定两条 route 的 compat/protocol。Proxy registry 从认证无关的共享定义生成，并对 id + compat + protocol 做结构化 parity 断言。复跑定向 93/93、完整 unit 4703/4703、production build 通过；两条 P2 已闭环，packaged smoke 状态不变。
- 2026-07-27（Packaged real smoke）：从当前提交构建 macOS arm64 `CodePilot.app`，版本 0.60.0、深度签名校验通过；先用 `.app/Contents/Resources/standalone/server.js` 与 packaged Electron ABI 完成真实 Provider 调用，再让同一 `.app` 的真实 Electron renderer 打开会话核 UI。CodePilot session `d14f966d847de5a16c7f7714d824ac96` 与 Codex Account session `2818c311bea4e0cd5f54c5a2760a95fe` 均只产生 1 个 managed Grok child，requested/effective route 与 Runtime 均由 `subagent_runs` terminal 行证明；两条 child 都返回真实 X 链接。CodePilot SSE 明确观察到 5 次 `x_search`；Codex hosted-tool 硬证据由同 packaged proxy direct session `7ef47943f864e9c58728a2b863cd8ffb` 补齐（8 次命名 `x_search` tool-use、external X sources）。Electron renderer 中两条 child 各 1 个 completed Grok 胶囊，详情能打开并显示真实路由。Smoke 同时暴露 hosted-tool 增量 lifecycle/source fan-out：CodePilot child 最近 200 条 lifecycle 几乎全被匿名 `tool_completed` 占满，Codex direct SSE 出现 272 个渐进 `tool_result`，managed Codex child 详情只保留匿名 item；能力结论通过，展示/存储去重进入 tech-debt #58，不冒充体验已完全收口。
