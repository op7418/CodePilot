# DatabaseSchema Guardrail

> **Status: Active contract** — 覆盖 SQLite schema 初始化、增量加列、保守 backfill、幂等与测试隔离。
> **为什么先读**：用户真实数据在 `~/.codepilot/codepilot.db`；schema 迁移**必须 backfill，不能 DELETE 用户数据**（`feedback_db_migration_safety.md`）。一次错误的 migration 可能让用户丢失所有历史会话 / Provider 配置。
> **已知关键文件**：`src/lib/db.ts`（schema + migration runner）；`src/types/index.ts`（DB 行类型）。

## 词汇表

- **Bootstrap schema**：`getDb()` 首次打开数据库时执行的 `CREATE TABLE IF NOT EXISTS` 基线。
- **On-touch migration**：启动时通过 `PRAGMA table_info` 检测旧库缺列，再用 `ALTER TABLE ... ADD COLUMN` 增量升级。
- **Backfill**：在保留原行与关联数据的前提下，为旧数据补出可证明的新字段值。
- **Conservative fingerprint**：只有全部必要证据同时成立才写入身份；证据不足保持默认空值并交给用户确认。
- **Idempotent migration**：同一数据库重复启动/执行迁移，第二次及以后不再改变结果。
- **DB-wins**：`provider_models` 中的 manual / user-edited 行优先于 catalog，不因 schema/catalog 迁移被覆盖。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|--------|--------|
| 1 | Migration 必须保留所有用户数据（backfill 而不是 DELETE）；新增字段用默认值填，不要求用户手动迁移 | `src/lib/db.ts` migration 函数 |
| 2 | 每个 migration 必须可重入：先检测列/表状态，backfill 只更新仍处于 legacy 默认值且证据充分的行 | `PRAGMA table_info` + 带条件 `UPDATE` |
| 3 | schema 变更必须同时更新 bootstrap schema、旧库 on-touch migration、TypeScript 行类型和全部 CRUD SQL | `src/lib/db.ts`, `src/types/index.ts` |
| 4 | 多步 backfill 必须在一个 SQLite transaction 内完成；任一步失败不得留下半迁移身份 | `db.transaction(...)` |
| 5 | 身份/协议类 backfill 必须 fail closed：ambiguous 或 fingerprint 不完整时保留空值，不按数组顺序、名称、key 前缀或模型子集猜测 | provider migration helper |
| 6 | provider schema/catalog 迁移不得删除或改写 `manual`、`user_edited=1` 模型行，也不得删除 provider/session/message | migration + provider model reconciliation |
| 7 | 测试不得触碰用户数据库；全量 Node 命令必须预加载 `db-isolation.setup.ts`。任何会被单文件直接运行的 DB 测试还必须把该 setup 作为第一条 import，自行 fail closed，不能依赖操作者记住 `--import`；同时关闭并发 Codex runtime。Playwright 必须经 `scripts/run-playwright.mjs` 启动独立 loopback server、临时 `CLAUDE_GUI_DATA_DIR` 与独立 `.next-e2e-*`，禁止复用日常 dev server；直接 `npx playwright` 在缺少隔离环境时必须拒绝启动 | `db-isolation.setup.ts`, `scripts/run-playwright.mjs`, `playwright.config.ts`, `CODEX_DISABLED=1` |
| 8 | `messages.stream_status` 的 legacy 默认只能是 `completed`；collector 显式创建 `streaming`，真正的进程重启 recovery 才能将遗留 streaming 收口为 `interrupted`，不能重写历史完成消息或删除内容 | `src/lib/db.ts` + `chat-collect-stream-response.ts` |
| 9 | Schema bootstrap / on-touch migration 必须是纯结构初始化，不能顺带清理运行态。破坏性的 restart recovery（中断 stream/run、清空 lock、终止 permission）必须先取得进程级 owner，且 owner PID 仍存活时重复 module/route 初始化必须严格 no-op | `src/lib/db.ts` runtime owner guard |
| 10 | `subagent_runs` 的 running checkpoint 只能更新 `terminal=0` 行的 result/effective model，不得修改 status/completed_at；第一次 terminal 后所有迟到 checkpoint 必须原子 no-op | `checkpointSubagentRun` + `settleSubagentRun` |
| 11 | `subagent_runs.id` 是物理 attempt；用户任务身份是 `(parent_session_id, logical_run_id)`。同一 logical run 的 `attempt_number` 单调递增且唯一；旧 physical-only 行只能回填为各自独立 logical run / attempt 1，不得按名称或 prompt 猜重试关系。显式复用 logical ID 时，最新 attempt 必须已经 terminal 且不是 completed；running/settling 与 completed 分别以结构化错误拒绝，不能创建隐藏 attempt | `migrateSubagentRunSchema` + `startSubagentRun` |
| 12 | child 停止输出后必须先进入 `phase=settling`；结构化 result/provenance、effective route 与 terminal event 同事务落库后才写 `phase=terminal, terminal=1`。startup recovery 也必须生成 failed structured result/event，不能只翻 terminal bit | `markSubagentRunSettling` + `settleSubagentRun` + restart recovery |
| 13 | `subagent_run_events` 只接受枚举 lifecycle type，FK 绑定真实 attempt，logical id 来自 run row；重复 progress 可 coalesce，但 started/settling/terminal 审计事实不得靠模型自由文本推断 | `recordSubagentRunEvent` + `insertSubagentRunEvent` |
| 14 | workflow edge 是 `(parent_session_id, workflow_id, task_key)` 下的显式身份。依赖 task 在 Provider 启动前以 `dispatch_state=queued` 落库，只有上游同 workflow task 的 durable `completed + result_text` 齐备后才能切 `executing`；重复 key 与 self/indirect cycle 必须在插入/启动前拒绝；旧行保守回填为 `executing/terminal`，不得从 prompt 猜依赖 | `startSubagentRun` + `resolveSubagentDependencies` |
| 15 | Next dev HMR 会保留进程级 SQLite handle；新代码的 additive migration 不能依赖“重新打开 DB”才执行。`getDb()` 必须比较 code-owned schema revision，并在 revision 变化时只重跑幂等结构初始化；runtime recovery 不得随 HMR 重跑。回归测试必须在 revision refresh 前保留 live streaming row，并确认 refresh 后仍为 streaming，不能只断言 index/column 被补齐 | `DatabaseProcessState.schemaRevision` + `DATABASE_SCHEMA_REVISION` |
| 16 | Bounded Asset backfill 不能被单个 poison legacy row 或大文件永久饿死。失败项按 `(source_table, source_id, failure_revision)` 留下可审计分类：permanent 只在 revision bump 后重试，transient 冷却后自动重试，超过在线字节预算的 deferred 只由显式无界迁移重试。Gallery 在线路径同时受行数、累计字节、单文件字节与 wall-clock 预算约束；任何失败都不删除源 row，也不伪造成成功 Asset | `asset_backfill_failures` + `backfillMediaAssets` |
| 17 | `source='assistant_heartbeat'` 全库至多一条。建 partial UNIQUE index 前必须选 keeper、重关联 `task_run_logs.task_id` 与 `notification_events.task_id`、再删除 duplicate；user-source task 不得受影响 | `consolidateHeartbeatTasksAndEnsureUniqueIndex` |
| 18 | Notification claim 只使用 additive lease/attempt columns，不扩展既有 delivery status CHECK。claim 在 transaction 中完成；settle 用 owner/status 条件 UPDATE，stale ack 不能覆盖新 owner；retry backoff 有界且 terminal delivered/error 不回滚 | notification delivery migration + CRUD |
| 19 | Notification action 以受限 `action_type/action_payload` additive 保存；route consumer 只能按 channel claim，不能恢复 destructive GET drain | notification event/delivery schema + claim routes |
| 20 | `renderer-toast` 退役时不得删除历史 event/delivery。只把仍 queued 且没有 native peer 的行原位改为 `electron-native`；已有 native peer 时 renderer 行收口为可审计 skipped。迁移必须 transaction + idempotent，并 bump schema revision 使 dev HMR cached handle 也执行 | `migrateQueuedRendererNotificationsToNative` |
| 20 | 首次启用 durable notification consumer 时不得重放旧内存队列遗留的历史 `queued` 行。超过迁移安全窗口的 native/toast delivery 只改为可审计 `skipped`，保留 event/delivery；one-time marker 与 cutoff 必须同事务写入 | `suppressLegacyQueuedNotificationBacklog` |
| 21 | Provider secret 行同时含非空明文与密文时，明文代表回滚/旧版重写后的当前用户值，必须优先 materialize 并重新生成 envelope；不得信任旧密文复活旧 key。单行加密/验证/UPDATE 失败必须保留该行可恢复数据并记录脱敏诊断，不能穿透 `getDb()` 阻断应用启动或回滚其它健康行 | `materializeProvider` + `migrateProviderSecrets` |
| 22 | 正常 bootstrap 前对既有 DB 做一次 readonly `quick_check(1)`；失败不得进入 migration/runtime recovery，也不得循环换端口重试。必须先复制 DB/WAL/SHM 到时间戳目录并对每份副本 fsync + SHA-256 比对；复制前后的源文件集合/size/hash 也必须完全一致，跨文件撕裂只能标 partial。原件默认不删不改；只有用户在离线恢复页二次确认且完整备份校验成功后，才可移走原件并创建空库。健康响应必须执行最小 DB query，诊断只暴露低基数 code/preservation 状态，不含绝对路径或 SQLite 原文 | `database-integrity.ts` + `database-recovery.ts` + `/api/health` + Electron offline recovery |
| 23 | integrity corruption、transient busy/locked、migration failure、runtime-recovery failure 必须使用不同 startup code/UI。只有真实 corruption 能宣称 integrity failed 并提供“新建空库”；只有 preservation=complete/partial 才能提供“打开本次备份”，failed 必须如实提示重新备份。migration/runtime failure 不得把健康数据引向破坏入口，unknown health error 不得伪造 DB marker。migration/runtime 与 unknown-health 原始异常必须先收敛成有界、路径/凭据脱敏的本地 diagnostic，并进入支持日志/“复制诊断”，不能只剩低基数分类 | `src/lib/db.ts` + `database-recovery.ts` + `/api/health` + Electron offline recovery |
| 24 | `SQLITE_BUSY`/`SQLITE_LOCKED` 只允许有界重试；耗尽后进入可重试状态、不创建 corruption backup，也不得进程级永久 cache。普通 restart/retry 必须保持可用；初始启动失败尚未赋值 `serverPort` 时，“再试一次”必须重新拉起 utility 并返回真实 accepted 状态，不能静默 no-op | `database-integrity.ts` + `src/lib/db.ts` + Electron offline recovery |
| 25 | 用户确认“新建空库”且完整备份成功后，必须 fsync durable fresh-start intent（包含备份文件 size+SHA-256）。下一次 bootstrap 在 legacy copy 前验证 intent；若 DB/WAL/SHM 又出现，视为手工恢复或中断残留的歧义，绝不自动删除。离线页必须让用户明确选择“保留当前库并取消 intent”或“重新校验旧备份后继续空库”；空库成功打开后才清 marker | `database-recovery.ts` + `src/lib/db.ts` + Electron offline recovery |
| 26 | Electron Main、Next utility 与所有持久资源必须共用 `resolveCodePilotDataDir()`；自定义 `CLAUDE_GUI_DATA_DIR` 不得让恢复动作指向另一个库。health 已返回 path-free DB marker 时 Main 必须立即展示恢复页，不等通用 30 秒 timeout。时间戳恢复备份只在完整验证成功后按名称/直系目录/非 symlink 规则保留最多 10 个不同内容世代；相同 DB/WAL/SHM identity 复用既有备份，当前已验证备份受 retention 保护，无关目录与链接不动 | `codepilot-data-dir.ts` + `database-recovery.ts` + Electron Main |
| 27 | `chat_sessions.runtime_binding_state/runtime_bound_at/runtime_binding_source/route_revision` 与完整 route 是同一执行所有权合同。legacy backfill 只信合法 pin、唯一 Claude/Codex ref 和真实消息证据；双 ref/无证据保持 `legacy_unbound`，内部 switch marker 不算用户执行 | `thread-execution-binding.ts` + binding migration |
| 28 | `route_revision` 只在 route/binding 真实变化时每 transaction 加一；title、message、runtime ref、handoff 等无关写入不递增。route mutation 必须 CAS，失败/no-op 零写入 | `updateSessionRouteWithCas` + `bindSessionForExecution` |
| 29 | handoff 来源与目标、边界和 payload 必须同 transaction 创建；目标创建即 `bound`，来源零修改。目标唯一与幂等 key 防重复，busy/stale route/stale transcript 都不得留下孤儿 target | `chat_session_handoffs` + `createSessionHandoff` |
| 30 | compaction summary、coverage boundary 与 `chat_session_compaction_events` 必须原子提交；事件记录真实触发方式、辅助 route、估算值和是否重建底层 session，估算值不得进入 billing usage | `commitSessionCompaction` |

