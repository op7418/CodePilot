# P0：先完成“默认助理 → 心跳 → 系统通知”纵向闭环

> 创建时间：2026-08-03
> 最后更新：2026-08-29
> 状态：🟡 P0.5 复审 accepted，已随 `v0.67.11` Shipped；三平台 package 门禁通过，packaged native show/sound/click smoke 仍待验收
> 优先级：P0
> 父方向：[Harness Home Umbrella](harness-home-user-owned-core.md)
> 历史参考：[助理工作区](../completed/assistant-workspace.md)、[后台任务与通知归档](../completed/refactor-phase-3-background-tasks-notifications.md)、[Memory v3（deferred）](../deferred/memory-system-v3.md)

> Runtime binding 职责补充（2026-09-01）：[Runtime 会话所有权计划](runtime-thread-ownership-and-handoff.md) 负责“auto-trigger 只能消费已绑定 owner”的通用服务端门禁；本计划负责默认助理 / heartbeat / task session 的创建时机、明确 route 来源、创建 transaction 内原子绑定和 durable blocked 展示。调度执行时不得再按当时的全局默认 Runtime 临时选 route。

## 状态

| Phase | 内容 | 状态 | 用户结果 |
|-------|------|------|----------|
| P0.0 | 事实复核、合同与 POC 门禁 | 🟡 合同与 Claude rules POC 完成；平台 packaged notification POC 待执行 | 先锁死默认目录、心跳真源、通知投递语义，不带着假设开工 |
| P0.1 | 默认助理与零会话入口 | ✅ Code + automated tests + Review passed | 新用户不用先选目录，打开 CodePilot 就能开始助理对话 |
| P0.2 | 心跳 desired-state / scheduler / run 纵向自愈 | ✅ Code + automated tests + Review passed | 开启后重启仍会按时检查；可看上次、下次和失败原因 |
| P0.3 | Electron Main 独占的持久化系统通知 | 🟡 Code + automated tests + Review passed；packaged native smoke 待执行 | 软件在后台也能收到系统通知与系统提示音；点击回到对应助理会话 |
| P0.4 | 三平台纵向 smoke、文档与 guardrail | 🟡 文档/自动化/build 完成；三平台真实 smoke 待执行 | macOS / Windows / Linux 的能力与限制都有真实证据，不以网页 toast 冒充系统通知 |
| P0.5 | Notification Manager 全系统化 + 交互任务关键提醒 | 🟡 Review accepted + `v0.67.11` Shipped；packaged native smoke 待完成 | 页面右下角不再消费通知事件；任务完成和等待审批会收到可点击回原会话的系统通知 |

### Claude 首轮 review 回写状态

| Finding | 回写结论 | 计划坐标 |
|---------|----------|----------|
| P1-1 bootstrap 与显式 PUT 竞态 | 进程内 single-flight；commit 时 DB 条件写；bootstrap 永远输给并发显式 PUT | D1、Anchor Ledger、P0.1 |
| P1-2 reconcile → desired commit 幽灵运行 | 改为 desired 先落盘、reconcile 后置；失败保持 blocked；runner 调 Provider 前重读 desired | D6、P0.2、H1 |
| P1-3 并发 reconcile 双 row | pre-index duplicate consolidation + `source='assistant_heartbeat'` partial UNIQUE index + 冲突后重读 | D6、Anchor Ledger、P0.2 |
| P2-1 ClaudeCode 原生规则双注入 | P0.0 增加真实 `settingSources` smoke；canonical/legacy 同存只允许一份 CodePilot-owned injection | D3、P0.0、P0.1 |
| P2-2 delivery status CHECK | 冻结现有 status 枚举；claim 只由 additive columns 表达 | D9、P0.0、P0.3 |
| P2-3 `failed` 平台差异 | Windows 使用 `failed ∪ timeout`；macOS/Linux 使用 timeout，加共同 throw/unsupported 路径 | D10、P0.0、N5 |
| P2-4 interval 不重算 next_run | 无 cadence 变化的 restart 保留 next_run；用户修改 cadence 时按新 cron 重算 | D6、P0.2、H8 |
| P2-5 服务端旧 heartbeat 仍可达 | `/api/chat` 不再把 client `autoTrigger + prompt` 识别为 heartbeat；0 call 在 provider policy 边界证明 | D7、P0.0、P0.2 |
| P3-1 macOS sound 可能无声 | signed packaged 同时比较 `silent:false` 与 `sound:'default'` | D11、P0.0 |
| P3-2 Windows dev 不代表通知可用 | Windows lifecycle POC 从 P0.0 起就要求 NSIS packaged + AppUserModelID/shortcut | P0.0、P0.4 |
| P3-3 模板自引用旧文件名 | 新模板正文、Safety 文案同步使用 canonical filename | D3、P0.1 |
| P3-4 overflow 强保留旧 `claude` key | canonical instruction role 在 overflow 下仍为必保留，不能因内部 key 重命名被丢弃 | D3、P0.1 |

## 1. 用户问题与目标

### 1.1 用户反馈

1. 助理本应开箱即用，但当前强制用户先选择目录；这把“拥有自己的助理”变成了设置任务。
2. 文件约束与心跳几乎无法正常触发，用户无法判断是没到时间、没有模型、调度丢失，还是运行失败。
3. 通知主要显示在 CodePilot 页面内部。应用常驻后台时，页面 toast 对用户没有提醒价值；真正需要的是客户端系统通知、系统提示音和点击后的正确跳转。

### 1.2 本计划要交付的完整路径

```text
首次启动 CodePilot
  → 自动建立用户可见、用户拥有的默认助理目录
  → 侧栏立即出现“助理”，无需先制造一条假会话
  → 用户点击开始真实助理对话
  → 用户显式开启心跳并看到下次检查时间
  → 重启 / 窗口隐藏后调度仍存在
  → HEARTBEAT.md 在到期时由同一生产运行链读取
  → HEARTBEAT_OK：只记“检查完成，无需提醒”，不弹通知
  → 有事要说：写入真实助理会话 + 创建 durable notification event
  → Electron Main 领取并展示系统通知，使用系统提示音
  → 点击通知：拉起 CodePilot 并打开对应助理会话
```

### 1.3 对用户的直接好处

- 首次使用少一个强制设置步骤；助理是产品能力，不再像“先配置一个开发目录”。
- 老用户已有目录、私有仓库和文件全部保持原样，不迁移、不覆盖、不偷偷复制。
- 心跳从“开了但不知道有没有用”变成可诊断状态：开关、下次检查、上次运行、结果、阻塞原因彼此分开。
- CodePilot 在后台时提醒仍有效；页面 toast 不再被当成系统通知成功的证据。
- `HEARTBEAT.md` 仍是用户可编辑的检查内容，但 cadence、last run、next run、投递状态不会混进 Markdown 文件。

## 2. 为什么这次必须做纵向闭环

默认助理、心跳和系统通知单独完成任何一个，都不能解决用户问题：

- 只有默认目录：用户看得到助理，但它仍不会主动工作。
- 只有 scheduler：心跳可能运行，但用户不知道是否运行、也收不到后台提醒。
- 只有系统通知：没有可靠事件源，通知只是一个孤立 demo。

因此本计划以一条真实事件贯穿文件、调度、模型运行、DB 投递、Electron 系统 API 和点击路由。每一层都必须保留 source breadcrumb；不能用静态测试、页面 toast 或日志字符串代替下一层真实行为。

## 3. 当前事实底座（2026-08-03）

