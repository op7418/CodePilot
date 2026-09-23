# Assistant Workspace Guardrail

> **Status: Active contract** — 覆盖默认助理建立、旧目录 no-touch、规则文件解析、心跳 desired/actual 状态与系统通知可观测性。
> **为什么先读**：这条链同时触及用户文件、模型费用、后台调度和系统通知。任一层 fail-open 都可能覆盖用户目录、产生幽灵模型调用，或把页面提示伪装成系统通知成功。

## 快捷建议失败冷却（2026-09-07）

动态 quick-actions 是可降级的辅助调用：成功缓存 10 分钟；失败或无动态结果仅返回静态建议，冷却 1 分钟后可重试。同一 workspace 的 in-flight 请求合并，切换 workspace 不复用另一工作区的建议/冷却，旧异步结果不得覆盖当前 cache slot。缓存只保留一个 workspace slot；single-flight 仅在当前 slot 成立，A→B→A 在 A 尚未完成时会重新生成（已知有界缓存取舍），不能宣称跨 workspace 交替仍全局去重。不以用户内容构造遥测字段。调用仍通过既有 Provider 解析与 reportProviderFailure；不能以冷却逻辑吞掉首次真实失败的诊断。回归：`quick-action-suggestions.test.ts` 覆盖失败→冷却→恢复、成功 TTL、并发、workspace 切换与空结果后配置恢复。

## 1. 词汇表

| 词汇 | 含义 |
|------|------|
| Default assistant home | Electron 根据 `app.getPath('documents')` 解析的 `<Documents>/CodePilot/Assistant`，只用于没有任何 workspace 设置的新用户。 |
| Explicit workspace | 用户已经保存的任意非空 `assistant_workspace_path`；即使无效或暂时离线，也必须保留。 |
| Canonical instructions | 新目录使用的中立规则文件 `instructions.md`。 |
| Native instruction mirrors | CodePilot 从 canonical 内容生成的 `CLAUDE.md` / `AGENTS.md`；带来源 hash，不是独立真源。 |
| Legacy rules | 旧目录中的 `claude.md`、`CLAUDE.md` 或 `AGENTS.md`；只读兼容，不自动改名。 |
| Desired state | `.assistant/state.json` 中用户是否启用心跳及其 cadence。 |
| Actual state | SQLite `scheduled_tasks` 中可执行的 heartbeat task 及 `next_run`。 |
| Silent heartbeat | 模型输出 trim 后严格等于 `HEARTBEAT_OK`。 |
| Meaningful alert | 非 silent heartbeat 产生的真实助理消息和 notification event。 |