## 关键文件 + 责任

| 文件 | 守哪条不变量 |
|------|--------------|
| `src/lib/db.ts` | bootstrap schema、on-touch migration、事务 backfill、CRUD SQL、better-sqlite3 句柄管理 |
| `src/types/index.ts` | DB 行类型与 create/update API 请求形状一致 |
| `src/lib/provider-catalog.ts` | preset identity 的唯一/ambiguous 判定；migration 不自造另一套 matcher |
| `src/__tests__/db-isolation.setup.ts` | 每个测试进程使用隔离数据库目录 |
| `src/__tests__/unit/collect-owner-gate.test.ts` | 单文件直跑也先加载 DB isolation，防止 synthetic chat 写入 Dev 最近列表 |
| `src/lib/database-integrity.ts`, `database-recovery.ts` | 启动前只读探测、DB/WAL/SHM 保全、用户确认后的空库逃生路径 |

## 改动检查表

- [ ] 加新列时填默认值不要让历史行变 NULL
- [ ] 同时修改最早 bootstrap `CREATE TABLE` 与兼容旧库的 `CREATE TABLE IF NOT EXISTS`
- [ ] 同时修改 `ApiProvider` / request type / INSERT / UPDATE / masked API response
- [ ] backfill 是否只写可证明行，ambiguous/invalid 是否保持默认值
- [ ] 多表读取或多行更新是否包在 transaction，重复执行结果是否相同
- [ ] 是否保留 provider、model、session、message 数量及 manual/user-edited 字段
- [ ] 加新表时考虑用户已有的同名表冲突（不应该发生但要兜底）
- [ ] 改字段类型时必须有显式 migration step，不能依赖 SQLite 隐式 coerce
- [ ] 删字段 / 删表前先确认无用户数据依赖
- [ ] targeted migration test + `npm run test`；Provider/Runtime 字段再跑 build 与相关 smoke
- [ ] 流式消息列变更必须验证 bootstrap/on-touch 同形、legacy completed 默认、startup recovery 幂等、同 message id terminal update
- [ ] 改 startup recovery 时必须验证 schema 初始化不触发 recovery、同一存活 PID 的重复模块初始化不删除 lock/permission/checkpoint、真正遗留 run 才会被回收
- [ ] 新增或改单文件 DB 测试时，裸跑该文件是否仍先加载 isolation setup，并确认真实 Dev API/DB 行数无变化
- [ ] 新增或改 Playwright 写路径时，是否仍由 `npm run test:e2e/test:smoke/test:visual` 创建临时 DB/独立 build dir；fixture session 是否在 `finally` 精确回收；真实 `~/.codepilot` 行数前后是否不变
- [ ] 改 `subagent_runs` checkpoint 时验证 running 状态不变、terminal 后迟到写入 no-op、正文有明确大小上限
- [ ] 改 logical run/attempt 时验证唯一索引、attempt 单调递增、parent/UI latest-attempt 聚合、legacy 行“一行一 logical”保守 backfill，以及 active/completed logical ID 复用不会插入新 attempt
- [ ] 改 terminal 收口时验证 running→settling→terminal、structured result/provenance、terminal event 同事务和 restart recovery 同形
- [ ] 改 workflow/task/dependency 时验证 bootstrap + additive migration、queued→executing、missing-upstream 创建宽限与反序 fail-fast、同 workflow task key 防重复、self/indirect cycle 拒绝、dependency failure 不启动下游 Provider
- [ ] 给 `initDb` / `migrateDb` 新增 migration 时同步 bump `DATABASE_SCHEMA_REVISION`，并验证缓存 DB handle 不重启也能补齐结构、且不触发 runtime recovery
- [ ] notification channel 迁移保留 event/delivery row 数量与 terminal 历史；queued duplicate 先 skipped 再改 channel，避免触发 `(event_id, channel)` UNIQUE
- [ ] 改 Asset backfill 时验证 permanent/transient/deferred 分类、冷却重试、显式 deferred 恢复，以及在线行数/字节/时限预算均不会饿死后续行
- [ ] 改 heartbeat migration 时验证 duplicate consolidation 保留 run→event 关联、user-source task 不变、partial UNIQUE index 幂等
- [ ] 改 notification delivery 时保持 status 枚举冻结，验证双 claimant、owner mismatch、stale reclaim、retry cap 和 terminal immutability
- [ ] 从内存队列迁到 durable consumer 时验证历史 backlog 不会在升级后集中弹出，同时新近通知仍保持 queued、event 审计行不被删除、migration 重跑 no-op
- [ ] 改 Provider secret migration 时覆盖：纯 legacy 明文、明文 + 旧密文冲突、单行 UPDATE 失败后健康行继续迁移、失败行仍可在 Settings 修复；不得在 diagnostics 中回显明文/密文
- [ ] 改 DB 打开/health/startup 时覆盖健康库、truncated/not-a-db、WAL/SHM 一并保全、权限/磁盘失败、原件不自动删除、完整备份前不允许空库，以及 Electron 不循环换端口/不回显绝对路径
- [ ] migration/runtime-recovery failure 是否与 corruption 分型、没有虚构备份/完整性文案、没有破坏性“新建空库”；preservation failed 是否隐藏无效的打开备份动作；unknown health error 是否不带 DB marker且保留脱敏诊断
- [ ] busy/locked 是否有界重试、耗尽后可 retry/restart 且不缓存为永久 blocked；bare filesystem product fault 是否仍可诊断/上报
- [ ] fresh-start intent 是否在 legacy copy 前验证、绑定完整备份 identity、成功打开空库后才清 marker；重现 DB 是否进入明确二选一而非自动删除
- [ ] Main/utility/assets 是否共用 data-dir resolver；DB marker 是否立即展示恢复页；备份是否通过复制前后 generation envelope、相同世代去重，retention 是否不跟随 symlink、不删除无关目录或当前受保护备份
- [ ] 改 session route/binding 时验证 legacy 分类、CAS 精确递增、跨 Runtime 零写入、自动会话创建即绑定和无关写入不 bump revision
- [ ] 改 handoff/compaction 时验证目标/record 或 summary/boundary/event 全事务回滚，不留下孤儿或半套事实