| 范围 | 当前 file + symbol | 已确认事实 | 用户影响 |
|------|--------------------|------------|----------|
| 未配置助理 | `src/app/api/settings/workspace/route.ts:GET / PUT` | 无 `assistant_workspace_path` 时返回 `no_path_configured`；PUT 要求用户给路径 | 新用户必须先去设置选目录 |
| 助理初始化 | `src/lib/assistant-workspace.ts:initializeWorkspace` | 已能幂等创建身份、记忆、`HEARTBEAT.md` 与 `.assistant/state.json`；默认 heartbeat 为 off | 能复用初始化器，但模板仍含 `claude.md` 命名债务 |
| 侧栏零会话状态 | `src/components/layout/ChatListPanel.tsx:assistantGroup` | 只有 workspace 下已经存在 session 才渲染助理分组；配置成功但零 session 时既无 promo，也无助理入口 | 自动建目录后仍可能“看不见助理” |
| Onboarding 门槛 | `src/components/settings/AssistantWorkspaceSection.tsx` | 心跳卡受 `onboardingComplete` 条件限制 | 默认助理仍可能先要求走完整 onboarding 才能开启心跳 |
| 心跳配置写入 | `src/app/api/settings/workspace/route.ts:PATCH` | 先写 `.assistant/state.json`，再 best-effort 调 `ensureHeartbeatTask`；同步失败仍返回 success | UI 可显示已开启，但 DB 没有可执行任务 |
| 启动恢复 | `src/instrumentation.ts:register` | 启动只调用 `ensureSchedulerRunning()`，没有从助理 desired state 重建/修正系统 heartbeat row | 更新、DB 恢复或漂移后不会自愈，直到用户再次改开关 |
| 心跳调度 | `src/lib/task-scheduler.ts:ensureHeartbeatTask / executeDueTask` | heartbeat 是 `source='assistant_heartbeat'` 的系统 `ai_task`；已有重复触发、stale、backoff 基础 | 可以复用，不另造第二个 scheduler |
| 心跳执行 | `src/lib/agent-task-runner.ts:runScheduledAgentTask` | 到期时读取 `HEARTBEAT.md`，经真实 Runtime/Provider 链运行；exact `HEARTBEAT_OK` 才静默 | 主链已存在，但 Provider/Model 阻塞状态和 UI breadcrumb 不完整 |
| 旧语义残留 | `src/lib/heartbeat.ts:stripHeartbeatToken`、`src/lib/chat-collect-stream-response.ts` | 仍保留旧前台 auto-trigger / 宽松 token stripping 语义；与后台 runner 的 exact silent contract 并存 | 两套“什么算静默”的答案可能继续漂移 |
| 通知事实源 | `src/lib/notification-manager.ts` | DB 有 `notification_events` / `notification_deliveries`，但展示 payload 仍只进进程内 50 条 ring buffer | server 重启或队列被另一消费者 drain 后，durable row 也无法自动补投 |
| 通知 consumer | `src/lib/notification-manager.ts`、`electron/main.ts:startNativeDeliveryService` | 所有 priority 新事件只写 `electron-native`；AppShell 无 Renderer delivery poll，Main 持续 claim/ack | 页面 toast 不再冒充系统通知；visible/hidden 不切 owner |
| 假 delivered | `electron/main.ts:notification:show / startBgNotifyPoll` | `Notification.show()` 调用后立即 ack `delivered`；未等待 `show`，没有完整 `failed` / timeout 终态 | DB 的“已送达”并不证明 OS 接受了通知 |
| 声音 | `electron/main.ts:new Notification` | 未定义 `silent` / `sound` 合同 | 各平台行为随机，产品不能承诺“对应提示音” |
| 点击路由 | `electron/main.ts:notification click` | 直接向当前 renderer 发送 payload；renderer 未 ready 或正在 reload 时可能丢失 | 用户点了通知，窗口打开但不一定到对应会话 |
| 测试证据 | `heartbeat-notify.test.ts`、`bg-notify-poll.test.ts` | 主要覆盖正则、内存队列和 parser；文件注释仍把 Electron 行为留给手测 | 现有单测无法证明纵向闭环真的成立 |

### 3.1 历史文档的适用边界

- `completed/` 记录当时实现过什么，不等于用户当前路径仍工作。
- `deferred/memory-system-v3.md` 中“打开会话时触发 heartbeat”的描述已不是本计划的目标架构。
- `future/scheduled-tasks-and-notifications.md` 继续保存更广的 cron / Bridge / 浮窗构想；其中 P0 心跳和系统通知部分由本计划接管。
- 参考 OpenClaw 只采纳“用户内容与系统调度状态分离”的原则，不照搬其文件名或运行机制。当前参考：[OpenClaw heartbeat](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md)。

## 4. 已拍板的产品与技术取舍

### D1. 新用户有默认助理；老用户路径优先且绝不自动迁移

- 只有 `assistant_workspace_path` 缺失、空字符串或全空白时，才允许 default bootstrap。
- 任意非空旧值都视为用户选择：即使目录当前离线、不可写或无效，也不能用默认目录替换；设置页显示修复入口。
- default bootstrap 由进程内 single-flight 收敛；多个 renderer / HMR 请求只共享同一次初始化 promise，不得并行执行多个 check-then-create。
- “入口检查为空”不构成提交权。bootstrap 在文件初始化完成后，必须通过 `src/lib/db.ts` 的条件写于 commit 时再次判断 setting 仍为空；条件不成立即返回 `lost_to_explicit_selection`，绝不调用无条件 `setSetting` 覆盖用户刚完成的显式 PUT。
- 显式 PUT 始终胜出：若它先 commit，bootstrap CAS 必须 no-op；若它后 commit，显式 PUT 可覆盖刚建立的默认选择。bootstrap 因竞态已经创建但最终未被选择的空默认目录不自动删除，避免跨文件系统回滚误删用户同期写入；它不得包含 session、memory 或模型生成内容。
- 默认目录由 Electron `app.getPath('documents')` 解析，建议为 `<Documents>/CodePilot/Assistant`。不在 Next server 中硬编码 `~/Documents`，避免 Windows、Linux、重定向 Documents 和本地化目录错误。
- 默认目录不初始化 Git、不上传、不写 Secret，也不把用户内容复制到应用私有目录。
- 用户以后仍可在“设置 → 助理”更换目录。

### D2. 默认创建不制造身份事实，也不产生模型费用

- 创建空白/最小模板，不根据用户名、历史聊天或模型输出猜用户偏好。
- 不自动运行 onboarding，不自动创建 chat session，不自动开启 heartbeat，不自动调用模型。
- 侧栏渲染“零会话助理”空状态；只有用户点击“新对话”才创建第一条真实 session。
- 若用户后来显式开启 heartbeat，第一次有意义 speak-up 可以创建真实助理会话以承载消息；这不是安装时的假会话。

### D3. 新默认工作区不继续扩大 framework lock-in

- 新 workspace 的 canonical rules 文件采用中立名称，推荐 `instructions.md`。
- 新 workspace 同时生成带 provenance hash 的 `CLAUDE.md` / `AGENTS.md` native mirrors；它们只在内容仍等于上次生成版本时随 canonical 同步。手改/unmanaged 时整组 freeze 并由 Settings 披露冲突，绝不覆盖。
- loader 优先读取 canonical `instructions.md`，继续兼容没有 canonical 的 `claude.md` / `CLAUDE.md` / `AGENTS.md` 老目录；不重命名、不自动迁移老用户文件。
- `FILE_MAP` 只解析一个 winning rules file：同时存在 `instructions.md` 与 legacy 文件时 canonical 优先，Context Assembler 恰好注入一份；不得拼接两份。
- P0.0 必须用真实 ClaudeCode 助理会话确认 SDK `settingSources` 是否会从 cwd 原生加载 `CLAUDE.md`。若会，实施必须给 ClaudeCode 路径做 effective-prompt 去重或明确只保留一个 owner；不能把“Assembler 单读”冒充“模型只看见一份”。真实结论回写 D3 后才可进入 P0.1。
- 2026-08-03 真实 POC 结论：Claude CLI `2.1.220` 在临时 cwd、`--setting-sources project`、无工具、Haiku 下准确返回 cwd `CLAUDE.md` 的唯一 marker，证明 SDK 会原生装载 project rules。最终 owner 因此锁为：仅 env Claude + clean `CLAUDE.md` mirror 由 SDK 原生加载并允许 Assembler 省略 rules；其他路径由 Assembler 注入 canonical。Codex 的非 git cwd / `project_doc_max_bytes=0` native discovery 尚无真实证据，所以即使 clean `AGENTS.md` 存在，也保留 rules 并经 `developerInstructions` 投递。成功运行成本 `$0.0022951`；此前两次预算不足 POC 分别消耗 `$0.036809`、`$0.01413`，均未伪装成成功证据。
- 新 `instructions.md` 模板正文中的修改提示、安全规则和自引用必须同步使用 canonical filename；不能继续教模型修改不存在的 `claude.md`。
- token overflow 时“规则必保留”绑定 canonical instruction role，不绑定旧内部 key `claude`；内部类型渐进重命名不能让规则在 overflow 时被丢弃。
- 对旧 `AssistantWorkspaceFiles.claude` 等内部命名采用兼容别名/渐进迁移，不能在本 P0 里批量重写用户内容。
- 本计划不把 Assistant Workspace 与 `harness_home_root` 自动合并；两者未来如何成为同一 canonical root，由 Harness Home Program A 的迁移合同决定。

### D4. Onboarding 是渐进增强，不是使用助理和开启心跳的门禁

- 新用户可以直接创建助理对话。
- 未 onboarding 时显示默认名称/空人格；完成后再获得 buddy、个性和用户资料。
- 心跳设置可以在 onboarding 前看到并显式开启；界面同时说明会调用当前助理所用模型、可能产生费用。

### D5. HEARTBEAT.md 只保存“检查什么”，不保存“什么时候跑、上次跑到哪”

| 信息 | 事实源 |
|------|--------|
| 检查清单与约束 | 用户目录下 `HEARTBEAT.md` |
| 用户是否开启、间隔、active hours | `.assistant/state.json` desired state（本轮保持兼容） |
| 系统 heartbeat task、`next_run`、backoff | SQLite `scheduled_tasks` derived runtime state |
| 每次 attempt、结果、错误、耗时 | SQLite `task_run_logs` |
| 提醒事件与各渠道投递 | SQLite `notification_events` / `notification_deliveries` |