## 2. 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|--------|--------|
| 1 | 只有 setting 缺失、空或全空白时才能 bootstrap；任意非空旧路径绝不迁移、替换或清理 | `bootstrapDefaultAssistantWorkspace` |
| 2 | 默认路径必须由 Electron fixed-path IPC 解析；Renderer/Next 不得传任意路径给该 IPC | `resolveDefaultAssistantHome` + preload bridge |
| 3 | bootstrap 使用进程 single-flight，最终选择用 DB commit-time CAS；并发显式 PUT 永远有最终决定权 | `bootstrapDefaultAssistantWorkspace` + `compareAndSetSettingIfBlank` |
| 4 | 默认初始化只创建最小用户文件与由 canonical 派生的 native mirrors；不创建 session、不调用模型、不启用 heartbeat、不发送通知、不初始化 Git | `initializeWorkspace` + bootstrap tests |
| 5 | 新目录以 `instructions.md` 为唯一真源，并生成带 hash 的 `CLAUDE.md` / `AGENTS.md`。只有 mirror 仍等于上次生成内容时才允许同步；任一被手改/unmanaged 则整组停止覆盖并向 Settings 报冲突。无 canonical 的 legacy 目录完全 no-touch | `inspectInstructionMirrors` + `reconcileInstructionMirrors` |
| 6 | 只有真实 POC 证明的 env Claude + synced `CLAUDE.md` owner 才可让 Context Assembler 省略 rules fragment；Claude DB-provider 仍由 CodePilot 注入。Codex 的非 git cwd / `project_doc_max_bytes=0` 尚未证明，因此即使 `AGENTS.md` synced，canonical rules 也必须保留在 `developerInstructions`，宁可原生加载后重复也不能静默丢失 | Runtime ownership gate + Codex developer-instructions wire |
| 6a | mirror modified/unmanaged 时整组 freeze，Assembler 继续注入 canonical；Runtime 仍可能原生加载用户版 mirror，因此冲突期间模型可能同时收到两套规则。Settings 必须披露冲突，CodePilot 不覆盖或猜测合并顺序 | mirror inspection + Settings conflict UI |
| 7 | Onboarding 是渐进增强，不是聊天或心跳开关的门禁；heartbeat 默认关闭并显示模型成本提示 | Settings UI |
| 8 | `HEARTBEAT.md` 只描述检查内容；desired、schedule、run 和 delivery 分属 state file、task row、run log、notification delivery | workspace API + scheduler |
| 9 | 设置变更固定为 desired 原子落盘后 reconcile；reconcile 失败保留用户意图并返回 blocked，不能伪装 success | workspace PATCH + `reconcileAssistantHeartbeat` |
| 10 | heartbeat row 对 exact source 全库至多一条；迁移先重关联 run/event 再合并 duplicate 并建 partial UNIQUE index | DB migration |
| 11 | runner 在创建 session 和调用 Provider 前重读 desired；disabled/mismatch 以 `skipped_reconcile_drift` 收口，0 Provider、0 notification | agent task runner |
| 12 | empty checklist 以 `skipped_empty` 收口；只有 exact `HEARTBEAT_OK` silent。普通 `/api/chat` 不能伪造 heartbeat turn | heartbeat classifier + provider policy gate |
| 13 | 手动“立即检查”和 scheduler due 使用同一 row lock/run path；竞争只能有一个执行者 | `runScheduledTaskNow` |
| 14 | UI 必须分别显示 desired、actual、last run、last meaningful alert 与 native delivery；禁止从 `lastHeartbeatDate` 推断健康 | workspace summary + Settings |
| 15 | 测试系统通知写真实 event/delivery，但不调用模型、不创建聊天/记忆；“delivered”只表示 OS 接受，不表示用户已读。macOS unsigned dev Electron 必须 fail-closed 并提示使用 signed package，不能用 `show` 事件伪装可见 | notification test route + Main preflight + UI copy |
| 16 | Settings 只展示当前持久化助理路径，不把聊天历史目录伪装成可随手切换的 Select；更换路径必须先解释身份/记忆/心跳来源切换与 no-delete/no-auto-migrate 后果，再打开系统目录选择，选中后仍走目标目录 inspect 门禁 | AssistantWorkspaceSection + WorkspaceConfirmDialogs |
| 17 | 所有 Notification Manager 事件无论 low/normal/urgent 都创建 `electron-native` delivery；Renderer 不消费通知队列，页面 toast 只用于即时操作反馈，不得冒充系统通知 | `notification-manager.ts` + AppShell + native delivery service |
| 18 | 交互聊天的审批请求与成功完成由服务端 `collectStreamResponse` 单点创建 durable event，覆盖三 Runtime。审批按 request id 去重；完成必须同时满足 successful result、assistant terminal 已持久化、仍持有当前 session lock。Codex `interrupted` / `inProgress` 是 sticky 非成功终态，后续 usage-only result 不得恢复成功。owner check 到 native event/delivery insert 之间不得有 await；失败、停止、autoTrigger 与 stale owner 不得发完成通知。锁屏正文不得含 tool input、路径或模型正文 | collector + `interactive-chat-notifications.ts` + notification manager static DB insert |
| 19 | notification claim/ack HTTP 面只接受 `electron-native` + Electron Main owner；`renderer-toast` 只保留在 DB 历史/迁移类型中。Settings 的“测试系统通知”使用独立 same-origin Renderer policy，不得借旧 channel 伪装 consumer | notification claim policy + notify claim/ack/test routes |

## 3. 关键文件 + 责任

| 文件 | 责任 |
|------|------|
| `electron/default-assistant-home.ts` | 默认目录纯解析函数 |
| `electron/main.ts`, `electron/preload.ts` | fixed-path IPC、native delivery owner 与点击 ready handshake |
| `src/lib/assistant-default-workspace.ts` | single-flight、初始化和 commit-time CAS |
| `src/lib/assistant-workspace.ts` | 模板、canonical/legacy resolver、原子 state 写入 |
| `src/lib/assistant-heartbeat.ts` | desired read、reconcile、task/desired 一致性与 outcome |
| `src/lib/task-scheduler.ts` | single task、cadence、manual/due 统一 run lock |
| `src/lib/agent-task-runner.ts` | pre-provider desired/empty gate、silent/speak-up 行为 |
| `src/app/api/settings/workspace/route.ts` | bootstrap、PATCH 顺序和 breadcrumbed summary |
| `src/lib/notification-manager.ts` | priority-to-channel policy 与 durable event creation |
| `src/lib/chat-collect-stream-response.ts`, `src/lib/interactive-chat-notifications.ts` | 三 Runtime 统一的审批/完成触发、truthful terminal gate、锁屏安全文案与会话点击路由 |
| `src/app/api/tasks/notify/**` | Main-only native claim/ack 与独立 same-origin test mutation boundary |