## 常见坑

- 跨 Worktree / 多进程共用同一份 DB 文件时会抢 SQLite 锁（Phase 5b round 6 的 30 分钟卡死事件根因）。测试要用 `CODEX_DISABLED=1` 隔离。
- 只在 package script 里写 `--import db-isolation.setup.ts` 不够：开发者常会裸跑一个 DB 测试文件。可独立运行的 DB 测试必须首 import setup；否则 synthetic session 会直接进入 Dev 侧栏并挤掉真实最近会话。
- 不要按 Agent 名、prompt 文本或时间接近程度把历史 physical run 合并成 logical task；这些字段不具备稳定身份。只有调用方明确复用 `logical_run_id` 才能表示 retry。
- 不要把“调用方显式传了 `logical_run_id`”直接等同于合法重试。应用层必须在同一事务中检查最新 attempt：running/settling 时拒绝并行 attempt，completed 后拒绝覆盖已交付结果；只能从 failed/partial/timed_out/cancelled 等 terminal 状态追加 attempt。
- 不要在 child callback 一到就把 `terminal=1`。先写 settling，再把 structured result、provenance 和 terminal event 一次提交；否则刷新/UI 可能看到“已完成但结果尚不存在”。
- 不要把 tool call 已到达或 SDK 串行执行当作依赖传递。下游 tool input 可能在上游输出产生前已经冻结；必须从同 workflow 的 durable terminal row 编译实际 child prompt。
- 只改后面的兼容 `CREATE TABLE`、漏改文件开头 bootstrap schema，会让新库与旧库最终形状不同。
- 只靠 `ALTER TABLE ... DEFAULT` 不等于完成语义迁移；身份字段需要保守 backfill，无法证明时必须留空。
- 不要在 `initDb()` / route import 的隐式路径执行运行态清理。Next dev 会为不同 route/module 创建重复实例；把“模块第一次加载”误当“应用进程第一次启动”会中断仍在运行的聊天、删除 owner lock，并把权限请求伪装成 `Process restarted`。
- 不要假设改了 `migrateDb()` 后 dev 热更新会重新打开 SQLite。进程级 handle 会跨 HMR 保留；若不更新 schema revision，新 SQL 会先命中旧表并以 `no such column` 在 Provider 启动前失败。
- 用 URL first-match 回填同 host 的多个套餐会制造静默 cross-wire；必须先判断候选是否唯一。
- catalog 更新时直接重建 `provider_models` 会抹掉 manual/user-edited 状态；只能 reconcile catalog 管理行。
- tech-debt #7 — `claude-settings-credentials.test.ts` 和 `project-mcp-injection.test.ts` 的 DB-related test 在 CI 上 skip，本地通过；疑似 tsx + node 20 ESM module identity 去重在 linux 行为差异。
- 不要把 EBUSY/EIO 等瞬态错误按同 revision 永久拉黑，也不要只用行数限制在线 backfill；一个大视频仍可能让 Gallery 请求同步 hash 过久。deferred 不是成功，必须保留可恢复路径。
- 不要为了表示 claim 中间态给 `notification_deliveries.status` 新增值；lease owner/time 和 attempt columns 才是并发状态。
- 不要让新 durable consumer 直接领取旧内存队列留下的 `queued` 行；它们已失去当时的展示上下文，升级后重放会把数月前测试通知集中推给用户。用有时间边界的一次性 `skipped` 迁移保留审计，不要 DELETE。
- 不要先建 heartbeat unique index 再处理历史 duplicate；这会让旧用户启动时直接 migration 失败。
- 不要在 SQLite 已报 malformed 后继续跑 `journal_mode`、migration 或 runtime recovery，也不要把 `/api/health` 写成与 DB 无关的常量 200；这会让 Main 宣称 ready 后由任意业务 route 反复崩溃。
- 不要用 health catch-all 给 migration/runtime failure 统一加 corruption marker；这会虚构“完整性检查失败/已备份”，把健康数据引向新建空库。
- 不要只删除新路径 DB 后 relaunch；legacy-location migration 会把陈年旧库复制回来。必须先持久化 fresh-start intent，并在任何 legacy copy 之前消费。
- 不要把 durable fresh-start intent 当成永久删除授权；后来出现的 DB 可能是用户手工恢复。必须保留文件并要求明确选择。