禁止把 `lastHeartbeatDate` 当成“系统健康”的唯一证据，也禁止 scheduler 把 `next_run`、lease 或 attempt 写回 `HEARTBEAT.md`。

### D6. 启动、设置变更和手动检查都经过同一个 reconcile / run 合同

- 新增单一 `reconcileAssistantHeartbeat()`：读取 desired state，幂等确保 0 或 1 条 system-owned heartbeat row。
- 应用 server 启动、默认助理 bootstrap 成功、workspace 设置变更后都调用同一 reconcile。
- PATCH 顺序锁定为：校验 → 原子写入 desired state → reconcile derived scheduler row → 返回 combined status。desired 写失败时绝不先改 scheduler；reconcile 失败时不回滚用户意图，返回 `blocked`，UI 显示“已开启/关闭，但调度同步被阻塞”及原因。
- runner 在创建/选择 session、调用 Provider、产生 notification 之前重新读取 desired state。若 heartbeat 已 disabled、workspace 已变更或状态不可验证，则以 `skipped_reconcile_drift` 收口 run，0 Provider call、0 notification，并 best-effort 触发 reconcile。这个执行侧 gate 是 disable 清理失败/残留 row 的费用安全最后防线。
- `scheduled_tasks` 对 exact `source='assistant_heartbeat'` 增加 additive partial UNIQUE index。建索引前若历史已有重复 system row，必须在事务中选择一个 keeper，将相关 `task_run_logs.task_id` 与 `notification_events.task_id` 重关联到 keeper、保留各 run 的 `notification_event_id` 后再收口重复 row；不删除 run/event 历史，不触碰任何 user-source task。
- reconcile 本身使用 SQLite transaction / unique-conflict reread，不能只靠进程 single-flight。startup、bootstrap、PATCH 并发时，唯一索引 loser 必须读取并更新 winner，而不是返回 500 或留下两条。
- cadence 未变化的 startup/redeploy 不改合法 future `next_run`；用户实际修改 `schedule_value` 时，同一 task id 按新 cron 从当前时间重算 `next_run`。24h→1h 不能继续等待旧 24h 排程。
- PATCH 不再 fail-open。desired state 与 scheduler row 无法一致时，API 返回明确 blocked，不把 UI 开关或健康状态乐观翻成 success。
- “立即检查”调用与定时到期相同的 `runScheduledTaskNow` / runner 路径，不能另写 mock heartbeat。
- 运行前重新读取 `HEARTBEAT.md`。文件为空/只有空 checklist 时直接记 `skipped_empty`，不调用模型、不产生费用。

### D7. 心跳只有一个 silent contract

- 只有 trim 后 exact `HEARTBEAT_OK` 算 silent。
- `HEARTBEAT_OK` 后还带正文时必须 speak up，不能用“剥离后小于 300 字”隐藏真实内容。
- 后台 scheduler 是 heartbeat 唯一自动触发器。`/api/chat` 不得再根据客户端可控的 `autoTrigger:true` + prompt substring 构造 `isHeartbeatTurn`；`context-assembler.ts` 也不得从该形状进入 heartbeat instructions。若 buddy welcome 仍需 autoTrigger，必须使用独立、可验证的 kind，不能恢复 heartbeat 入口。
- 普通用户对话若保留 soft check-in，只能是独立的 conversational hint；它不得写 heartbeat scheduler/run 的健康状态，也不得复用 `stripHeartbeatToken`。
- 删除或隔离 `chat-collect-stream-response.ts` 的旧 heartbeat stripping / state-update path；服务端 reachability test 必须证明 public chat request 无法触发 heartbeat silent contract。
- empty/missing `HEARTBEAT.md` 的 0 model call 由 `provider-call-policy.ts:assertProviderCallAllowed` 前的统一观察/spy 边界证明：测试中任何 `assistant_heartbeat` Provider call 到达该边界即 fail。不得只在各 runner test mock 某一个 transport。
- silent run 不写 assistant message、不创建 notification event，但必须留下可见的 run 状态“检查完成，无需提醒”。
- speak-up 必须同时关联同一 `run_id`、`session_id` 和 `notification_event_id`。

### D8. Electron Main 是 `electron-native` 的唯一消费者

- 所有 Notification Manager 事件无论 low / normal / urgent 都只创建 `electron-native` delivery；Renderer 不再挂载 delivery consumer。普通按钮反馈、表单错误等仍可用页面 toast，但它们不是 notification event。
- Electron Main 无论窗口 visible / hidden 都负责领取 `electron-native`，不按可见性切换 owner。
- `renderer-toast` 只作为旧库审计/迁移 literal 保留；claim/ack HTTP 面明确拒绝。仍 queued 且可执行的旧行启动时迁到 native，已有 native peer 时冗余 renderer row 收口 skipped，不删除历史。
- 对 heartbeat 不再创建“页面 toast 已显示 = 已提醒”的假成功；系统通知失败时，chat message 和 run log 仍在，但 UI 必须显示 native delivery error。
- 交互聊天的 `permission_request` 和真实成功完成由服务端 collector 单点创建 durable event。完成必须有 successful result、已持久化 terminal assistant row、当前 session lock owner；失败/停止/autoTrigger/stale owner 不得误报。

### D9. Durable delivery row 是投递源，内存 ring buffer 不能承担可靠性

- `notification_events` / `notification_deliveries` 先落库，再由 consumer claim。
- native claim 的网络边界锁为：`POST + application/json`、loopback `Host`、无跨源 `Origin`、固定 `X-CodePilot-Consumer: electron-main`。legacy renderer claim 校验仅保留给旧数据/测试 mutation compatibility，产品 AppShell 不再挂 consumer；两者都拒绝 DNS-rebinding host、`text/plain` 和未知 channel。该边界防网页 CSRF / drain，不声称能抵御已经在用户机器上执行的任意本地进程。
- 为 `notification_deliveries` additive 增加 bounded claim/retry 字段（建议：`claim_owner`、`claimed_at`、`attempt_count`、`last_attempt_at`；最终字段名由 P0.0 对账）。
- `notification_deliveries.status` 现有 `CHECK` 枚举冻结为 `queued | delivered | error | not_configured | skipped`。P0 不新增 `claimed`/`retrying` status，也不重建表；claim、lease 和 attempt 只能由 additive columns 表达。
- claim 在 SQLite transaction 内完成；同一 `(event_id, channel)` 同时只能被一个 consumer 持有。
- 进程崩溃后 stale claim 可回收；terminal delivery 不回到 queued；重试有上限和 backoff。
- 旧库只加列/索引，不删除现有 event/delivery；迁移必须遵守 `DatabaseSchema.md`。

### D10. “已投递”只表示 OS 接受，不表示用户看见