## 4. 改动检查表

- [ ] default bootstrap fixture 使用临时 Documents 和隔离 DB，绝不触碰真实 `~/Documents`。
- [ ] 非空、无效、离线旧路径仍保持选中，文件 hash 不变。
- [ ] bootstrap/PUT 各种 interleaving 下显式值最终胜出。
- [ ] 新模板以中立 canonical 为真源；两份 native mirror 有 provenance hash、clean update、manual-edit freeze 与 Settings conflict fixture。
- [ ] Claude Code rules ownership 改动有真实 SDK `settingSources` 证据，不靠 source shape 猜测。
- [ ] Codex 未完成“临时非 git cwd + synced `AGENTS.md` + `project_doc_max_bytes` 边界”的真实 POC 前，canonical rules 必须保留在 `developerInstructions`；未来要启用原生 owner，必须同时证明 native discovery 与最终模型可见 marker。
- [ ] heartbeat cadence 不变时保留合法 `next_run`，改变时同 task id 重算。
- [ ] disabled/empty heartbeat 的 Provider observer 仍为 0 hit。
- [ ] native delivery 失败不能被 renderer toast 掩盖。
- [ ] 新 notification event 只产生 `electron-native` delivery；Renderer poll 不得复活。
- [ ] 交互完成提醒同时检查 successful result、terminal message、lock owner；Codex interrupt/inProgress 后的 usage-only frame 不得恢复成功；审批重复 frame 只创建一次且正文不含 tool input。
- [ ] claim/ack 拒绝 `renderer-toast`；测试系统通知的 same-origin Renderer policy 不复用旧 delivery channel。
- [ ] Settings 不使用单个日期或客户端推断值表达 scheduler 健康。
- [ ] 文案不把 OS accepted 写成“用户已读”。

## 5. 常见坑

- 先检查 setting 为空再无条件 `setSetting`，会在初始化期间覆盖用户刚选的目录。
- 把目录初始化成功等同于用户已经完成 onboarding，或顺手创建一条假 session。
- 只让 FILE_MAP 单读一份规则，却忽略 Claude SDK / Codex 还会分别原生装载 cwd `CLAUDE.md` / `AGENTS.md`。
- 把 `CLAUDE.md` 与 `AGENTS.md` 当两份可独立编辑的真源；无 provenance 的自动覆盖会丢用户规则，完全不更新又会让两个 Runtime 漂移。
- 把 clean `AGENTS.md` 的存在当成 Codex 已原生装载的证据；非 git cwd 或用户 `project_doc_max_bytes=0` 都可能让发现失效。没有真实 POC 时不允许省略 developer instructions 中的 canonical rules。
- PATCH 先改 scheduler 再写 state，或 reconcile 失败后回滚用户文件，都会制造真源冲突。
- 让页面 mount/autoTrigger 重新成为 heartbeat 入口，会绕开 empty/disabled 费用门。
- 用 `Notification.show()` 方法返回代替 Electron `show` lifecycle event。
- 在 macOS unsigned Electron dev 中把 `show` event 当作 Notification Center 可见证据；macOS 原生通知要求 code-signed app，真实 smoke 只能来自 signed package。
- 让 renderer 和 Main 根据窗口可见性抢同一 native 队列。
- 在 ChatView mount/unmount 回调里发任务完成/审批通知；切换会话、reload 和 split view 会造成漏发或重复，应由服务端 collector 单点负责。
- 只跳过 Codex 的 `finish_reason: interrupted` 那一帧，却让紧随其后的 usage-only result 把 success 重新置位；非成功终态必须是 sticky 状态。
- 为保留 Settings 测试按钮而继续让通用 claim/ack policy 接受 `renderer-toast`；测试动作应有独立 same-origin policy。
- 把助理 workspace 当作普通 recent-project 下拉框；它是用户 Harness 的身份与记忆边界，切换必须显式确认，不能把历史聊天 cwd 混成候选助理目录。