## 测试覆盖

| 契约 | 测试文件 |
|------|----------|
| schema 加列、legacy backfill、幂等、ambiguous 保留 | `src/__tests__/unit/provider-preset-identity-migration.test.ts` |
| provider create/update 字段 roundtrip | `src/__tests__/unit/provider-key-lifecycle.test.ts`, `provider-preset-switch-route.test.ts` |
| DB-wins、hidden/manual/user-edited 保留 | `provider-resolver.test.ts`, `apply-discovery-diff.test.ts`, `align-enabled-with-catalog.test.ts` |
| 全量类型与单测门禁 | `npm run test` |
| additive `subagent_runs` / `subagent_run_events`、legacy backfill、logical attempt、workflow queued/dependency handoff/duplicate/cycle、active/completed reuse guard、parent FK/cascade、running checkpoint、settling/terminal immutable | `src/__tests__/unit/subagent-run-persistence.test.ts` |
| cached handle 在 dev schema revision 变化后重跑幂等 migration，且 live streaming row 不被 recovery 中断 | `src/__tests__/unit/subagent-run-persistence.test.ts` |
| `messages.stream_status` checkpoint、terminal 原位更新、live-owner 下重复 startup no-op | `src/__tests__/unit/collect-owner-gate.test.ts` |
| `asset_records.tags` additive column、legacy media tags 逐项保守回填、重复 migration 幂等、poison row 不阻塞后续行、transient 冷却重试与 byte/time budget | `src/__tests__/unit/asset-library-conformance.test.ts` |
| Heartbeat duplicate consolidation、partial UNIQUE、cadence/reconcile | `heartbeat-reconcile.test.ts`, `scheduler-trigger-unification.test.ts` |
| Notification additive claim、并发/stale/retry/terminal、legacy backlog 抑制 | `notification-delivery-claim.test.ts`, `notification-claim-policy.test.ts` |
| Provider secret 明文迁移、回滚冲突、per-row 启动容错 | `provider-secret-storage.test.ts` |
| readonly quick-check、malformed 原件保留、DB/WAL/SHM 完整备份、busy 重试、migration/runtime 分型、fresh-start 冲突选择/备份 tamper、共享 data dir 与有界 retention | `database-integrity-recovery.test.ts`, `electron-server-recovery.test.ts` |