- Electron `Notification` 必须监听平台真实支持的 lifecycle，并有 bounded show timeout。
- 所有平台共同路径：`Notification.isSupported() === false`、constructor / `show()` throw、bounded timeout → `error`；收到 `show` 才 ack `delivered`。
- Windows 额外监听 `failed`，终态错误集合为 `failed ∪ timeout ∪ throw ∪ unsupported`。
- macOS / Linux 不等待不存在的 `failed` 事件，终态错误集合为 `timeout ∪ throw ∪ unsupported`；测试必须明确断言它们走 timeout，而不是伪造 failed。
- `close` / `click` 是交互事实，不反向把未收到 `show` 的行补成 delivered。
- UI 文案使用“系统已接受通知”或“系统通知失败”，不承诺用户实际看到；勿扰模式和 OS 权限不由 CodePilot 伪造判断。
- 参考权威 API：[Electron Notification](https://www.electronjs.org/docs/latest/api/notification)、[Electron notifications tutorial](https://www.electronjs.org/docs/latest/tutorial/notifications)。

### D11. 提示音尊重平台能力，不做虚假的跨平台同音色承诺

- notification options builder 只设置当前平台支持的字段，不能把 `silent:false` 在 Windows/Linux 上存在于对象里就当成提示音证据。
- macOS signed packaged POC 必须同时比较“仅 `silent:false`”与“`sound:'default'`（或当前 Electron 证明支持的系统 sound）”；以真实有声结果选定配置。未经 POC 不写死“系统提示音已播放”。
- Windows / Linux 使用操作系统通知策略与默认提示音；系统关闭通知声音或勿扰时，CodePilot 不能绕过。
- Windows POC 必须使用 NSIS installed package，验证 AppUserModelID、开始菜单快捷方式、显示、声音与点击；dev Electron 结果不能进入完成证据。
- 用户文案为“系统通知与系统提示音（受系统权限、勿扰和平台设置影响）”。
- P0 不实现自行播放 mp3/wav 的第二套音频通道，避免通知失败却仍发声、或系统静音时绕过用户选择。

### D12. 点击意图由 Main 暂存，直到 Renderer 明确 ready

- native payload 至少含 `event_id`、`session_id`、`task_id` 和 action kind。
- 点击先 show/focus main window；若 renderer 未 ready / 正在 reload，将 action 放入 Main 的 bounded pending queue。
- renderer ready 后按 event id 幂等消费；有 session 时打开对应助理会话，无 session 时打开该 task/run 详情并说明原因。
- P0 验收范围是应用仍在运行或托盘常驻时的点击。应用完全退出时 scheduler 不会产生新 heartbeat；跨退出的通知中心 cold activation 另立后续，不拿本轮 smoke 冒充。

## 5. 范围与明确不做

### 5.1 本轮范围

- 新用户 default assistant bootstrap 与老用户 no-touch 兼容。
- 新 workspace 的中立 instructions filename + legacy read compatibility。
- 侧栏零会话助理与渐进 onboarding。
- heartbeat desired state → system task → run → silent/speak-up 的自愈和可观测性。
- native notification durable claim、系统提示音合同、点击路由。
- macOS / Windows / Linux 真实 packaged smoke。

### 5.2 明确不做

- 不迁移或复制 `guizang-Memory` 等老用户目录；不读取 Git remote/token；不把私有仓库变成产品依赖。
- 不在安装时自动开启 heartbeat 或调用模型。
- 不在本轮完成完整 Memory vNext、向量检索、自动 memory consolidation 或 Taste Memory 合并。
- 不自动把 Assistant Workspace 设为 `harness_home_root`。
- 不扩展任意 cron UI、自然语言建任务、Bridge、浮窗、TTS、手机推送。
- 不让 heartbeat 使用 shell、web、任意外部 MCP 或 side-effect tool；其可用数据仍受既有严格 tool gate 限制。
- 不保证应用完全退出后仍有本地 heartbeat；那需要 OS background service / launch agent，是另一项产品和权限决策。
- 不用 custom audio 绕过系统勿扰。

## 6. Enforcement Anchor Ledger（P0.0 必须先回填）

> 实施前，Claude Code 必须把下表“目标 symbol”校准到最终代码坐标，并为每条写明自动测试或 packaged smoke。没有 enforcing coordinate 的合同不得进入 P0.1。

| 合同 | 当前 anchor | 目标 enforcing file + symbol | 检验方式 |
|------|-------------|------------------------------|----------|
| 仅缺失设置时建默认助理 | `settings/workspace route GET/PUT`、`db.ts:setSetting` | `src/lib/db.ts:compareAndSetSettingIfBlank` + `assistant default bootstrap single-flight` | 新用户、非空/invalid 旧路径、bootstrap 与显式 PUT 竞态；显式 PUT 必须胜出 |
| 默认路径由 Electron 解析 | 无 | `electron/main.ts` fixed-path IPC + `preload.ts` narrow bridge | source-pin + mac/win/linux path fixture；IPC 不接收任意 path 参数 |
| 新规则真源中立且投递不丢失 | `assistant-workspace.ts` mirror reconcile、`context-assembler.ts` owner gate、`codex/runtime.ts` developer instructions | canonical `instructions.md` + managed native mirrors + evidence-backed injection | clean sync、manual conflict freeze、legacy no-touch；env Claude clean owner 恰好一份；Codex canonical final wire 始终存在，native 是否重复不作未经验证的承诺 |
| 零会话助理可见 | `ChatListPanel.tsx:assistantGroup` | synthetic empty group / explicit empty state | component/UI smoke：0 session 仍有助理和新对话按钮 |
| heartbeat desired/actual 一致 | `workspace PATCH` + `assistant-workspace.ts:saveState` + `ensureHeartbeatTask` | atomic desired-state writer + `reconcileAssistantHeartbeat` + desired-first PATCH contract | enable/disable/file-write failure/reconcile failure/interval/restart/drift/DB restore tests |
| heartbeat 单 row | `ensureHeartbeatTask` check-then-create、`getHeartbeatTask LIMIT 1` | `db.ts` duplicate consolidation + partial UNIQUE index；reconcile unique-conflict reread | 并发 startup/bootstrap/PATCH；历史 duplicate + run/event linkage preserved |
| disabled 费用安全 | runner 当前不复核 desired | `agent-task-runner.ts` pre-session/pre-provider desired-state gate | stale active row + desired off → `skipped_reconcile_drift`，provider-policy spy 0 hit |
| exact silent / server 单入口 | 两套现存 helper、public `/api/chat` autoTrigger heartbeat shape | shared outcome classifier + chat route/context assembler heartbeat gate removal | silent/speak-up fixtures；public chat heartbeat shape unreachable；empty file provider-policy spy 0 hit |
| native 单 owner | renderer + main 双消费者 | Electron Main native delivery service | source-boundary test + visible/hidden transition smoke |
| durable claim | in-memory drain、delivery status CHECK | DB column-only claim/reclaim CRUD + channel claim route；status 枚举冻结 | concurrent claimant、crash lease、retry cap、old DB migration、无新 status 值 |
| truthful delivery | ack after `show()` | Electron notification lifecycle adapter | common show/throw/timeout/unsupported；Windows failed；macOS/Linux no-failed timeout |
| sound contract | 无 | platform notification options builder | mac signed `silent:false` vs `sound:'default'`；Windows installed NSIS；Linux packaged evidence |
| click durability | direct IPC send | pending action queue + renderer-ready ack | click before/after ready、reload、duplicate click |
| route mutation trust | public destructive GET drain | channel-scoped POST claim + trusted local mutation guard | Origin/Host/content-type/channel enum/DNS-rebinding fixtures |

## 7. 详细实施阶段

## P0.0 — 合同、POC 与迁移门禁

### 用户会看到什么

本阶段不改变产品 UI。它的用户价值是阻止三类错误进入实现：覆盖老目录、把 toast 叫系统通知、以及在未经 signed packaged 验证时承诺提示音。

### 验收入口

- 本计划的 Enforcement Anchor Ledger 已回填最终 symbol。
- Claude review 对默认路径、DB migration、系统通知三项给出明确结论。
- POC 日志进入下方 Smoke Ledger；没有真实结果的行保持空，不写示例成功。

### 本阶段明确不做

- 不提交产品行为代码。
- 不创建真实用户默认目录。
- 除 D3 中有界、无工具的 Claude rules POC 外，不发真实模型请求。

### 执行清单

- [x] 读取并更新 `AssistantWorkspace`（新增）、`ElectronMain`、`DatabaseSchema`、`HarnessHome` guardrail 的 enforcement。
- [ ] 对账 `app.getPath('documents')` 在 macOS / Windows / Linux 的目标路径和不可写失败 UI。
- [ ] 锁定 fixed-path IPC + bootstrap single-flight + commit-time CAS 的最终顺序；electron:dev 与 packaged 都可用，并证明 bootstrap 必须输给并发显式 PUT。
- [x] 用真实 ClaudeCode 助理会话记录 cwd `CLAUDE.md` 是否经 SDK `settingSources` 原生装载；据此把 effective single-injection policy 回写 D3。
- [x] 复核 current DB schema revision、heartbeat partial UNIQUE index 前的 duplicate consolidation、delivery column-only claim transaction、status CHECK 冻结和 stale lease 上限。
- [ ] 以 Electron 当前锁定版本做分平台 Notification lifecycle POC：common `show` / throw / timeout / click；Windows installed NSIS 额外 `failed` + AppUserModelID/shortcut；macOS/Linux 不等待 failed。
- [ ] 在 signed macOS packaged app 比较 `silent:false` 与 `sound:'default'` 两种配置；Windows 从 P0.0 起用 installed NSIS，Linux 记录 P0.4 的 desktop environment / daemon gate。
- [x] 盘点并封堵所有旧 foreground heartbeat 服务端可达点，包括 `/api/chat` 的 client `autoTrigger` shape、Context Assembler 和 collector stripping；buddy welcome 若保留必须与 heartbeat 分 kind。
- [x] 选定 `assertProviderCallAllowed` 前的 test observer/spy，使 empty/disabled heartbeat 的 0 Provider call 在统一边界 fail closed。
- [ ] 将本节所有 POC 结果回填 Smoke Ledger；失败是事实，不得改成“代码看起来支持”。

### Phase gate

- [x] 老用户 no-touch 与新用户 default bootstrap 语义无歧义。
- [x] DB CAS fixture 证明任何 interleaving 下显式 PUT 最终胜出。
- [x] ClaudeCode `settingSources` 真实结果已写回 D3，canonical/legacy effective injection owner 已拍板。
- [ ] native notification 的 success/error 定义与 Electron 实际事件一致。
- [x] heartbeat uniqueness 与 delivery additive migration、claim/reclaim、status freeze 和 retry 上限已确定。
- [x] P0.1–P0.4 每个合同都有 enforcing file+symbol 和测试方式。

## P0.1 — 默认助理与零会话入口

### 用户会看到什么

- 首次启动后，侧栏直接出现“助理”分组和“新对话”按钮。
- 设置页显示默认目录、打开目录和更换目录入口。
- 不完成 onboarding 也能聊天；个性化设置仍可稍后完成。
- 已配置目录的老用户看到的路径和文件完全不变。

### 验收入口

1. 使用隔离的空设置/空 Documents fixture 启动 Electron。
2. 侧栏确认零 session 的助理分组存在。
3. 设置 → 助理确认默认路径与最小模板。
4. 点击新对话后才出现第一条 session。
5. 使用非空旧路径重启，确认 default path 未被创建/选中，旧文件 hash 不变。

### 本阶段明确不做

- 不开启 heartbeat。
- 不运行模型生成身份/记忆。
- 不迁移老目录到默认目录或 Harness Home root。

### 执行清单

- [x] Electron Main 暴露无输入的 `getDefaultAssistantHome` 窄 IPC；preload 只返回固定解析结果。
- [x] workspace API 增加 `if_unconfigured` bootstrap single-flight；commit 使用 `compareAndSetSettingIfBlank`，初始化失败不写 setting，CAS loser 返回现有显式选择。
- [x] default initialization 复用/收敛 `initializeWorkspace`，保证重复执行不覆盖用户修改过的文件。
- [x] 新 workspace 生成 `instructions.md` 及 managed `CLAUDE.md` / `AGENTS.md`；模板正文只把 canonical 当真源；legacy workspace 继续读取现有 rule files。
- [x] canonical + legacy 同存时 resolver 只选 canonical；按 P0.0 的 ClaudeCode `settingSources` 结论实施 effective injection 去重。
- [x] overflow 必保留 canonical instruction role；不再通过旧 `claude` 内部 key 特判。
- [x] `ChatListPanel` 在 configured + 0 session 时渲染真实 empty state，而不是构造假 DB session。
- [x] onboarding 变成非阻塞入口；heartbeat 卡可见但默认 off，并有费用说明。
- [x] default bootstrap 失败时设置页显示可重试错误和“选择其他目录”，侧栏不展示假 configured 成功。
- [x] 中英文 i18n 一次补齐。

### 自动化

- default path fixed IPC source/security test；
- workspace initializer no-overwrite、legacy compatibility、single-flight、bootstrap-vs-explicit-PUT 全 interleaving test；
- managed mirrors clean update、manual conflict freeze 且 Settings 可见；env Claude clean owner 去重；Codex synced/conflict 时 canonical rules 仍进入 developer instructions，允许未证明的 native 重复但禁止丢失；canonical template 无旧文件名自引用；overflow 仍保留 rules；
- sidebar 0-session render + click creates exactly one session；
- invalid old path remains selected；
- new template neutrality guard：新目录不生成 `claude.md`，旧目录读取不回写。

### Phase gate

- [ ] Fresh profile 不进设置即可发起助理聊天。
- [ ] Old configured path/content hash 0 变化。
- [x] Bootstrap 与显式 PUT 并发时，最终 setting 100% 为用户显式路径（自动化）。
- [x] 创建默认助理 0 model call、0 notification、0 fake session（自动化）。

## P0.2 — 心跳自愈、可诊断与真实“立即检查”

### 用户会看到什么

- 设置 → 助理显示：未开启 / 已排程 / 正在检查 / 无需提醒 / 已提醒 / 被阻塞。
- 可看到下次检查、上次 attempt、耗时和具体失败原因。
- “立即检查”走真实 heartbeat；结果为 silent 时明确显示“检查完成，无需提醒”。
- 重启后仍保持一条正确的 heartbeat schedule。

### 验收入口

1. 打开设置 → 助理，编辑 `HEARTBEAT.md`。
2. 显式开启 heartbeat，选择 1/6/12/24 小时。
3. 点击“立即检查”。
4. 重启 dev client，再次查看 next run 与最后结果。
5. 删除/篡改 system task fixture 后重启，确认 reconcile 恢复为一条。

### 本阶段明确不做

- 不增加任意 cron 表达式 UI。
- 不让 heartbeat 使用外部 MCP / shell / web。
- 不把空 checklist 送给模型。

### 执行清单

- [x] 新增 `reconcileAssistantHeartbeat()`，返回结构化结果：`disabled | scheduled | repaired | blocked`，包含 task id / next run / reason。
- [x] server startup 在 scheduler DB ready 后执行 reconcile；不能依赖用户再次切开关。
- [x] workspace PATCH 固定为 validate → atomic temp/fsync/rename desired-state write → reconcile；desired 写失败不动 scheduler，reconcile 失败保留用户意图并返回 blocked，不做会再次制造假状态的静默 rollback。
- [x] runner 在 session/provider/notification 之前重读 desired state；disabled/missing/mismatched workspace → `skipped_reconcile_drift`，0 model call、0 notification。
- [x] migration 在 transaction 内把 duplicate heartbeat 的 run/event task references 重关联到 keeper、保留 run→notification event linkage，再收口 duplicate row 并创建 exact-source partial UNIQUE index。
- [x] reconcile 使用 DB transaction / unique-conflict reread；startup、bootstrap、PATCH 并发只能得到一个 keeper row。
- [x] cadence unchanged 保留 future `next_run`；用户修改 interval 则保留 task id、按新 cron 立即重算 `next_run`。
- [x] workspace summary/status API 返回 desired、scheduler、last attempt、next run、last meaningful alert、last delivery 的独立字段与 source breadcrumb。
- [x] 收敛 exact silent classifier；删除 chat route / Context Assembler / collector 中客户端可控的 foreground heartbeat 识别与宽松 stripping。buddy welcome autoTrigger 使用独立 kind；普通 soft check-in 不写 heartbeat health。
- [x] `HEARTBEAT.md` missing/empty/only empty checklist → `skipped_empty`，不创建 session、不调用模型、不通知。
- [x] 运行前若 Provider / Model / Runtime 无效，写 `blocked`/failed run 与 actionable reason；不静默 fallback 到其他 Provider，不每 10 秒重试刷屏。
- [x] “立即检查”复用 system task 和同一 runner；并发 run 返回 `already_running`。
- [x] speak-up 内容写入对应助理 chat，silent 不写 chat message；二者都留下 run evidence。
- [x] Settings 不再用 `lastHeartbeatDate` 单字段表达健康。

### 自动化

- enable → exactly one row；disable 正常路径 → zero row；disable cleanup 失败 + stale row → runner gate 0 Provider call；
- interval change → same id / updated schedule / recomputed next_run；unchanged restart → future next_run byte-for-byte unchanged；
- startup + bootstrap + PATCH 并发 reconcile → exactly one row；unique conflict loser rereads winner；
- enabled state + missing row → startup repairs；disabled state + stray row → startup removes；
- duplicate system row migration/consolidation preserves run/event linkage then partial unique index succeeds；
- empty file / desired disabled 的 0 Provider invocation 由 provider-call-policy boundary spy 证明；
- public `/api/chat` 的 `autoTrigger:true + 心跳检查` 不能进入 heartbeat context/collector；
- exact `HEARTBEAT_OK` silent，token + prose speak-up；
- invalid Provider/Model blocked and no fallback；
- manual and scheduled run share run/event linkage；
- restart/HMR 不重跑正在运行的 heartbeat、不重置合法 future `next_run`。

### Phase gate

- [x] “开关已开但无 system task”不能持久存在（启动/PATCH reconcile 自动化）。
- [x] reconcile blocked 时 UI 同时显示 desired 与 actual，不把“已开启但受阻”显示成关闭，也不把 stale row 显示成仍会运行。
- [x] desired off 时即使清理 DB row 失败也保证 0 Provider call。
- [x] 用户能从 UI 区分“没到时间”“无事可报”“运行失败”“系统通知失败”。
- [ ] 真实 heartbeat silent smoke 完成，模型调用、run row 和 0 notification event 均可复核。

## P0.3 — Main-owned durable 系统通知、提示音与点击

### 用户会看到什么

- CodePilot 窗口隐藏、最小化或托盘常驻时，heartbeat speak-up 仍通过系统通知出现。
- 系统允许声音时，通知使用系统提示音。
- 点击通知打开对应助理会话。
- 设置页新增“测试系统通知”：不调用模型，用于验证权限、提示音和点击。
- 若 OS 拒绝/不支持，显示真实错误和排查提示，不显示“已送达”。

### 验收入口

1. 设置 → 助理 → “测试系统通知”。
2. 分别在窗口 visible、hidden、托盘常驻状态触发。
3. 点击系统通知，确认打开测试目标/助理会话。
4. 再用真实 heartbeat speak-up 复验完整链路。

### 本阶段明确不做

- 不以 Web Notification 或 in-app toast 作为 packaged native 成功证据。
- 不自播放音频文件。
- 不实现 app 完全退出后的后台 daemon。

### 执行清单

- [x] additive migration 扩展 delivery claim/retry 字段、bootstrap schema、on-touch migration、TS type 与 CRUD；现有 delivery status CHECK 枚举完全不变，claim 不引入新 status。
- [x] 用 native-only POST claim/ack 取代 destructive drain GET；mutation 校验 loopback Host、Electron Main consumer、JSON content type，明确拒绝退役 `renderer-toast`。Settings 测试通知使用独立 same-origin Renderer policy。
- [x] Electron Main 启动单一 native delivery service，visible/hidden 不切 owner。
- [x] 所有 priority 只创建 `electron-native`；AppShell 删除 Renderer notification poll，heartbeat/native 失败不得被页面 toast 掩盖。
- [x] queued legacy renderer delivery 事务迁到 native；native peer duplicate 收口 skipped，历史 event/delivery 不删除，migration 可重入且 schema revision 已 bump。
- [x] 服务端 collector 对审批 request id 去重；任务完成以 successful result + persisted terminal + current owner 三重门禁；锁屏文案不含 tool input/路径/模型正文，点击回原会话。
- [x] Notification lifecycle adapter 按平台等待终态：所有平台 `show`/throw/unsupported/timeout；Windows 额外 `failed`；macOS/Linux 不监听不存在的 failed。
- [ ] notification options builder 只使用平台支持字段；macOS 使用 P0.0 signed POC 选定的有声配置，Windows/Linux 不用 option shape 冒充声音证据。
- [x] Main 保存 pending click action，renderer ready 后幂等送达；event id 防重复 navigation。
- [x] 测试通知写真实 event/delivery，title/body 明确标为测试；点击目标可验证但不污染助理 memory/chat。
- [x] delivery status UI 暴露 attempt count、last error、OS accepted time，不展示假“用户已读”。
- [x] 删除/停用旧 renderer-native IPC 消费路径与 bg visibility switch，增加 import/source boundary guard 防回归。

### 自动化

- 两个并发 consumer 只能 claim 一次；
- crash/stale claim 可回收，terminal 不回滚；
- renderer 不能 claim `electron-native`；
- `show` 才 delivered；共同 throw/timeout/unsupported → error；Windows failed → error；macOS/Linux 无 failed fixture 且按 timeout 收口；
- visible ↔ hidden 切换 1 event / 1 native delivery；
- click-before-ready、reload、duplicate click；
- old DB migration idempotent and data preserving；
- remote Origin、non-loopback Host、text/plain、非法 channel 被拒绝。

### Phase gate

- [x] 页面 toast 数量不再决定 native delivery status。
- [x] server / renderer 重启后 queued native delivery 可恢复（stale claim 自动化）。
- [ ] macOS signed packaged 的 show/sound/click 真实 smoke 通过。
- [ ] Windows installed NSIS 的 AppUserModelID/shortcut/show/sound/click 真实 smoke 通过；dev 结果不计入。

## P0.4 — 三平台纵向 smoke、文档与发布门禁

### 用户会看到什么

- 同一条流程在支持的平台表现一致；平台不支持的部分有诚实说明。
- 助理设置页提供最短自测：查看目录 → 立即检查 → 测试系统通知。

### 验收入口

- macOS signed DMG/ZIP 安装版；
- Windows NSIS 安装版；
- Linux 当前恢复的发布产物，在至少一个受支持桌面环境实测。

### 本阶段明确不做

- 不用 dev Electron 的 unsigned notification 结果替代 macOS packaged 结果。
- 不把 Windows/macOS 结果外推成 Linux 已通过。

### 执行清单

- [x] 更新 `ElectronMain.md`：native 单 owner、delivery lifecycle、sound 和 click pending contract。
- [x] 更新/新增 Assistant Workspace guardrail：default no-overwrite、neutral file、desired/actual split。
- [x] 更新 `DatabaseSchema.md`：heartbeat duplicate consolidation / partial unique index、delivery claim migration 与 terminal transition。
- [x] 更新 Harness Home umbrella：本 P0 是用户可见纵向切片，不等于完成 Memory vNext。
- [x] 更新 handover / insights（若行为或产品语义变化）与中英文文案。
- [ ] 运行 Tier 0/1 自动化、production build、packaged server verification（前两项与 Electron bundle 已通过；最终 package/server verification 待平台产物）。
- [ ] 依平台执行下方矩阵并写 Smoke Ledger。
- [ ] Claude review 的每条 P1/P2 必须修复、补测试或进入 tech-debt tracker；不在聊天里口头关闭。

### 发布门禁

- [ ] Fresh profile 默认助理 smoke。
- [ ] Existing profile old path no-touch smoke。
- [ ] HEARTBEAT_OK silent smoke。
- [ ] Heartbeat speak-up → native show → sound policy → click session smoke。
- [ ] visible/hidden/renderer reload 不重复、不漏投。
- [ ] notification permission denied / unsupported 路径诚实显示。
- [ ] macOS / Windows / Linux 独立结论均已登记。

## 8. 用户验收矩阵

| ID | 场景 | 期望 | 不能接受 |
|----|------|------|----------|
| A1 | 新用户首次启动 | 自动建默认目录；侧栏有零会话助理 | 强制先选目录；创建假 session |
| A2 | 老用户已有有效目录 | 继续沿用，文件 hash 不变 | 迁移、覆盖、复制到默认目录 |
| A3 | 老用户路径暂时不可用 | 保留原路径，显示修复 | 静默换成默认目录 |
| A4 | 新用户未 onboarding | 可直接聊天，可看 heartbeat 设置 | 必须完成问答才能使用 |
| A5 | bootstrap 与用户显式 PUT 并发 | 显式路径最终胜出；bootstrap CAS no-op | bootstrap 后提交覆盖用户选择 |
| A6 | `instructions.md` 与 legacy rules 同存 | canonical 优先；env Claude clean owner 去重；Codex canonical 始终进入 developer instructions，native 重复暂时允许 | canonical 丢失或把未经 POC 的 Codex native owner 当事实 |
| A6b | managed `CLAUDE.md` / `AGENTS.md` 被单独修改 | 整组停止覆盖、Settings 披露；canonical 仍是 CodePilot 真源 | 用户规则被静默覆盖或两 Runtime 漂移 |
| H1 | heartbeat off | 正常清理后 0 system task；即使 stale row 暂存也 0 model call | 后台偷偷运行/花费额度 |
| H2 | enabled + app restart | exactly one active system row，next run 不被无故重置 | 重启后消失/重复 |
| H3 | empty HEARTBEAT.md | skipped_empty，0 Provider call | 花费模型额度 |
| H4 | exact HEARTBEAT_OK | run success/silent，0 message，0 notification event | 页面/系统弹提醒 |
| H5 | HEARTBEAT_OK + prose | speak-up | 被宽松 stripping 吞掉 |
| H6 | Provider/model invalid | blocked + actionable reason，0 fallback | 静默换 Provider 或假 success |
| H7 | manual run 与到期竞争 | one run，另一方 already_running | 两次模型调用/两次通知 |
| H8 | 用户 24h→1h 修改 interval | task id 不变；按新 cron 重算 next_run，≤1h 生效 | 沿用旧 next_run 再等 24h |
| H9 | public chat 伪造 autoTrigger heartbeat | 服务端不进入 heartbeat context/stripping | 绕过 empty/desired/provider 费用门 |
| N1 | 窗口 visible | Main 显示一次 native；chat/run 可追踪 | renderer + Main 各弹一次 |
| N2 | 窗口 hidden / tray | Main 显示一次 native | 只有页面 toast |
| N3 | server 在 queued 后重启 | stale claim 恢复，最多一次 terminal delivery | 永久丢失或无限重试 |
| N4 | OS `show` event | 标记 OS accepted | 调 `show()` 立即 delivered |
| N5-Win | Windows failed / timeout / throw / unsupported | error + reason | 假 delivered |
| N5-Mac/Linux | macOS/Linux timeout / throw / unsupported | error + reason；不等待 failed | 伪造不存在的 failed 事件或永久 queued |
| N6 | 点击时 renderer 未 ready | 缓存，ready 后打开对应 session | 打开窗口但丢路由 |
| N7 | 系统关闭声音/勿扰 | 不绕过，UI 文案诚实 | 自播音频绕过系统设置 |

## 9. 数据安全、权限与成本边界

### 9.1 数据安全

- 默认 bootstrap 是 additive；不删除、移动或 rename 旧 workspace。
- DB migration 只 add column/index，不清理历史 notification rows。
- tests 必须使用 DB isolation；不得触碰 `~/.codepilot/codepilot.db` 或真实 Documents。
- default directory fixture 必须注入 temp root，禁止测试在用户 Documents 创建文件。

### 9.2 权限边界

- fixed default path IPC 无输入，不提供通用文件系统能力。
- native claim endpoint 不接受浏览器任意 channel；本地 mutation trust 规则有 adversarial tests。
- heartbeat 维持严格 read-mostly 工具集；不能因为“系统任务”获得更高权限。
- 通知 body 只使用本次 heartbeat 的 bounded 用户可见摘要；日志不得记录完整 memory、prompt、路径或 Secret。

### 9.3 成本边界

- heartbeat 默认 off。
- empty checklist 0 model call。
- UI 开启前说明 cadence 与可能费用。
- run concurrency、timeout、backoff 和 consecutive failure disable 继续生效。
- “测试系统通知”0 model call。

## 10. 风险与防线

| 风险 | 后果 | 防线 |
|------|------|------|
| 默认目录覆盖老用户选择 | 私有 Memory/规则丢失或切错 | only-if-empty + compare/no-overwrite + old-path fixtures |
| bootstrap 入口检查后被显式 PUT 抢先 | bootstrap 覆盖用户刚选的路径 | single-flight + commit-time DB CAS；显式 PUT 胜出 fixture |
| 默认 workspace 继续生成 `claude.md` | 新用户数据继续绑定框架命名 | neutral canonical file + legacy compatibility |
| ClaudeCode 原生 rules + Assembler 双注入 | 规则重复、权重畸变 | real settingSources smoke + Runtime-aware effective owner |
| 初始化成功但侧栏为空 | 用户认为功能没生效 | zero-session assistant state |
| desired 写成功、task 写失败 | 已开启但无法执行 | blocked combined status；不伪装 success |
| task 残留而 desired 已 off | 幽灵模型调用与费用 | runner pre-provider desired gate |
| 并发 reconcile 双 row | 双模型调用/双通知 | partial UNIQUE index + transaction/conflict reread |
| 启动只拉 scheduler 不 reconcile | DB 漂移后永久不触发 | startup desired-state reconciliation |
| 两套 silent helper | 正文被吞/无事却提醒 | one exact classifier + reachability guard |
| empty checklist 仍调模型 | 无意义费用 | pre-provider empty gate |
| shared destructive queue | 漏投/重复 | durable per-channel claim |
| durable consumer 重放旧 queued backlog | 升级后集中弹出数月前测试通知 | one-time cutoff migration；标记 skipped、保留审计、不删 event |
| renderer/main 双 native owner | 切窗口时重复 | Main-only native boundary |
| `show()` 即 delivered | observability 造假 | event-driven terminal ack |
| 跨平台等待不存在的 failed | 永久 queued / 假测试 | Windows failed；macOS/Linux bounded timeout |
| OS 不支持声音却承诺 | 用户信任下降 | per-platform contract + packaged evidence |
| click IPC 在 reload 丢失 | 通知无法回到任务 | pending action + ready ack |
| 测试写真实 Documents/DB | 污染用户数据 | injected temp root + isolation fail-closed |

## 11. 验证命令与分层

实施时按实际文件补齐定向命令，最低要求：

```text
# Tier 0 / Tier 1
CODEX_DISABLED=1 npm run test

# 定向（最终文件名由实施回填）
CODEX_DISABLED=1 npx tsx --test --import ./src/__tests__/db-isolation.setup.ts \
  src/__tests__/unit/default-assistant-bootstrap.test.ts \
  src/__tests__/unit/heartbeat-reconcile.test.ts \
  src/__tests__/unit/notification-delivery-claim.test.ts \
  src/__tests__/unit/electron-notification-lifecycle.test.ts

# Production / packaged
npm run build
npm run electron:pack:mac
npm run electron:pack:win
npm run electron:pack:linux
node scripts/verify-packaged-server.mjs <artifact>
```

说明：

- 不能同时在同一 worktree 运行 dev 与 build；遵守 `assert-next-build-safe`。
- Electron Notification / sound / click 属 Tier 2；source-pin 和 fake adapter 单测只证明 wiring，不替代 packaged smoke。
- Linux 必须记录 desktop environment、notification daemon、包形态；“CI 构建成功”不等于通知可见。

## 12.1 P0.5 — 全系统通知与交互任务关键提醒（2026-08-28）

### 用户反馈与取舍

用户指出右下角内部通知不应继续作为通知产品面，所有 Notification Manager 事件都应进入系统通知；同时当前最关键的“任务完成”和“需要审批”在交互聊天中缺失。实现复用既有 Main-owned durable native 链，不新增 Renderer→Main 任意 title/body IPC，也不让 ChatView mount 状态决定是否提醒。

### 实现与验收

- `sendNotification` 的 low/normal/urgent 全部创建 `electron-native`；urgent 仍按既有策略额外考虑 Bridge，non-urgent 不产生 Bridge row。
- AppShell 移除 `useNotificationPoll`，页面 Toaster 继续服务操作反馈与 CLI maintenance card，不再消费 notification delivery。
- `collectStreamResponse` 是三 Runtime 单一触发点：审批按 `permissionRequestId` 去重；完成只在 successful result + terminal assistant persisted + current lock owner 成立时发出。Codex `interrupted` / `inProgress` 为 sticky 非成功终态，后续 usage-only result 不得恢复成功。
- native copy 按持久化 locale 生成并限制会话/tool 字段长度、清除控制字符；不包含 tool input、路径或模型答案。event 保存 session/action，点击回 `/chat/<sessionId>`。
- DB revision bump 后事务迁移仍 queued 的 renderer row：无 native peer 原位改 channel；有 peer 只把 renderer duplicate 标 skipped；terminal 历史不改、不删。
- 自动化：`interactive-chat-notifications.test.ts` 覆盖审批重复 frame、成功完成、失败/autoTrigger/stale owner 反例与参数不泄露；`notification-channel-retirement.test.ts` 覆盖迁移正反例与幂等；channel/Main owner 既有测试同步改为全 native。

### 保留门禁

- macOS unsigned dev 继续 fail-closed，因此本轮不能用正在运行的 dev Electron 宣称系统横幅可见；真实 task-complete/approval 的 show/sound/click 仍随 signed macOS、installed Windows、packaged Linux Smoke Ledger 执行。
- “系统已接受”仍不等于用户已读；勿扰/系统权限由 OS 决定。

## Smoke Ledger（真实 UI / Runtime / 系统通知证据）

> 只有真实运行后才追加结果；不得预填成功。Evidence 至少包含 build/version、平台、workspace fixture、task/run/event id、native lifecycle 日志与点击目标。不得写 Token、完整用户路径或私有 Memory 内容。

| Date | Phase | Platform / package | Runtime | Provider / Model | 场景 | Result | Evidence |
|------|-------|--------------------|---------|------------------|------|--------|----------|
| 2026-08-03 | P0.0 | macOS / Claude CLI 2.1.220 | `claude_code` | env / Haiku | 临时 cwd `CLAUDE.md` + `--setting-sources project`，无工具、无持久 session | PASS | 模型准确返回唯一 marker，证明 SDK 原生加载 project rules；成功 run `$0.0022951`。两次预算不足预跑 `$0.036809` / `$0.01413` 记录为失败，不计成功证据 |
| 2026-08-03 | P0.1–P0.3 | isolated worktree + APFS build copy | automated | no live Provider | 全量测试、Next production build、Electron main/preload bundle | PASS | `npm run test`: 5019/5019；`npm run build` compiled 136 routes；`node scripts/build-electron.mjs` complete。既存 NFT dynamic-trace warning 仍存在 |
| 2026-08-04 | Review fix round | current isolated worktree | automated | no live Provider | Codex canonical rules 保守投递、mirror conflict/CRLF、model warm-up success memo；全量测试、Next production build、Electron bundle | PASS | 定向 74/74；Provider 生命周期失效点收口后复跑 62/62；最终 `npm run test`: 5036/5036；`npm run build` compiled 136 routes；`node scripts/build-electron.mjs` complete。仅既存 NFT dynamic-trace warning |
| 2026-08-28 | P0.5 notification unification | current worktree + isolated Next dist | automated | no live Provider | 全 priority native、legacy renderer queued 迁移、交互审批/完成/stale owner/隐私反例 | PASS | 定向 22/22；`npm run test`: 5433 pass / 0 fail / 1 skip；隔离 production build compiled 137 routes。仅既存 NFT dynamic-trace warning；packaged show/sound/click 未执行 |
| 2026-08-29 | P0.5 review fix | current worktree + isolated Next dist | automated | no live Provider | Codex interrupt/inProgress + usage sticky 非成功终态、自然 end_turn 对照、renderer claim/ack 退役 | PASS | 定向 23/23；`npm run test`: 5437 pass / 0 fail / 1 skip；隔离 production build compiled 137 routes。仅既存 NFT dynamic-trace warning；packaged show/sound/click 未执行 |
| 2026-08-29 | P0.5 stable shipment | `v0.67.11` macOS/Windows/Linux package | automated packaging | no live Provider | 正式三平台构建、Mac 签名/公证/staple、双架构 ABI、公开资产完整性 | PASS（package / release） | [Actions](https://github.com/op7418/CodePilot/actions/runs/33230535883) / [Release](https://github.com/op7418/CodePilot/releases/tag/v0.67.11)；只证明承载代码的正式包已发布，不证明 OS 实际展示、声音、点击回会话，后者继续开放 |

## 13. Claude review 请求清单

请 Claude 优先审以下争议点，而不是只看计划格式：

1. commit-time CAS + single-flight 是否足以保证所有 interleaving 下 bootstrap 输给显式 PUT；是否还需 DB-level setting revision。
2. P0.0 的 ClaudeCode `settingSources` smoke 能否真实证明 effective prompt，而不只证明 FILE_MAP 单读；Runtime-aware 去重是否有更小方案。
3. desired-first → reconcile → blocked + runner pre-provider gate 是否关闭 enable/disable 两侧的幽灵运行窗口。
4. duplicate consolidation + exact-source partial UNIQUE index + conflict reread 是否保留历史 run/event 关联且不会触碰用户任务。
5. cadence-change 重算与 unchanged restart 保留 next_run 的判定是否可由旧/new schedule_value 唯一决定。
6. public `/api/chat` heartbeat shape 是否完全不可达；buddy welcome/soft check-in 是否仍会污染 heartbeat health。
7. empty/disabled 的 0 model call 是否由 provider-call-policy 单点 observer 真正证明，而不依赖 transport mock。
8. delivery status 枚举冻结 + column-only claim 是否覆盖 stale lease、retry cap、terminal transition与旧库迁移。
9. native claim route 的 Host / Origin / content-type / consumer boundary 是否能防网页 drain / DNS rebinding，又不破坏 electron:dev。
10. Electron Main 单 owner 是否覆盖 visible、hidden、reload、tray 和 app shutdown；点击 pending queue 是否会重复导航或无限增长。
11. Windows `failed` 与 macOS/Linux timeout-only 合同、macOS两种 sound POC、Windows installed NSIS gate 是否符合当前 Electron 类型和实际行为。
12. 本计划是否无意把 Assistant Workspace 与 Harness Home canonical repository 变成第二套真源。

## 14. 完成定义

本计划只有在以下全部成立时才能从 active 移到 completed：

- `Code complete`：P0.1–P0.3 实现与 additive migration 完成。
- `Tests pass`：全量测试、定向行为测试、production build 通过。
- `Smoke passed`：fresh/old profile、silent/speak-up、native show/sound/click 在目标平台有真实证据。
- `Release ready`：三平台支持矩阵和已知限制完成；没有未处理 P1/P2。
- 用户真实验收：“不用手动选目录，心跳能跑，后台能收到系统通知，点击能回来”。

任一平台只完成 build、未完成 native smoke，只能写 `Code complete + Tests pass`，不能写 `Smoke passed` 或 `Release ready`。

## 15. 决策日志

- 2026-08-28：用户明确 Notification Manager 不再使用右下角 renderer toast，low/normal/urgent 全部改为 Main-owned system notification；同时补交互任务完成与审批通知。触发点选择服务端 collector 而非 ChatView，避免切会话/reload 导致漏发或重复；完成通知要求 successful result、terminal assistant 已落库和 current lock owner 三项同时成立。旧 queued renderer row 非删除迁到 native，真实 packaged show/sound/click 保持开放。
- 2026-08-29：Claude follow-up review 指出 Codex Stop 会产生 `interrupted` result 后再产生 usage-only result，旧逻辑可能误报完成。修复将 `interrupted` / `inProgress` 设为 sticky 非成功终态，并抑制 native/Telegram completion 与标题生成；同时把 claim/ack HTTP 收口为 native-only，Settings 测试通知使用独立 same-origin policy。
- 2026-08-29：Claude 完整复审沿 stream→collector→notification manager→DB→Main→点击路由核对后给出 `accepted`；上一轮四个 finding 均以行为测试和真实调用链证据关闭。实现随 `v0.67.11` 正式发布，发布 CI 与公开资产审计通过；三平台 packaged native show/sound/click 仍不以 package success 冒充 smoke passed。
- 2026-08-03：用户拍板跨客户端兼容采用“一份 canonical + 两个 native 入口”。`instructions.md` 保持用户拥有的中立真源；CodePilot 生成带 hash 的 `CLAUDE.md` / `AGENTS.md`，只对 untouched mirror 自动同步，冲突时 freeze + Settings 告警。复核同时发现 Codex Runtime 虽收到 RuntimeStreamOptions.systemPrompt，但未把它送到 app-server；本轮补入 `developerInstructions`。2026-08-04 follow-up review 证明 Codex native owner 假设缺少非 git cwd / config disable POC，现保守改为 Codex 始终保留 canonical rules；未来只有真实 marker smoke 通过后才允许去重。
- 2026-08-04：Claude review 的 1 P1 / 3 P2 已按保守路径收口：Codex 不再依赖未经证明的 native `AGENTS.md` owner，canonical rules 恒进 `developerInstructions`；冲突态明确为 freeze + canonical 注入 + 可能 native 双投递；warm-up 成功在 renderer memo，Codex login start/complete/logout 在 Settings 侧显式以 generation 失效并阻止 stale in-flight ready（不能依赖当时通常未挂载的 chat hook）。同期将 CRLF-only mirror 归一化为 synced，记录 managed stale write 的残余毫秒级 TOCTOU，并补本轮 production build / Electron bundle 证据。实现按风险面拆为 `49d900bf`（legacy notification backlog）、`0e20c891`（native instruction mirrors + Codex developer instructions）、`e67e08b9`（macOS unsigned notification fail-closed）、`1c8bdf52`（assistant Settings UI）、`e6cbc671`（Codex model catalog warm-up）。
- 2026-08-03：macOS dev 验收发现侧栏助理提示沿用内容区重型 Card，与导航密度不一致；改为 sidebar token、紧凑层级和 ghost action。同期右下角连续 `Hi / There` 经 DB 复核为 137 条不同历史 `renderer-toast/queued`，不是同一 delivery 重试。修复采用一次性、非删除式 backlog migration：首次升级时只把超过 1 小时的 renderer/native 遗留 delivery 标记为 `skipped`，保留事件审计并保护新通知。
- 2026-08-03：Claude 完成实现复审并给出 `Review passed（Code complete + Tests pass 范围）`，首轮 3 P1 / 5 P2 全部真实收口；Smoke 保留项判定正确。代码按风险面拆为 `4b5f97dd`（DB CAS、heartbeat uniqueness、notification lease persistence）、`19847570`（默认助理规则所有权与 heartbeat desired/reconcile/runner）、`3f16b895`（fixed-path UI 接线与 Electron Main native delivery）。复审后补充 guardrail：当前 native lifecycle timeout 12s、stale claim lease 30s；未来调整 timeout 必须同步复核 lease，保持 timeout < lease。
- 2026-08-03：实现完成并通过自动化收口。默认助理使用 Electron fixed-path + process single-flight + DB CAS；新规则文件为 `instructions.md`，真实 Claude rules POC 后只在 cwd `CLAUDE.md` 的精确 SDK-owner 条件省略 Assembler rules；心跳统一 desired-first reconcile、partial UNIQUE 与 pre-provider gate；notification 改为 Main-only durable claim/ack、event-driven OS accepted、bounded Notification retention 与 pending click queue，heartbeat click 明确返回对应助理 session。`npm run test` 5019/5019、Next production build 与 Electron bundle 通过；三平台 packaged native/sound/click smoke 保持开放，因此状态为 Code complete + Tests pass，不是 Smoke passed / Release ready。
- 2026-08-03：macOS dev 实测暴露假成功：Electron 40 的 unsigned `Electron.app` 触发 `show` 并 ack delivered，但 Notification Center 无横幅。按 Electron 官方 code-signing 约束增加 Main preflight：darwin + `!app.isPackaged` 不构造通知，使用稳定错误码 non-retryable 收口；Settings 显示“需 signed CodePilot package”，不再把 unsigned dev 当 smoke 证据。正式 macOS show/sound/click 仍由 signed package gate 验收。
- 2026-08-03：助理设置的路径控件从“最近聊天 cwd Select”收敛为当前持久化路径展示。更换入口改名为“设置新的助理文件夹路径”，固定流程为后果确认 → 系统目录选择 → 目标目录 inspect/初始化或接管确认；文案明确人格、记忆、规则、心跳来源随路径切换，原目录不删除且不自动迁移。
- 2026-08-03：Claude 首轮 review 结论为 failed（3 P1 / 5 P2 / 4 P3，无 P0），确认方向与事实底座成立。计划逐条回写：bootstrap commit-time CAS、desired-first + runner gate、heartbeat partial UNIQUE index、ClaudeCode settingSources smoke、delivery status freeze、平台 lifecycle 矩阵、interval next_run 语义、服务端旧 heartbeat 封堵与 packaged sound/Windows 门禁；尚未开始产品实现。
- 2026-08-03：用户将“默认助理 → 心跳 → 系统通知”定为 Harness Home 当前 P0，并要求先写计划交 Claude 审查。
- 2026-08-03：默认助理只覆盖没有任何 workspace 设置的新用户；老用户非空路径无条件优先，invalid 也不静默替换。
- 2026-08-03：默认创建不自动开启 heartbeat，避免无感模型费用；onboarding 降为渐进增强。
- 2026-08-03：`HEARTBEAT.md` 是用户检查内容，不是 scheduler state；调度/运行/投递分别由 durable runtime records 负责。
- 2026-08-03：native 系统通知由 Electron Main 单独拥有；renderer toast 不能作为 native delivery 成功证据。
- 2026-08-03：提示音使用 OS notification policy，尊重权限与勿扰；本轮不另造自播放音频通道。
- 2026-08-03：本计划不自动合并 Assistant Workspace 与 Harness Home repository；先完成真实用户路径，再按 canonical migration contract 收敛数据模型。