## 6. 测试覆盖

| 契约 | 测试 |
|------|------|
| Bootstrap、CAS、no-touch、canonical + managed mirrors | `default-assistant-bootstrap.test.ts`, `setting-compare-and-set.test.ts`, `assistant-workspace.test.ts` |
| Rules effective owner | `assistant-rules-effective-owner.test.ts` |
| Reconcile、unique、cadence、disabled/empty gate | `heartbeat-reconcile.test.ts`, `heartbeat-trigger-discipline.test.ts`, `scheduler-trigger-unification.test.ts` |
| Claim/retry、route trust、退役 renderer HTTP 拒绝、Main lifecycle/click | `notification-delivery-claim.test.ts`, `notification-claim-policy.test.ts`, `notification-test-route.test.ts`, `electron-notification-lifecycle.test.ts` |
| Test notification purity | `notification-test-route.test.ts` |
| 全 priority native、legacy renderer queued 迁移、交互任务完成/审批/stale owner | `bridge-delivery-visibility.test.ts`, `notification-channel-retirement.test.ts`, `interactive-chat-notifications.test.ts`, `bg-poller-channel-parity.test.ts` |
| 全量门禁 | `npm run test`, `npm run build` |

## 7. 设计决策日志

- 2026-08-03 — 新用户获得 Electron Documents 下的默认助理；旧用户任意非空路径 no-touch。
- 2026-08-03 — 新规则文件改为 `instructions.md`，legacy 文件只读兼容；真实 Claude CLI 证明 project `CLAUDE.md` 会由 SDK 原生加载，因此只在该精确 owner 条件下省略 CodePilot rules。
- 2026-08-03 — 为跨客户端可移植性新增 managed `CLAUDE.md` / `AGENTS.md`。`instructions.md` 仍是唯一真源；mirror 带内容 hash，clean 才自动同步，手改/unmanaged 时整组 freeze 并在 Settings 披露。冲突态保守双投递，不自动覆盖或合并。
- 2026-08-04 — Claude review 指出 Codex 原生 `AGENTS.md` owner 没有非 git cwd / `project_doc_max_bytes=0` 的真实证据。收口为 Codex 始终通过 `developerInstructions` 接收 canonical rules；只有已完成真实 POC 的 env Claude clean mirror 路径允许 omit。
- 2026-08-04 — managed mirror 的 header 与 hash 对 CRLF/LF 等价，避免 Windows 只换行尾就出现假冲突；stale mirror 写前会复检，但复检到 atomic rename 之间仍有无法完全消除的毫秒级窗口，只会影响 provenance/hash 完整的受管文件，冲突时继续 fail closed。
- 2026-08-03 — heartbeat 收敛为 scheduler 单入口，desired-first + execution-time gate 同时保护一致性和模型费用。
- 2026-08-03 — native delivery 改为 Electron Main 单 owner 的 durable claim/ack；设置页的测试入口不产生模型或聊天副作用。
- 2026-08-28 — 用户取消 renderer notification surface：low/normal/urgent 全部走系统通知。已有 queued renderer delivery 在保留历史 row 的前提下迁到 native；交互聊天新增服务端审批与真实成功完成通知，点击回原会话。
- 2026-08-29 — Claude 复审发现 Codex Stop 后会先发 `finish_reason: interrupted`、再发 usage-only result，旧 collector 会被第二帧重新置为成功。完成状态新增 sticky 非成功终态并同步抑制 native/Telegram completion 与标题生成；claim/ack HTTP 面同时收口为 native-only，Settings 测试动作改用独立 Renderer policy。

- 2026-09-21 — Memory 工具与自动服务仅启用已绑定助理会话；普通项目仅保留一般文件工具，不挂 Memory。升级前已有助理会话一次性保留绑定，新会话不按 cwd 暗中启用；Bridge 明确选择助理目录才绑定，UI 使用后端同一判定。成功回合生命周期、三 Runtime 共享工具与来源/更正/忘记另见 [Memory Guardrail](Memory.md)。宠物不作为基础记忆入口门禁。

- 2026-09-22：checkin 复用仅筛选 source=user，task 不能显式绑定或被读路径识别为助理。Bridge/wizard 创建会话与绑定失败必须回滚数据库事务，避免未绑定孤立会话；wizard 已建立的目录/文件不属于该事务保证。