## 设计决策日志

- 2026-07-21 — 首次激活 guardrail。为 Qwen personal/team 同 URL 身份新增 `preset_key` 时，规定显式 identity 为真源、legacy 只允许唯一匹配、团队旧 preset 仅按完整 catalog/role fingerprint 回填；不确定行保留空值等待用户确认。
- 2026-07-23 — 真实 Codex managed Sub-agent 会话证明 side-channel transcript 无法跨回合提供 run 事实，新增 additive `subagent_runs` 表。父 chat FK 是审计 owner；spawn 在调用 Provider 前必须先插入 running，终态 UPDATE 带 `terminal=0` 防迟到事件回退，删除父会话时级联清理。
- 2026-07-23 — renderer/dev 刷新暴露 assistant 只在流结束时落库会整条丢失。为 `messages` additive 增加 `stream_status`：旧行默认 completed；新流以同一行 streaming→terminal，startup 幂等回收为 interrupted，不删除任何历史内容。
- 2026-07-23 — `collect-owner-gate.test.ts` 被裸跑时漏带全局 `--import`，12 条 `collect-*` synthetic session 进入真实 Dev DB 并占满最近列表。精确删除这些测试行后，将 isolation setup 固化为该文件第一条 import；DB 测试隔离从“命令约定”提升为“单文件自带门禁”。
- 2026-07-23 — 真实会话 `ba4855b4c4d272afc85f3a70bbb5b5f4` 证明 Next route/module 的重复 `initDb()` 会在活进程内误执行 restart sweep：两秒内中断 checkpoint/permission、删除 session lock，最终 owner gate 只能拒绝正确终态。Schema 初始化现与 runtime recovery 分离；数据库句柄与 owner 状态按绝对 DB path 进程级共享，只有 owner 缺失或 PID 已死亡时才执行一次 recovery，live owner 下重复初始化不再触碰运行态。
- 2026-07-24 — Claude 长 child 不能等 terminal 才首次保存结果。新增不改 schema 的 `checkpointSubagentRun`：只更新 `terminal=0` 行的 bounded `result_text` / `effective_model`，不改 status/completed_at；第一次 terminal 后所有迟到 checkpoint 都是 no-op。
- 2026-07-24 — P0 可信编排把 physical run 拆为 logical run + attempt，并新增 typed lifecycle event 与 structured result。迁移只把每条旧行视为独立 logical attempt 1；新重试必须显式复用 logical id。terminal 前增加 settling 屏障，避免 UI/父模型在结果尚未 durable 时显示完成。
- 2026-07-24 — Claude P2 复核指出“显式 ID”仍可能被父模型误用。`startSubagentRun` 现于插入前检查同 session/logical 的最新 attempt：active/settling 返回 `LOGICAL_RUN_STILL_RUNNING`，completed 返回 `LOGICAL_RUN_ALREADY_COMPLETED`；两者均不写新 physical row，三 Runtime 在 Provider 启动前返回结构化拒绝。
- 2026-07-24 — 会话 `3f0085c5fc664deca85005d70b1abfca` 证明 SDK 串行工具执行不会重写已经生成的下游 tool input。新增 additive workflow/task/dependencies/dispatch state：accepted downstream 先 queued，应用只从同 session/workflow 的 durable completed result 编译实际 prompt；duplicate task key、self/indirect cycle 与失败依赖 fail closed。
- 2026-07-24 — 会话 `f7153c2b01e6a58b31e0406db9be56ec` 暴露 dev HMR schema 漂移：代码已写 `workflow_id`，但进程级缓存 DB handle 没有重新执行新增 migration，两次 child 都在 durable row 创建前报 `no such column: workflow_id`。`getDb()` 现用 code-owned schema revision 在 HMR 后重跑纯结构、幂等 migration；startup recovery 仍只在真正打开/取得进程 owner 时执行。
- 2026-07-31 — Asset 标签从 legacy `media_generations.tags` 提升为 `asset_records.tags`，覆盖 HTML 与所有已注册 kind。迁移只在新列默认空数组时复制可验证的 legacy JSON array；写入 Asset 标签时对 source media 双写，兼容旧消费者且不删除原字段。
- 2026-08-07 — 独立审查发现回滚/换机可形成“当前明文 + 旧密文”混合行，原迁移会信任旧密文并让任一失败穿透启动。合同改为当前明文优先、fresh envelope、per-row 保留失败数据并继续；数据密钥损坏/DEV owner 的产品级恢复另记 tech-debt #78。
- 2026-07-31 — Gallery 的 100 条/请求渐进 backfill 曾可能被同一坏行永久占住进度。新增 `asset_backfill_failures` 与 code-owned failure revision：坏行可审计、同 revision 跳过、后续行继续；修复迁移逻辑时 bump revision 才重试。schema revision 同步更新，HMR cached handle 会补建该表。
- 2026-07-31 — Backfill failure journal 增加 permanent/transient/deferred 语义。瞬态 I/O 错误冷却 30 秒后重试；Gallery 在线迁移限制 32 MiB 累计/单文件与 75ms 调度预算；超预算行先 deferred 让后续行继续，显式无界迁移仍可恢复它，不把预算判断变成永久数据结论。
- 2026-08-03 — Heartbeat system task 增加 exact-source partial UNIQUE index；历史 duplicate 先在事务中重关联 run/event 再合并。Notification delivery 使用 additive claim owner/time/attempt/backoff 字段，冻结现有 status CHECK，以 durable row 取代进程内 drain queue。
- 2026-08-03 — dev 实机首次启用 durable renderer consumer 后连续弹出历史 `Hi / There`。数据库证明不是 retry：137 条不同旧 event 长期停在 `renderer-toast/queued`。新增一次性事务迁移，把首次升级时超过 1 小时的 renderer/native backlog 标记为 `skipped`，保留 event/delivery 审计并保护当前运行中新通知。1 小时边界成立于版本上线顺序：升级时已有 queued renderer 行均由 pre-durable 版本产生；durable consumer 与该 migration 同版本首次出现，所以边界内行只可能来自当前升级运行或同分支 dev，必须保护而不能按 legacy 回放处理。
- 2026-08-23 — 生产 malformed 反馈暴露 `getDb()` 在任何完整性探测前直接进入 WAL/migration。现在既有库先执行一次 readonly `quick_check(1)`；失败缓存为 path-free startup block，保全 DB/WAL/SHM 并由 Electron 展示离线恢复页。默认不删除原件；“新建空库”必须由用户原生二次确认且重新验证完整备份后才执行。
- 2026-08-23 — implementation review 发现 health catch-all 会把 migration/runtime 产品故障伪装为 corruption，且 start-fresh relaunch 会被旧路径 DB migration 劫持。startup code/UI 现按 corruption/busy/migration/runtime 分型；busy 有界重试且不永久 block。完整备份后写入并 fsync fresh-start intent，下一次 bootstrap 在 legacy copy 前消费，空库成功打开后才清 marker。
- 2026-08-24 — 修复轮复核发现初始 DB 阻断会把 `serverPort` 清空，旧 retry 因而永远 no-op；现由 Main 在无端口分支重新执行稳定端口启动。migration/runtime catch 在替换为低基数 startup error 前先生成路径/凭据脱敏 diagnostic，Main 将其纳入本地日志与复制诊断。
- 2026-08-24 — fresh-start marker 不再授权 bootstrap 自动删除后来出现的 DB。marker 绑定已验证备份身份，冲突页由用户明确保留当前恢复或再次校验后继续空库；Main/utility/资产路径统一到共享 data-dir resolver，DB marker 快速失败，完整备份只保留最新 10 份。
- 2026-08-28 — `project-panel.spec.ts` 本地复用日常 dev server，三类 fixture 只删临时目录、不删 session，累计把 44 条 `codepilot-sidebar-*` 会话写入真实侧栏。已按标题+系统临时目录双证据精确删除 44 条（总会话 627→583，匹配残留 0），并另删 1 条目录已不存在的 `/tmp/codepilot-codex-image-smoke` 明确 smoke（583→582）；Playwright 改由单 owner 启动器创建临时 DB 与 `.next-e2e-*`，配置拒绝直接/复用启动，global setup 只初始化隔离库，fixture 仍在 `finally` 回收。
- 2026-08-28 — 用户将产品通知面统一为系统通知。schema 不增列，启动事务把仍 queued 的 `renderer-toast` 原位迁到 `electron-native`；若同 event 已有 native peer，只把冗余 renderer row 标记 skipped。历史 terminal delivery 全部保留，revision bump 保障 dev HMR 生效。

- 2026-09-21：`assistant-memory-migration.ts` 在 DB bootstrap migration lock 内、版本 marker 同事务一次性保留旧版已按配置目录识别的非 task 助理会话（包括字段出现前/手工创建）。只新增 settings binding，不改 session/message/provider 或 Runtime owner；marker 存在则 no-op，无配置也写 marker，避免以后把普通会话追认为助理。读路径禁止顺便写绑定。`memory-scope-entrypoints.test.ts` 覆盖启动 marker、幂等、新会话反例及 UI/上下文一致性。

- 2026-09-22：Bridge 创建 session/助理 binding/channel binding 在同一 DB 事务内；wizard 的 session/binding 也同事务（不承诺目录文件初始化一并回滚）。删除 session 同事务清理精确的 memory.assistant-binding.<id>。一次性迁移先 SQL 排除 task/已绑定/空目录并 DISTINCT working_directory，每个目录只做一次 canonical 检查，再批量回填；不使用字面路径粗筛丢失合法别名。
