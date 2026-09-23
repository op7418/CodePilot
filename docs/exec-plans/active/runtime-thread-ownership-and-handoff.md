# Runtime 会话所有权、交接与成本可见性（P0 / P1）

> 创建时间：2026-09-01
> 最后更新：2026-09-05
> 状态：🟡 9 月 5 日复审两项 P2 已修复并通过定向/全量/E2E（5485 pass / 1 skip，E2E 3/3）；原聊天切换已有 Dev smoke；本次历史图片真实视觉模型 smoke、独立复审及原计划其他长历史 smoke 仍未完成
> 风险等级：Tier 2（Runtime resolver / 会话续接 / Provider+Model route / DB schema / 计费展示）
> 事实基线：[T3 Code 最新版 Runtime 适配与会话切换分析](../../research/t3code-runtime-adaptation-and-switching-2026-09-01.md)
> UI 相邻计划：[Composer 模型路线、能力参数与权限入口收口](composer-model-route-permission-consolidation.md)
> 权限相邻计划：[跨 Runtime 权限模式](runtime-permission-modes.md)

## 一句话结论

一个聊天在第一次真实执行时选定 Runtime，此后 Composer 的 Runtime lane 置灰。同一 Runtime 内的兼容模型和服务商必须能在原聊天切换，保留 ID、历史和页面，由 adapter 处理底层续接。跨 Runtime 的 Handoff 后端保留，普通下拉不自动创建或跳转新聊天；未来只有独立、明确且带确认的入口可以调用。

## 用户问题与争议

### 2026-09-05 GPT-5.6 修复复审：两项 P2 已修复、Tests pass

用户授权后的修复已落地：仅 Codex fresh-thread 续接按预算分页补齐 DB 历史、保留预算内完整文本并恢复经过项目路径校验的历史附件；正常 resume 不重放，Claude fallback 行为保持原状。新增回归先 RED（7 fail / 2 pass），修复后 9/9；8 文件定向 82/82、全量 5485 pass / 1 skip、相关 E2E 3/3。以下 R1/R2 描述保留初次审查的触发条件，关闭证据为新增测试和修复代码，不是聊天确认。

- [x] R1：预算驱动历史分页与无固定字符截断，覆盖摘要边界和超预算反例。
- [x] R2：安全恢复历史图片，覆盖本轮图片、缺失/越界文件、无视觉能力和 resume 反例。
- [x] 定向/全量验证与 guardrail、交接回写。

- [审查记录与复现证据](../../research/gpt56-fixes-review-2026-09-05.md)：本轮复跑单测 5476 pass / 1 skip、相关 E2E 3/3，普通切换路径成立；以下边界未被昨晚短对话验证覆盖。
- R1 / P2：Codex 跨 Provider 重建底层 thread 时，300 条短消息仅传最近 199 条，即使总计约 4196 tokens、预算 100000；近期长消息也会在预算筛选前截断中间需求。需要按预算加载、保留必要历史并补长历史回归。
- R2 / P2：历史图片元数据被 fallback 清除，仅本轮 files 进入新 thread；两条历史即可复现旧图片内容与路径均缺失。需要恢复历史附件续接并补视觉输入回归。
- 两项初次审查均用隔离数据和生产输入构建函数确认；后续已获用户授权修改并补回归。未以真实视觉模型验证图片回答，也不将本次 Tests pass 升级为独立 Review passed。

### 2026-09-05 用户反馈修订：同 Runtime 必须能换模型

- Signal：真实 Dev 旧聊天由 Codex 账号 GPT 切到 DeepSeek，接口返回 `ROUTE_REQUIRES_HANDOFF`，界面仅提示保存失败。用户明确要求修复：不能换 Runtime 可预期，不能换模型不可接受。
- Triage：之前将 Codex 的“底层 thread 不能复用”误等同于“产品聊天必须另建”。本轮保留 Runtime owner，允许同 Runtime Provider+Model 原子切换，沿用同一聊天和数据库历史。
- Fix（完成）：Codex Provider 变化声明为 `replay_context`；新底层 thread 首轮使用已有摘要及已过滤压缩边界的最近历史，成功 resume 不重复注入。保留旧 ref 到新 thread 的首轮被接受后再替换，避免启动/发送失败后重试丢历史。普通 Picker 不跳转、不新建产品聊天。
- Triage / Fix 补充：目录模型尚未落库时，route 只查 DB 会误报 `INVALID_ROUTE_MODEL`，改为使用 execution resolver 的 DB + catalog 视图。实机切回 GPT 又发现路由模块空缓存误拒绝，显式模型选择改为有 2500ms 上限的发现，保留 recovery safe mode 约束。
- Verify（通过）：三 Runtime HTTP/UI 跨服务商正例与跨 Runtime 负例；完整单测 5475 pass / 1 既有 skip；最后强化用例定向 17/17；合跑 E2E 3/3。Dev 同一 8 月旧聊天完成 GPT → DeepSeek → GLM → DeepSeek → GPT，实际 DeepSeek 回复确认切换前历史；聊天总数与原消息不变。
- Guardrail（完成）：Runtime、Composer、handover 及本计划已同步；无 schema 变更、无发版。本轮不宣称原计划其他 smoke 全部完成。

以下 2026-09-01 的历史裁决中，Codex Provider 变化要求新产品聊天的部分由上述用户决定取代；跨 Runtime 的所有权约束继续有效。

当前产品允许在已有聊天中直接切换 Claude Code、CodePilot、Codex 三种 Runtime。这个设计有三个实际问题：

1. 三种 Runtime 续聊方式不同。Claude 会重新包装数据库历史，Native 会重放数据库消息，Codex 只会续自己的 thread。第一次中途切入另一个 Runtime 时，用户看到的是同一聊天，底层却可能只看到当前一句；切回去又可能回到旧分支。
2. Runtime、Provider、Model 目前由多次客户端更新完成。新聊天创建后再 PATCH Runtime，已有聊天切 Runtime 也由前端乐观写入；失败经常被吞掉。界面显示和真实执行路线可能不是同一个东西。
3. Runtime 一换，底层 session 和 prompt 前缀通常也会换，缓存很容易从头建立。用户很少使用这项能力，却要让所有会话路径长期承担分支、兼容和测试成本。

T3 Code 的可参考点不是“支持更多随意切换”，而是把边界说清楚：Driver/Adapter 保持稳定，线程是否能原地换模型由能力声明；不兼容的续接由前后端共同阻止。结合 CodePilot 当前实现，收益最大的路线是：

- P0 先消灭错误状态：第一次执行后锁定 Runtime；完整路线原子写入；服务端拒绝不合法变更。
- P1 再恢复合理灵活性：跨 Runtime 生成带交接包的新聊天；同 Runtime 变化按能力声明；把缓存、费用和压缩影响如实展示。

## 与已有计划的职责边界

| 计划 | 本计划负责 | 相邻计划继续负责 |
|------|------------|------------------|
| 本计划 | 会话 Runtime 所有权、路线变更服务端规则、跨 Runtime 新聊天、交接上下文、用量与压缩真实性 | — |
| [Composer 收口](composer-model-route-permission-consolidation.md) | 本计划只给出“能否操作 / 应触发哪种动作”的规则 | Picker 左右栏、收藏、搜索、能力菜单和 footer 布局 |
| [Runtime 权限](runtime-permission-modes.md) | Runtime 切换不得改变权限，交接目标继承明确的 canonical 权限档 | reviewer / bypass / Plan 的实际 wire 与降级 |
| [默认助理 / 心跳 / 系统通知](default-assistant-heartbeat-system-notification.md) | 本计划规定 auto-trigger 只可在已绑定会话执行，并提供自动会话的原子绑定合同 | 相邻计划决定助理 / task session 何时创建、继承哪条明确 route，以及如何展示 blocked 原因 |
| [同 Runtime 多模型 Sub-agent](same-runtime-multi-model-subagents.md) | 本计划守父聊天 Runtime owner，禁止 child 改写或触发父 route mutation | 相邻计划继续负责 child 的 exact Provider+Model route、durable lifecycle、权限和结果 |
| [历史 Phase 2](../completed/refactor-phase-2-runtime-session.md) | 本计划接管“开始后还能原地切 Runtime”的旧产品语义 | 历史实现与迁移背景仍作参考 |
| [历史 Phase 5](../completed/phase-5-codex-runtime.md) | 本计划接管 Codex 与其他 Runtime 之间的续接边界 | Codex transport、thread lifecycle 和工具桥保持原权威 |

本计划不重做统一 Picker，也不借 Runtime 所有权改权限语义。

## 目标与成功标准

### P0 必须达到

- 新聊天的 `runtime + provider instance + model` 在第一次发送前由服务端一次校验、一次持久化；不再“先创建、再 PATCH Runtime”。
- 第一次真实执行开始后，当前聊天只有一个 Runtime owner。清空消息、刷新页面、切换全局默认值都不能解锁。
- 已开始聊天的跨 Runtime 原地 PATCH 必须在任何写入前返回稳定的 `409 RUNTIME_OWNERSHIP_CONFLICT`；原 Runtime、Provider、Model 和各 Runtime session ref 全部不变。
- `codex_account` 的自动纠偏不能先写 Provider、再偷偷把 Runtime 改成 Codex。未开始聊天可以原子归一化；已开始且 owner 不是 Codex 时，只能引导新建交接聊天。
- `runtime_pin=''` 的老聊天不能继续跟随今天的全局默认值漂移。证据明确的保守绑定；证据不明确的显示一次选择，不在页面加载时静默改库。
- welcome、heartbeat、重试、队列和其他自动触发路径必须使用同一个 owner；普通 `unbound / legacy_unbound` 会话一律 fail closed。需要无人值守执行的助理 / task session 必须在创建时携带完整 route 并原子绑定，不能等 auto-trigger 到来后才读取全局默认值。

### P1 必须达到

- 跨 Runtime 操作创建新聊天，原聊天完全不变；新聊天能看到来源、边界和“底层会重新建会话 / 缓存”的清楚提示。
- Claude Code、CodePilot、Codex 都消费同一种交接上下文，不再让 Codex 首次切入只收到当前一句。
- 同 Runtime 模型 / Provider 变化只执行 Runtime 明确支持的模式；UI 不靠模型名字猜，服务端不可绕过。
- 每轮用量能区分未缓存输入、缓存读取、缓存写入、输出；来源不够时隐藏比例和金额，不补假 0。
- 现有自动压缩继续复用，但触发事实、覆盖边界、是否重建底层 session 和缓存影响可见；不把已有 80% 自动压缩重新包装成“新能力”。

### 不提前承诺的数字

本计划不写“缓存命中率提高 X%”或“费用下降 Y%”作为验收条件，因为仓库目前没有跨 Runtime 可比的统一用量事实。先补真实分桶，再用稳定会话与交接会话两个 cohort 看结果。可以提前承诺的是：

- 跨 Runtime 丢前文 / 回到旧分支这一类结构性错误应降为 0；
- 无意切 Runtime 导致的缓存重建应被直接消除；
- 用户主动交接仍会重建缓存，但会被明确告知并单独计量。

## 状态

| Phase | 优先级 | 内容 | 状态 | 用户能看到什么 |
|-------|--------|------|------|----------------|
| Phase 0 | P0 前置 | RED 合同、旧数据分类、三 Runtime 续接 POC | 🟡 合同/fixture 完成；真实协议 POC 与 baseline 待跑 | 暂无 UI 改变 |
| Phase 1 | P0 | 原子路线与 Runtime owner 服务端合同 | ✅ 已实现 | 错误切换不再写坏会话 |
| Phase 2 | P0 | Composer / 老会话恢复界面 | ✅ 已实现 | 已开始聊天显示固定 Runtime，左侧 Runtime lane 置灰；普通 Picker 不再跳转新聊天 |
| Phase 3 | P1 | 同 Runtime continuation capability | 🟡 原聊天切换及两项 P2 历史续接修复通过定向/全量/E2E；已有 Codex→DeepSeek Dev smoke；本次真实视觉与完整协议矩阵待跑 | 原聊天内切换兼容模型与服务商，Runtime 固定；预算内文本、可用历史图片承接 |
| Phase 4 | P1 | 跨 Runtime 新聊天与交接包 | 🟡 后端、交接包与目标卡片已实现；普通 Picker 入口按实机反馈关闭，显式确认 UX 待另行设计 | 新聊天带来源和可读交接卡片，但不会由普通 Runtime 下拉突然触发 |
| Phase 5 | P1 | 用量、缓存与成本真实性 | 🟡 已实现；真实收益样本待积累 | 看见真实缓存分桶；未知费用不显示 0 |
| Phase 6 | P1 | 压缩策略对齐与缓存影响提示 | 🟡 已实现；真实长线程 smoke 待跑 | 发生压缩、覆盖边界、底层 session 重建均可见 |
| Phase 7 | P0/P1 收口 | Tier 2 回归、真实 smoke、guardrail 与交接文档 | 🔄 进行中 | 自动化回归收口；真实 smoke 仍明确待跑 |

## 决策日志

- 2026-09-05：用户授权修复复审 R1/R2（工作区未提交，基线 `9bef7299`）。Codex replacement 从 caller rowid snapshot 懒分页，保留摘要边界和预算内文本；仅从 user 元数据恢复项目范围内历史附件，视觉能力不足保留引用并明确降级。RED 7 fail / 2 pass → 9/9，8 文件定向 82/82，全量 5485 pass / 1 skip，E2E 3/3；同步 Runtime guardrail 和 handover。首次全量暴露旧图片接线 source-pin 需随调用链更新，修正后定向通过；一次并发 E2E 清理与 tsc 临时类型文件冲突，改顺序执行后完整门禁通过。两项修复 Tests pass，不冒充真实视觉 smoke / 独立复审。

- 2026-09-01：采纳“聊天开始后 Runtime 单 owner”。原因：CodePilot 三条续聊路径没有共同的原地切换语义，保留当前能力的维护成本高于真实使用收益。
- 2026-09-01：跨 Runtime 不做透明迁移，统一创建新聊天。原因：复制 Claude/Codex 原生 session ref 既不可靠也会制造两份历史的所有权歧义。
- 2026-09-01：不新增第二个 `runtime_owner` 值字段。继续用 `chat_sessions.runtime_pin` 保存具体 Runtime，新增绑定状态 / 时间来区分“发送前偏好”和“执行后 owner”，避免两个 Runtime 字段互相漂移。
- 2026-09-01：`runtime_pin=''` 的已开始老聊天不再跟随全局默认值。证据不足时标为 `legacy_unbound`，由用户选择一次；不按当前全局设置、Provider 名或数组顺序猜。
- 2026-09-01：`codex_account` coherence 改成原子路线校验。未开始聊天可一次归一化到 Codex；已被其他 Runtime 绑定的聊天不能由服务端自己触发被禁止的切换。
- 2026-09-01：CodePilot 的权威字段命名使用 `continuationKey`；文档注明 T3 Web 侧对应概念名为 `continuationGroupKey`，不把两者混成 T3 唯一原名。
- 2026-09-01：同 Runtime 变化不用一个 boolean 粗暴表达，采用 `in_session / replay_context / new_session / unsupported` 四态。`replay_context` 必须明确说明底层 session 和缓存会重建。
- 2026-09-01：压缩不是新建一套。当前 `/api/chat` 已在估算达到 context window 80% 时自动压缩，并在 Claude 路径切换 fresh SDK session；P1 只补 Runtime policy、可见事实与回归。
- 2026-09-01：P2 暂不纳入首轮：不做 Effect / event-sourcing 重写、不移植 T3 transcript 增量扫描和全套 reactor settlement，也不复制 T3 shadow home。
- 2026-09-01 Review 修订：route CAS 使用新增的 `chat_sessions.route_revision`，只为 route / binding 写入递增；handoff 的 transcript 并发使用最新 eligible message rowid，不新增含义模糊的全 session revision。
- 2026-09-01 Review 修订：当前 `!runtime_pin && !autoTrigger` 不能机械删除。它要被统一 binding policy 取代：普通 unbound + auto-trigger fail closed；默认助理、heartbeat 和 task session 必须在创建时从明确来源得到完整 route 并直接绑定。
- 2026-09-01 Review 修订：managed Sub-agent 的 physical attempt 不算父聊天首次执行，也不调用父 session route mutation。父回合必须先绑定；child 只允许使用父 owner 对应 Runtime 内的 exact Provider+Model route，父 route 与 `route_revision` 保持不变。
- 2026-09-01 实现：自动会话 route 统一由 `resolveAutomaticSessionRoute()` 在创建边界冻结；后续 trigger 只消费 owner。Claude import 以 `legacy_runtime_ref` 绑定，worktree 从来源继承 owner。
- 2026-09-01 实现：handoff 首版选择可验证的 deterministic transcript window，不调用另一个模型生成“看似更完整”的摘要。payload 最多 16 条/约 18K 字符，明确记录 truncated 与 source boundary。
- 2026-09-01 实机反馈：普通 Runtime 下拉触发 handoff 后立即跳到新聊天，动作预期不成立。对齐 T3 Code 的 locked provider / continuation boundary：第一条真实执行被接受后 Runtime lane visibly disabled；普通 Picker 只保留 owner Runtime 内模型路线，不调用 handoff。Handoff API 保留，未来只能由独立、明确写明“在新聊天中继续”并带确认的入口调用。
- 2026-09-01 实机反馈：侧栏“新对话”仍从 localStorage 只提交 `model + provider_id`，在新 all-or-none route 合同下稳定得到 `400 INCOMPLETE_SESSION_ROUTE`。空会话入口统一为省略全部 route 字段并保持 `unbound`；只有掌握完整、已校验 identity 的入口才可同时提交 Runtime + Provider + Model。服务端原子校验不放宽。
- 2026-09-01 实机反馈：上述 `unbound` 空会话进入 `/chat/[id]` 后，第一条 Send 仍直接调用 `/api/chat`；该 API 只从持久化 session 读取 owner，因 route 尚未提交而正确返回 `409 RUNTIME_OWNER_REQUIRED`。修复把手动 Send 定义为首次 execution attempt：先以 `bind_for_execution` 在 route CAS 的同一事务写完整 route + `first_execution` owner，成功后才添加 optimistic bubble 和启动 stream；后台 auto-trigger 仍无权走该入口。
- 2026-09-01 实现：Native cache bucket 必须同时有 provider raw usage 证据；AI SDK 对缺失 Anthropic cache 字段合成的两个 0 视为 unknown。
- 2026-09-01 实现：Codex compaction 标为 `reactive_only/runtime_managed`，手动 `/compact` 不再用 CodePilot summary 冒充对 Codex thread 的主动压缩。
- 2026-09-01 Claude 独立审查：Review passed，无 P0/P1；发现 P2 多窗口 route CAS 输方丢弃权威 session、需刷新才能恢复。修复后 409 会采用完整 route/binding/owner/revision，保留草稿且不产生 optimistic 气泡，下一次发送即可继续；同时关闭 auto-correct 残留授权多写 revision，并统一 Runtime 用户显示名。针对性回归 128/128、`tsc --noEmit`、Harness boundary 和完整单测通过（5460 tests：5459 pass / 0 fail / 1 skip）；真实三 Runtime smoke 仍按 Ledger 待跑。

## 详细设计

### 1. ThreadExecutionBinding：一个聊天只有一个执行 owner

共享纯函数 / 服务建议命名为 `ThreadExecutionBinding`，它是服务端对下面事实的统一投影：

```ts
type RuntimeBindingState = 'unbound' | 'bound' | 'legacy_unbound';

interface ThreadExecutionBinding {
  sessionId: string;
  state: RuntimeBindingState;
  runtimeId?: RuntimeId;
  boundAt?: string;
  routeRevision: number;
  source?:
    | 'first_execution'
    | 'assistant_session_create'
    | 'inherited_owner'
    | 'handoff_create'
    | 'legacy_pin'
    | 'legacy_runtime_ref'
    | 'user_recovery';
}
```

DB 采用最小 additive 方案：

- 保留 `chat_sessions.runtime_pin`，其中非空值在 `bound` 状态下就是唯一 owner。
- 新增 `runtime_binding_state TEXT NOT NULL DEFAULT 'unbound'`。
- 新增可空 `runtime_bound_at`；老数据没有可证明时间时保持 NULL，不用迁移时间冒充。
- 新增 `route_revision INTEGER NOT NULL DEFAULT 0`，作为 route / binding 的专用 CAS 来源。
- 新增可空、低基数的 `runtime_binding_source`，保存 `first_execution / assistant_session_create / inherited_owner / handoff_create / legacy_pin / legacy_runtime_ref / user_recovery`；不把路径、账号、prompt 写进去。旧库没有可靠来源时保持 NULL。
- 新增列必须同时更新 bootstrap、on-touch migration、schema revision、类型与 CRUD，并在事务中幂等 backfill。

`route_revision` 的递增规则必须窄而稳定：

- 完整 route（Runtime / Provider instance / model）成功变化时递增一次；同一 transaction 改三个字段也只加一。
- `unbound → bound`、`legacy_unbound → bound` 或 binding source 发生真实变化时递增一次；若同一 transaction 同时绑定和规范化 route，仍只加一。
- no-op、校验失败、CAS 失败都不递增。
- title、mode、permission、working directory、消息追加 / checkpoint、runtime status、`sdk_session_id` / `codex_thread_id` 更新和 handoff 只读来源都不递增，避免无关写入制造 route 冲突。
- 新建 session（无论 `unbound` 还是以明确 route 直接 `bound`）和老库 migration 构造的初始事实都从 0 开始；首次 session GET / POST 响应把该值交给客户端。之后每次成功 route / binding mutation 返回新值。

route 写入使用单条条件更新或同等强度的 transaction：`WHERE id = ? AND route_revision = ?`。受影响行数为 0 时重读：session 不存在返回 404；revision 已变化返回稳定的 `409 ROUTE_REVISION_CONFLICT`，不得用 last-write-wins 覆盖另一窗口的选择。

普通用户聊天进入 `bound` 的边界是“第一次执行 attempt 已被服务端接受”，不是“已经拿到第一段 assistant 输出”。服务端必须在启动 Runtime 之前原子绑定；即使 Provider 随后报错，该聊天也保持 owner，用户可在同一 Runtime 重试。自动助理 / task 会话和用户显式创建的 handoff 目标是例外：它们在创建 transaction 中已经有明确完整 route，因此直接以 `bound` 创建，初始 `route_revision=0`，第一次 auto-trigger 只消费 owner，不再负责选 owner。

以下操作都不能解除绑定：

- `clear_messages`；
- 删除 / 更换底层 Claude SDK 或 Codex thread ref；
- 修改全局默认 Runtime；
- 页面加载时的前端 fallback；
- 普通重试、rewind、compact。

### 2. 老会话迁移规则

迁移先由纯函数分类，再在 SQLite transaction 内写入。不得读取消息正文做模糊语义推断，已知内部 Runtime switch marker 也不作为唯一 owner 证据。

| 老会话事实 | 迁移结果 | 理由 |
|------------|----------|------|
| 没有真实执行历史 | `unbound`；保留当前发送前选择 | 仍可在首发前改 Runtime |
| 已开始 + 有合法非空 `runtime_pin` | `bound` 到该 pin | 这是现有最明确的 session intent |
| 已开始 + 空 pin + 只有 `codex_thread_id` | `bound/codex_runtime` | 唯一 Runtime 原生 ref |
| 已开始 + 空 pin + 只有 `sdk_session_id` | `bound/claude_code` | 唯一 Runtime 原生 ref |
| 已开始 + 空 pin + 两种 ref 都有 | `legacy_unbound` | 历史上确实跨 Runtime，不能猜最后 owner |
| 已开始 + 空 pin + 没有可证明 ref | `legacy_unbound` | 可能是 Native，也可能是 ref 被旧逻辑清过 |

“已开始”使用服务端统一 evidence helper 判断，排除 `[__RUNTIME_SWITCH__ ...]` 这类内部 marker；不能因为 marker 当前解析 Codex 失败而把它当普通真实 prompt。迁移不删除 marker、不重写历史消息，只让新 UI 不再把它误渲染为用户说的话。

`legacy_unbound` 的页面行为：

- 展示“这个旧聊天无法可靠判断之前使用的 Runtime，请选择一次后继续”；
- 列出三种 Runtime 和会重建缓存的说明；
- 选择后以 `source='user_recovery'` 绑定；
- 在用户选择前阻止手动发送、auto-trigger 和后台继续执行；
- 不在页面加载、全局设置变化或 catalog refetch 时写库。

### 3. 路线写入必须原子化

路线 identity 是：

```text
runtimeId + providerInstanceId + modelId
```

新聊天 `POST /api/chat/sessions` 接受并一次校验 / 保存完整路线。`chat/page.tsx` 不再创建 session 后单独 PATCH Runtime，也不再吞掉 PATCH 失败后让第一次发送按全局默认值继续。

已有聊天使用一个服务端 route mutation，不再由前端先切 Runtime、再切 Provider/Model：

```ts
PATCH /api/chat/sessions/:id/route
{
  runtime_id,
  provider_instance_id,
  model_id,
  expected_route_revision
}
```

实现可复用现有 sessions PATCH handler，但语义上必须是一个 transaction、一个 `route_revision` CAS、一个响应。session GET / create / route mutation 都返回 `route_revision`；任何字段校验失败都不写半套路线。旧 sessions PATCH 接收到 route 字段时必须委托同一 helper 并要求 revision，或返回稳定迁移错误；不能保留一条无 CAS 的旁路。

服务端决策顺序固定为：

1. 读取 session + binding + 当前 route，核对 `expected_route_revision`；
2. 验证目标 route 在目标 Runtime 的 live catalog 中存在；
3. 若 `unbound`，允许原子更新完整路线；
4. 若 `legacy_unbound`，只接受显式 recovery bind；
5. 若 `bound` 且 Runtime 不同，返回 `409 RUNTIME_OWNERSHIP_CONFLICT`，附 `currentRuntimeId / requestedRuntimeId / canHandoff`；
6. 若 Runtime 相同，交给 Phase 3 continuation policy；
7. 通过后才持久化，最后才清理当前 Runtime 的 ref（仅 policy 明确要求时）。

客户端乐观状态只能在服务端成功后提交；失败恢复原 route 并展示可读错误。服务端错误码映射进中英文字典，不能直接显示内部 enum。并发首发也使用同一 binding CAS：只有一个请求能完成 `unbound → bound`，失败方重读 owner 后只能在同 Runtime 按正常 session lock / queue 规则继续，不能再次选择 Runtime。

### 4. `codex_account` coherence 重设

当前 PATCH 在收到 `provider_id='codex_account'` 但没带 Runtime 时会自动把 `runtime_pin` 改为 Codex。新规则：

- `unbound`：服务端可以把完整路线原子归一化为 `codex_runtime + codex_account + model`，一次返回 canonical route。
- `bound/codex_runtime`：按 Codex continuation policy 判断模型变化；不能无条件保留旧 thread。
- `bound/other runtime`：不写 Provider，不改 Runtime，不清任何 ref，返回 handoff action。
- `legacy_unbound`：要求用户先确认目标 Runtime；不能用选择 Codex Account 顺带完成静默迁移。

### 5. 自动触发、重试和后台执行

所有会产生 transcript、工具调用或费用的入口，在 resolve Provider 前都要读取同一个 `ThreadExecutionBinding`：

- 用户手动发送；
- 首轮 welcome / assistant trigger；
- heartbeat / scheduled continuation；
- retry / dequeue；
- Bridge / remote continuation；
- compact 触发的辅助模型调用。

这里不再保留“autoTrigger 特殊地运行、但不 pin”的第三种状态，也不能机械地把现有 `!autoTrigger` 条件删掉后让后台请求参与首次绑定。统一 helper 按触发来源做下面的唯一裁决：

| Binding / 触发 | 行为 |
|----------------|------|
| `bound` + manual / retry / auto-trigger | 使用持久化 owner；请求里的 Runtime 只能一致，不能读取当前全局默认值 |
| `legacy_unbound` + 任意触发 | fail closed；用户可见聊天要求 recovery 选择，后台任务记录可见 blocked 原因 |
| 普通 `unbound` + manual first execution | 目标完整 route 已由 session create / Picker 持久化时，用 `route_revision` CAS 原子绑定；没有明确 route 则拒绝 |
| 普通 `unbound` + auto-trigger | fail closed；welcome 不得替用户在运行时选择并占用 owner |
| 自动会话（默认助理 / heartbeat / task）创建 | 创建 transaction 必须同时写完整 route、`runtime_binding_state='bound'`、`runtime_bound_at` 和对应的 `assistant_session_create` / `inherited_owner` source；之后 auto-trigger 只消费 owner |

自动会话的 route 来源按优先级只能是：已绑定 origin session 的完整 route、用户明确配置的助理 route、或创建全新助理会话当时一次性解析并持久化的新聊天默认 route。最后一种只在“创建”这个边界使用全局默认；后续调度绝不重新解析。没有可用 route 时，相邻 heartbeat 计划负责展示 durable blocked 状态，不启动 Provider，也不静默吞掉 welcome / heartbeat。

如果产品仍希望在普通用户聊天第一次手动发送之前显示模型生成的 welcome，该 session 也必须走“自动会话创建并绑定”的显式合同；否则 welcome 延后到首次手动 execution 绑定之后。不能保留一个既未绑定、又已经产生模型 transcript / 费用的中间态。

### 6. Managed Sub-agent 不修改父聊天 route

managed child 的 physical attempt 属于父回合内部执行，不是父聊天的首次 execution，也不是 route mutation：

- 父 `/api/chat` 回合必须先完成 `ThreadExecutionBinding` CAS，模型才可能发出 child tool call；`unbound / legacy_unbound` 父会话不得直接启动 child。
- child 请求的 Runtime 必须等于父 owner。不同 Provider+Model 可以按 [同 Runtime 多模型 Sub-agent](same-runtime-multi-model-subagents.md) 的 exact catalog / entitlement / effective-route 合同执行，但不能借 child route 跨 Runtime。
- child route 写入自己的 `subagent_runs` / lifecycle；不得修改父 `chat_sessions.runtime_pin / provider_id / model / runtime refs / route_revision`，也不调用本计划的 session route mutation endpoint。
- child Provider+Model 与父 route 不同不触发 `replay_context` 或 handoff，因为 child 本来就是独立上下文；结果通过既有 durable child handoff 回到父回合。
- 若 Runtime 不同、父 binding 不明确或 route 不可达，必须在创建 durable child row / 调用 Provider 前结构化拒绝，不能用一次失败 child 顺带绑定父会话。

### 7. 同 Runtime continuation capability

不要把这组能力塞成前端自行判断的布尔值。建议建立服务端 `RuntimeContinuationPolicy`，Adapter / Driver 提供事实，UI 只消费结果：

```ts
type RouteChangeMode =
  | 'in_session'      // 保持底层 session/thread，Runtime 原生支持
  | 'replay_context'  // 留在同一聊天，但建立新底层 session，并重放 canonical context
  | 'new_session'     // 必须走 Phase 4 交接新聊天
  | 'unsupported';    // 不可执行

interface RuntimeContinuationPolicy {
  continuationKey: string;
  modelChange: RouteChangeMode;
  providerInstanceChange: RouteChangeMode;
  contextImport: 'canonical_handoff' | 'db_replay' | 'unsupported';
  source: 'adapter' | 'protocol_probe';
}
```

Phase 0 必须先用真实协议 / fixture POC 钉住三 Runtime，不能在计划里靠印象填最终矩阵：

- Claude Code：确认同一 SDK session 的模型变化能力；若只能清 `sdk_session_id` 后数据库重放，则是 `replay_context`，不是 `in_session`。
- CodePilot Runtime：确认 Provider / model 变化后的标准化历史重放、工具配对和 cache 语义；“技术上无原生 session”不自动等于无损切换。
- Codex：确认 `thread/resume + turn/start` 对模型变化的真实支持；Provider instance 改变是否必须新 thread；不得只因为每轮请求有 model 字段就宣布支持。

`continuationKey` 由服务端生成和比较。T3 Web 把类似 UI 分组字段叫 `continuationGroupKey`，但其服务端权威校验是 `continuationIdentity.continuationKey`；CodePilot 统一使用后者概念，避免实现时对错字段。

### 8. 跨 Runtime handoff：新聊天，不伪装原地续接

建议新增：

```text
POST /api/chat/sessions/:id/handoff
```

请求只带目标完整 route、可选用户补充说明、`expected_source_route_revision` 和 `expected_source_boundary_rowid`。两项并发来源分别是 session GET 返回的 `route_revision`，以及同一次 handoff preview 返回的最新 eligible message `_rowid`；不再使用没有 schema 来源的泛化 `expected_source_revision`。服务端 transaction：

1. 验证来源 binding 已 `bound`，且 session lock / runtime status 证明没有 in-flight stream；忙碌时返回 `409 SOURCE_SESSION_BUSY`；
2. 核对来源 `route_revision`；变化时返回 `409 SOURCE_ROUTE_ADVANCED`；
3. 重算最新 eligible message `_rowid` 并与 `expected_source_boundary_rowid` 比较；变化时返回 `409 SOURCE_TRANSCRIPT_ADVANCED`，让用户刷新 preview；
4. 验证目标 route；
5. 这是用户显式 handoff 操作，创建目标 session 时必须把目标完整 route、`runtime_binding_state='bound'`、`runtime_bound_at`、`source='handoff_create'` 原子写入，初始 `route_revision=0`；
6. 创建 handoff record，其 `source_boundary_rowid` 等于已核对游标；
7. 目标第一次执行只消费已持久化 owner，不重新读取全局默认值，也不再次递增 `route_revision`；
8. 返回目标 session id，前端导航；来源 session 不修改，因此来源 `route_revision` 也不递增。

建议新增 `chat_session_handoffs`，而不是把一大段交接内容塞进普通 user message：

| 字段 | 说明 |
|------|------|
| `id` | handoff identity |
| `source_session_id` / `target_session_id` | 两个聊天的真实关系；target unique |
| `source_boundary_rowid` | 交接覆盖到哪条真实消息 |
| `source_runtime_id` / `target_runtime_id` | 低基数 breadcrumb |
| `payload_version` | JSON 合同版本 |
| `payload_json` | 规范化交接内容，不含 secret |
| `payload_source` | `recent_transcript / generated_summary / user_edited` |
| `created_at` | 新记录真实时间 |

交接包至少包含：

- 来源聊天 id / 可点击入口；
- 来源、目标 Runtime 和路线；
- source boundary；
- 已确认决策、未完成事项；
- 当前 workspace / project / branch 的可证明 breadcrumb；
- 用户明确选中的文件 / 附件引用，且目标执行时再次验证仍有效；
- 内容是否为原文窗口、模型摘要或用户修改。

禁止内容：

- Claude `sdk_session_id`、Codex thread id 等原生续聊 ref；
- Provider key、OAuth token、绝对路径日志；
- 没有来源的“费用为 0”“全部上下文已迁移”等承诺；
- 把 handoff card 写成用户亲口说过的普通消息。

交接包通过共享 context compiler 的 `runtime_handoff` fragment 注入三 Runtime 第一次执行。Claude、Native、Codex 得到同一组事实，Adapter 只负责翻译 wire，不各自生成摘要。目标页面显示一张可折叠交接卡：“来自哪个聊天、覆盖到哪里、缓存会重新建立”。

生成交接摘要失败时不伪造成功：退回到有明确截断说明的最近 transcript window；若 transaction 尚未创建目标，则整体失败；若目标已创建，必须保持可恢复 draft，不留下看似可用却没有 handoff record 的孤儿聊天。

### 9. 用量、缓存和费用：先统一事实，再谈节省

当前 `messages.token_usage` 已有 `input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens / cost_usd`，但三 Runtime 来源和含义不统一，统计查询还会用 `COALESCE(..., 0)` 把未知费用聚成 0。

目标是给每一轮存一份版本化、带来源的 usage snapshot：

```ts
interface NormalizedTurnUsage {
  schemaVersion: 2;
  runtimeId: RuntimeId;
  providerInstanceId?: string;
  modelId?: string;
  source: 'runtime_reported' | 'provider_reported';
  uncachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costSource?: 'provider_reported' | 'versioned_price_snapshot';
  priceSnapshotId?: string;
}
```

规则：

- Adapter 在持久化边界归一化，UI 不再猜各 Provider 的分母。
- 估算值单独留在 context / compaction 事件，只能用于上下文容量提示，不能写进 v2 billing usage 冒充计费 token 或费用。
- 任一 bucket 不知道就省略；不能为了画图补 0。
- cache hit rate 只有在 `uncached + cacheRead` 的语义被该 Adapter 证明时才显示。
- “节省金额”只有真实 Provider cost 或带来源 / 生效时间的版本化价格快照才计算；否则显示 token 分桶和“费用未知”。
- 历史 v1 usage 保持可读，标为 legacy；不反向补 runtime / provider / cache bucket。
- 聚合报表要能分开“稳定 owner 会话”和“handoff 后新会话”，否则一次必然的缓存重建会把整体指标解释错。

为了评估收益，至少记录本地低基数事件：route mutation accepted/rejected、handoff created/failed、continuation mode、cache buckets、TTFT、terminal status。不得记录 prompt、消息正文、文件路径、账号或 token。若要扩展远程 telemetry，另行征得产品授权，不由本计划默认开启。

### 10. 压缩：对齐 Runtime 事实，不重复造能力

当前实现已经：

- 在 `/api/chat` 估算总上下文；
- 达到 context window 80% 时调用 `compressConversation()`；
- 保存 summary coverage rowid；
- Claude 自动压缩后清当前 SDK session，使用 fresh session + 保留消息继续；
- 有 circuit breaker、手动 `/compact` 和 context-too-long reactive retry。

P1 只补这些缺口：

- `RuntimeCompactionPolicy = proactive | reactive_only | unsupported`，由 Adapter 说明；
- context window 和已用量继续采用真实 source breadcrumb，未知时不显示百分比；
- 70%（具体预警值须经 POC 后确定）只做提前提示，80% 沿用现状直到数据证明要调整；计划中不先拍新阈值；
- 压缩事件持久化 source boundary、压缩消息数、估算节省 token、辅助模型 route 和是否重建底层 session；
- 用户看到“即将压缩 / 已压缩 / 底层会话已重建，缓存可能重新建立”，而不是只看到一次无解释的延迟；
- manual compact、auto compact、reactive compact 共享同一事件合同和回归测试；
- 交接摘要与长线程压缩摘要复用规范化片段，但不能混用覆盖边界或把交接目标写回来源 summary。

## 分阶段执行清单

### Phase 0：RED 合同、迁移盘点与 Runtime POC

#### 用户结果 / 验收入口 / 明确不做

- 用户结果：没有产品行为变化；先把“什么会被允许、什么必须拒绝”写成失败测试和真实协议记录。
- 验收入口：unit contract、临时隔离 DB migration fixture、三 Runtime 两轮 / 换模型 POC 记录。
- 明确不做：不改现有 Picker，不启用服务端拒绝，不迁移真实用户库，不宣称任一 Runtime 已支持原地换模型。

#### 执行清单

- [x] 建 `ThreadExecutionBinding` 分类表测试，覆盖空 pin、单 ref、双 ref、内部 marker、清空消息与失败首轮。
- [x] 建 route mutation RED 测试：跨 Runtime 409 且零写入；完整 route 原子提交；stale `route_revision` 拒绝；真实 route / binding 变化只递增一次，no-op 与无关 session 写入不递增。
- [x] 建 `codex_account` 正反例：unbound 原子归一化、bound-other 零写入。
- [x] 建 trigger / binding 表驱动 RED 测试：普通 unbound + manual 可 CAS 绑定；普通 unbound / legacy-unbound + auto fail closed；助理 / heartbeat / task session 只有在创建时原子带 route 并绑定后才可 auto-trigger。
- [x] 建 managed child RED 测试：同 Runtime 不同 Provider+Model 不改父 route / ref / `route_revision`；跨 Runtime child、unbound 父会话在 durable child row 和 Provider 调用前拒绝。
- [x] 建 handoff 并发 RED 测试：source busy、stale source `route_revision`、stale eligible message rowid 分别返回稳定 409，且不创建目标 session / handoff record。
- [ ] 对 Claude / Native / Codex 各跑同 Runtime model / provider change POC，记录真实 wire、底层 ref 和上下文结果。
- [ ] 记录当前稳定 owner 会话的 usage / cache baseline，不输出 prompt、路径或凭据。
- [x] 盘点并收口 `runtime_pin` 写入口与 auto-trigger；生产路径不再调用 legacy `updateSessionRuntime()`，自动会话在创建边界绑定。

### Phase 1：P0 原子 route + Runtime owner 服务端合同

#### 用户结果 / 验收入口 / 明确不做

- 用户结果：聊天不会再因为一次失败的 PATCH 或后台默认值漂移到另一个 Runtime；非法切换不会写坏数据。
- 验收入口：新聊天首次发送、已有聊天 route PATCH、`codex_account` 选择、空 pin migration fixture。
- 明确不做：本阶段不交付跨 Runtime 新聊天摘要，不计算缓存节省金额，不改权限档。

#### 执行清单

- [x] additive schema 增加 `runtime_binding_state / runtime_bound_at / runtime_binding_source / route_revision` + 幂等 backfill + schema revision；数量、消息、runtime refs 全部保留。
- [x] 新 session POST 原子接受完整 route，删除“创建后 PATCH Runtime”的必需性。
- [x] 首次 execution transaction 写 owner；Provider 启动失败也保持 owner。
- [x] route mutation 统一校验 / `route_revision` CAS / transaction；客户端不能分两次写 route；GET / POST / mutation 都返回当前 revision。
- [x] 跨 Runtime 返回稳定 409；在任何 session ref 清理、Provider 更新、marker 写入之前拒绝。
- [x] 重设 `codex_account` coherence，不允许服务端自己触发被自己禁止的切换。
- [x] auto-trigger / retry / queue / Bridge 全部读取 binding；普通 unbound / legacy-unbound 的 auto-trigger fail closed；助理 / heartbeat / task session 由创建方原子携带完整 route 并直接绑定，调度时不再读全局默认。
- [x] managed child 只能在已绑定父回合中使用父 owner 对应 Runtime；同 Runtime exact child route 只写 child lifecycle，父 route / refs / `route_revision` 不变；跨 Runtime child 在持久化和 Provider 调用前拒绝。
- [x] 更新 `Runtime.md`、`DatabaseSchema.md`、`StreamSession.md` 的新不变量。

### Phase 2：P0 Composer 与 legacy recovery UI

#### 用户结果 / 验收入口 / 明确不做

- 用户结果：已开始聊天明确显示当前 Runtime，左侧 Runtime lane 直接置灰；普通模型下拉不会突然创建并跳转新聊天。无法判断 owner 的老聊天只需确认一次。
- 验收入口：`/chat` 首发前 Picker、`/chat/[id]` 已开始聊天 Picker、legacy recovery banner / dialog。
- 明确不做：不重画 Composer 信息架构，不新增第二个 RuntimeSelector，不改变 Favorites identity。

#### 执行清单

- [x] 在统一 Picker 消费服务端 binding / route action，不在前端复制 resolver。
- [x] unbound：Runtime lane 正常可选；bound 或第一条执行已被接受但页面尚未重新加载 binding：Runtime lane visibly disabled，callback 再次 fail closed；普通 Picker 不触发 handoff。
- [x] P0 server guard、legacy recovery 与 Phase 4 handoff 同一实现切片交付，不只上线 409。
- [x] legacy-unbound 选择一次并显示缓存重建提醒；取消后保持只读，不偷用全局默认。
- [x] 移除新产生的 Runtime switch marker；历史 marker 兼容解析并从普通用户气泡分流。
- [x] 中英文字典同步，错误码映射为人类文案。
- [x] 更新 `ComposerModelSelection.md`；保留相邻计划对布局 / 收藏 / 搜索的所有权。

### Phase 3：P1 同 Runtime continuation capability

#### 用户结果 / 验收入口 / 明确不做

- 用户结果：同一 Runtime 下，能安全换的模型可直接换；需要重放上下文的会明确提示；不支持的选项不会点完才坏。
- 验收入口：已开始聊天右侧 Provider+Model route、收藏快捷项、服务端直接 API 负例。
- 明确不做：不按品牌 / 模型名猜能力，不把 catalog compatibility 当成账号 entitlement，不放宽权限。

#### 执行清单

- [x] 落 `RuntimeContinuationPolicy` 与 `continuationKey`，shipping matrix 由当前 adapter/protocol fixture 固定；真实协议 smoke 仍待补。
- [x] 复审 R1/R2：Codex replacement 按预算向前加载历史、保留完整文本，并恢复安全历史图片；新增 `codex-continuation-context.test.ts` 覆盖正常/反例。
- [x] `in_session` 保留当前 Runtime ref；Claude `replay_context` 清 SDK ref，Codex `replay_context` 保留旧 ref 到带当前历史的 replacement 首轮接受后再替换；其他 Runtime refs 不再有“回切恢复旧分支”的执行意义。
- [x] `new_session` 导向 Phase 4 handoff；`unsupported` 前后端都拒绝。
- [x] Picker action / warning reason 来自服务端 policy，不由收藏 snapshot 抬升。
- [ ] 覆盖 provider 删除、entitlement 失败、stale capability cache 和真实 Runtime report mismatch。

### Phase 4：P1 跨 Runtime handoff 新聊天

#### 用户结果 / 验收入口 / 明确不做

- 用户结果：Handoff 技术能力创建的新聊天能显示来源、交接范围和缓存重建提醒，原聊天可完整返回；但普通 Runtime Picker 不再暴露该动作，避免无预警跳转。
- 验收入口：handoff API / 未来独立确认入口、目标聊天 handoff card、来源返回链接。当前普通 Picker 验收为 Runtime lane disabled 且不会创建新聊天。
- 明确不做：不复制原生 session ref，不把新聊天伪装成旧 thread 的无损迁移，不自动复制全部附件。

#### 执行清单

- [x] `chat_session_handoffs` bootstrap / migration / CRUD / transaction / FK / cascade。
- [x] handoff API 校验目标 route、来源 idle、`expected_source_route_revision` 与 `expected_source_boundary_rowid`；任一来源事实前进都 409；重复提交具备幂等 key。
- [x] handoff 目标在创建 transaction 中以明确 route 直接 `bound`（`source='handoff_create'`、初始 `route_revision=0`），首次执行只消费 owner。
- [x] 建版本化 payload normalizer 和 `runtime_handoff` context fragment。
- [x] 三 Runtime 首轮消费同一 handoff fixture；特别验证 Codex input 不再只有当前 prompt。
- [x] 目标显示 handoff card 与来源 link；首版直接采用有边界/截断说明的 deterministic transcript fallback。
- [ ] 并发源消息、目标创建失败、导航失败、刷新和删除来源 session 的恢复语义写成测试。

### Phase 5：P1 用量、缓存与费用真实性

#### 用户结果 / 验收入口 / 明确不做

- 用户结果：用户能看懂“这轮有多少输入来自缓存、多少重新计算”；费用拿不到时显示未知，不显示假 0。
- 验收入口：消息 token usage、Usage 统计页、handoff 前后对比。
- 明确不做：不根据公开价猜用户套餐折扣，不默认新增远程行为采集，不反向伪造历史数据。

#### 执行清单

- [x] 定义 v2 normalized usage schema 与 Runtime adapter normalizer。
- [x] 修正聚合 SQL / API 对 missing cost 和 bucket 的语义，不再用 COALESCE 让 unknown 看起来是 0。
- [x] UI 只在 denominator contract 成立时显示 cache rate，只在 cost source 成立时显示金额 / 节省。
- [x] 历史 v1 数据保守读取并标 legacy；非法结构继续整项隐藏。
- [ ] 本地 cohort 区分 stable owner / replay_context / handoff，记录 TTFT、cache buckets 与 terminal status。
- [ ] 输出首轮真实收益对比；样本不足就写样本数和边界，不外推百分比。

### Phase 6：P1 压缩策略与缓存影响提示

#### 用户结果 / 验收入口 / 明确不做

- 用户结果：长聊天接近上限时提前知道；压缩发生后知道覆盖了哪段、是否重建底层 session，以及为什么下一轮缓存可能变低。
- 验收入口：Run Cockpit / 上下文状态、auto compact 事件、手动 `/compact`、context-too-long retry。
- 明确不做：不删除现有 circuit breaker，不先改 80% 阈值，不把 estimated tokens 当账单。

#### 执行清单

- [x] 建 Runtime compaction policy；不能 proactive 的 Runtime 保持 reactive / unsupported 并诚实展示。
- [x] manual / auto / reactive 三入口统一事件与 source boundary。
- [ ] 预警阈值先 POC，80% 执行阈值保持现状，除非数据与真实 smoke 支持调整。
- [x] 记录并展示 `recreatedUnderlyingSession`；与 Phase 5 cache cohort 对齐。
- [x] handoff summary 与 compact summary 使用不同 boundary / purpose，防止相互覆盖。

### Phase 7：Tier 2 验证、Guardrail 与交接

#### 用户结果 / 验收入口 / 明确不做

- 用户结果：三 Runtime 的正常续聊、模型变更、跨 Runtime 交接和长聊天压缩均有真实证据；发布说明不会把单测冒充真实 Runtime 成功。
- 验收入口：下方 Smoke Ledger、完整测试、真实账号 / API key smoke、文档索引。
- 明确不做：未跑的平台 / Provider 不标通过；P2 reliability work 不借收口混入。

#### 执行清单

- [x] targeted unit / migration / route / usage / compaction 合同通过。
- [ ] P0/P1 scoped UI E2E 与三 Runtime 真实 smoke 通过。
- [x] `npm run test` 与隔离 DB smoke 通过。
- [ ] production build 通过；2026-09-01 因真实 `next dev` 持有 `.next/dev/lock` 被安全门禁拒绝，未停止用户进程或绕过门禁。
- [ ] 按 Smoke Ledger 跑三 Runtime、至少一个 same-runtime route change、一个自动会话绑定和一个 managed child；记录真实 Result / Evidence。
- [x] route CAS 并发输方采用服务端权威 session 快照，完整同步 route/binding/owner/revision；保留草稿、零 optimistic 消息，并补防回归测试。
- [x] 更新 `Runtime.md`、`ComposerModelSelection.md`、`DatabaseSchema.md`、`StreamSession.md`、`i18n.md`（如合同变化）及对应索引。
- [x] 新增 handover 与 product insight；把旧“允许原地跨 Runtime”历史语义标为被本计划取代，不改写历史记录。
- [x] Claude 独立审查 Review passed；唯一 P2 按 Signal → Triage → Fix → Verify → Guardrail 闭环，后续只保留真实 Runtime smoke 门禁。

## 测试矩阵

### 新增 / 重构测试建议

| 测试 | 重点 |
|------|------|
| `thread-execution-binding.test.ts` | 三态、legacy backfill、clear_messages 不解锁、失败首轮仍绑定、普通 unbound auto fail closed、自动会话创建时绑定 |
| `runtime-route-mutation.test.ts` | route 原子性、`route_revision` CAS / 精确递增 / no-op、跨 Runtime 409 零写入、codex_account coherence |
| `runtime-continuation-capability.test.ts` | 四种 mode、continuationKey、客户端不可绕过 |
| `runtime-handoff.test.ts` | source idle、route revision、eligible rowid boundary、target 创建即绑定、payload、幂等、失败回滚、三 Runtime fragment 同形 |
| `subagent-orchestration.test.ts` / `subagent-run-persistence.test.ts` | 同 Runtime child 可用精确 Provider+Model 且父 route / refs / revision 不变；跨 Runtime child 与 unbound 父会话在 durable row / Provider 前拒绝 |
| `runtime-usage-normalization.test.ts` | missing bucket、来源、legacy、unknown cost 不变 0 |
| `runtime-compaction-policy.test.ts` | 80% 现状、三入口同事件、fresh session 与 boundary |

### 必须保留 / 扩展的既有测试

- `session-runtime-immunity.test.ts`
- `runtime-session-store.test.ts`
- `codex-virtual-provider-coherence.test.ts`
- `codex-phase-6-wiring.test.ts`
- `chat-runtime.test.ts`
- `provider-resolver.test.ts`
- `token-usage-display.test.ts`
- `message-persistence.test.ts`
- Composer scoped Playwright / `project-panel.spec.ts`

### 核心负例

- bound Claude → 带当前 `route_revision` 直接 PATCH Codex：409，route / refs / messages / `route_revision` 不变。
- 两个窗口先后提交同一旧 `route_revision`：第二个返回 `409 ROUTE_REVISION_CONFLICT`，不覆盖第一窗口；no-op 和消息追加不制造假 route 冲突。
- bound Native → 选择 `codex_account`：服务端不能先写 Provider 再自动改 Runtime。
- legacy empty pin + 双 ref：不猜 owner，不 auto-trigger。
- 普通 unbound + auto-trigger：Provider 调用前拒绝；助理 / heartbeat / task session 未能在创建时解析明确 route 时记录 durable blocked，不临时读取全局默认。
- 已绑定父会话发起同 Runtime、不同 Provider+Model child：child 可执行，但父 route / refs / `route_revision` 零变化；跨 Runtime child 或 unbound 父会话在 child row / Provider 调用前拒绝。
- history 只有 Codex switch marker：marker 不作为用户真实 prompt，也不单独证明 owner。
- handoff preview 后来源开始新 stream、route 变化或新增 eligible message：分别返回稳定 409，目标 session 与 handoff record 都不创建。
- handoff summary 失败：目标不出现“已完整迁移”；fallback 明确截断。
- Runtime 没回 usage：UI 不显示 `0 tokens / $0 / 0% cache`。
- compaction estimate 有值但 billing usage 无值：只能用于容量提示，不能进入费用图。

## Rollout 与回滚

P0 作为一个可发布切片：binding migration、server guard、legacy recovery UI 必须一起上线。不能先发布 409 再等下个版本补界面。

推荐顺序：

1. 先合 RED tests + 幂等 migration helper，不启用行为变化；
2. 合 server policy 与 UI，但由同一 release gate 控制；
3. 用隔离旧库 fixture 和 dev 数据副本跑分类报告，只输出计数；
4. 完成 P0 Smoke Ledger 后启用；
5. P1 handoff、usage、compaction 可分别发布，但每一项都必须保持 P0 owner 规则。

回滚时允许暂时隐藏 handoff / capability UI，但不能把 bound 会话恢复成可原地跨 Runtime。新增 schema 是 additive，回滚版本必须忽略未知列 / 表，不能删除用户数据。

## 明确不做

- 不保留隐藏的“强制原地切 Runtime”开关。
- 不把跨 Runtime 交接自动描述成“无损”“完整保留缓存”。
- 不复制 Claude / Codex 原生 session ref 到目标聊天。
- 不按 Provider 品牌、模型名或当前全局默认值猜 continuation 能力 / owner。
- 不在本计划修改 Plan / reviewer / full access 的权限语义。
- 不做 T3 的 Effect / reactor / event-sourcing 全量重写。
- 不做 transcript 增量扫描、全套事件泄漏治理或 shadow home 复制。
- 不为了计算节省金额抓取用户未知套餐价格或补假定折扣。

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

> 所有行默认待跑。只有真实 Runtime / Provider 终态和可复核 session / event / screenshot 才能改为通过；单测不得填进 Result 冒充真实 smoke。Evidence 禁止包含 key、token、prompt 正文和未脱敏绝对路径。

### 自动化验证记录（不冒充真实 Runtime smoke）

| Date | 命令 | 结果 | 说明 |
|------|------|------|------|
| 2026-09-05 | R1/R2 RED → 定向 + `npm run test` | ✅ Tests pass | 新增回归修复前 7 fail / 2 pass，修复后 9/9；8 文件定向 82/82；最终 typecheck / Harness boundary / 单测 5485 pass / 0 fail / 1 skip；Windows junction fixture 和路径断言调整后额外 9/9 |
| 2026-09-05 | `test:e2e -- old-chat-model-route.spec.ts model-identity-conflict.spec.ts --workers=1 --reporter=line` | ✅ 3/3 | 修复后隔离服务回归，原聊天 route/URL/消息保持，GLM 冲突定位正常；不含真实视觉模型调用 |
| 2026-09-05 | ESLint + docs-drift + diff check | ✅ 通过 | 产品及测试改动无 ESLint error；claude-client 保留 3 个既有 unused warning；索引/空白检查通过 |
| 2026-09-05 | `npm run test` + 最后强化断言定向回归 | ✅ 通过 | 完整 5475 pass / 0 fail / 1 既有 skip，typecheck / Harness boundary 通过；最后启动失败用例与断言强化定向 17/17 |
| 2026-09-05 | `test:e2e -- old-chat-model-route.spec.ts model-identity-conflict.spec.ts --workers=1` | ✅ 3/3 | 隔离 DB；三 Runtime 原聊天跨 Provider 切模型、未落库 catalog、ID/URL/消息/数量保持及跨 Runtime 409；含前一项 GLM 身份冲突回归 |
| 2026-09-05 | 修改源文件 ESLint + `lint:hooks` + `lint:docs-drift` + `git diff --check` | ✅ 无 error | ESLint 仅 `claude-client.ts` 3 个既有 unused warning；hooks、索引及空白检查通过 |
| 2026-09-01 | `npm run test` | ✅ 通过 | typecheck + Harness boundary + unit：5455 tests，5454 pass，0 fail，1 个既有 skip |
| 2026-09-01 | owner / handoff / usage / compaction targeted tests | ✅ 通过 | 15/15；使用临时隔离 DB，覆盖 CAS、零写入、幂等、unknown cost/cache 与 compaction transaction |
| 2026-09-01 | Runtime lane lock targeted regression | ✅ 通过 | 112/112；覆盖 bound / first-message reload window、disabled UI、callback fail-closed、普通 Picker 不再调用 handoff / surprise navigation |
| 2026-09-01 | 侧栏空会话创建回归 + dev API | ✅ 通过 | typecheck 通过、定向 4/4；真实 dev `POST /api/chat/sessions` 只带目录返回 201，session 为 `unbound`；验证临时 session 已删除 |
| 2026-09-01 | 侧栏首条 Send route+owner 回归 + dev API | ✅ 通过 | 定向 12/12；真实临时会话 `POST sessions` 201 → `PATCH route` 200（完整 route、`bound/first_execution`、revision 1）→ 无模型调用的短 `/compact` `POST /api/chat` 200；临时 session 已删除 |
| 2026-09-01 | `npm run test`（本轮修复后受限沙箱复跑） | ⚠️ 环境阻塞 | 5456 tests 中 5448 pass、7 fail、1 skip；7 个失败均为 telemetry / xAI OAuth fixture 尝试监听 127.0.0.1 时 `EPERM`，定向测试与 typecheck 无失败 |
| 2026-09-01 | 本次变更源文件 ESLint + `lint:hooks` + `lint:docs-drift` | ✅ 无 error | ESLint 0 error、32 个存量/非阻塞 warning；hooks 与 docs index 均通过 |
| 2026-09-01 | `npm run test:smoke` | ⚠️ 19 pass / 3 fail / 1 skip | Codex capability 在 `CODEX_DISABLED=1` 隔离环境不可用；new-chat fixture 无 working directory 未进入 submit；workspace context-menu locator 并行超时。该 smoke 集没有 P0/P1 handoff scoped case，不能据此标真实 Runtime 通过 |
| 2026-09-01 | `npm run build` | ⏸ 未执行 | prebuild 检测到 PID 6712 持有 `.next/dev/lock`；为保护活动开发服务未停止进程、未删 lock、未绕过安全脚本 |

| Date | Source Runtime | Target / Route | 凭据形态 | 场景 | 期望 | Result | Evidence |
|------|----------------|----------------|----------|------|------|--------|----------|
| 待跑 | Claude Code | Codex | 真实登录态 | 独立 handoff 确认入口恢复后执行 | 新聊天 + handoff；来源零修改 | ⏸ | 普通 Picker 已锁定；显式 UX 待设计 |
| 待跑 | Codex | CodePilot | 真实登录态 + API key | 独立 handoff 确认入口恢复后执行 | 新聊天首轮收到同一 handoff facts | ⏸ | 普通 Picker 已锁定；显式 UX 待设计 |
| 待跑 | CodePilot | Claude Code | API key / CLI | 独立 handoff 确认入口恢复后执行 | 新聊天 + 缓存重建提示 | ⏸ | 普通 Picker 已锁定；显式 UX 待设计 |
| 待跑 | Claude Code | 同 Runtime 新模型 | 真实 Provider | capability POC / 真实切换 | 与 shipping mode 一致 | ⏳ | — |
| 2026-09-05 | Codex | GPT / DeepSeek / GLM 同 Runtime 切换 | 真实账号 + 已配置 API key | Dev 旧聊天 UI 切换；DeepSeek 实际续聊 | 原聊天保存且保留历史 | ✅ 本轮通过 | session `285fad544f7009c7e373d37441d62b4b`，route revision 2→6，总聊天数 587 不变，9 条原消息保留；追加 smoke 一问一答，proxy/chat 200；详见旧聊天诊断记录 |
| 待跑 | CodePilot | 同 Runtime 新模型 / Provider | API key | DB replay + 工具历史 | 上下文与 tool pair 完整 | ⏳ | — |
| 待跑 | Legacy | empty pin + 单 / 双 ref | 隔离旧库 fixture | 迁移与恢复 | 唯一证据绑定；歧义要求用户选择 | ⏳ | — |
| 待跑 | 任意 bound | 另一 Runtime API PATCH | 隔离 DB | 绕过 UI | 409 且所有事实零写入 | ⏳ | — |
| 待跑 | 默认助理 / heartbeat | 创建时明确 route | 真实登录态或 API key | 自动会话创建后触发 | 创建 transaction 已绑定；后续 trigger 只用 owner | ⏳ | — |
| 待跑 | 任意 bound 父会话 | 同 Runtime 不同 Provider+Model child | 真实 Provider | managed child 执行 | child 使用精确 route；父 route / refs / revision 不变 | ⏳ | — |
| 待跑 | 任意 bound 父会话 | 另一 Runtime child | 隔离 DB + Provider spy | managed child 绕过尝试 | durable child row / Provider 调用前拒绝 | ⏳ | — |
| 待跑 | 三 Runtime | stable vs handoff | 真实凭据 | 两轮相同前缀 | usage 分桶可比，unknown 不补 0 | ⏳ | — |
| 待跑 | 三 Runtime | compact | 真实凭据 | 接近窗口 / 手动 / reactive | boundary、session 重建、cache 影响可见 | ⏳ | — |

## 完成条件

只有同时满足以下条件，计划才能从 active 移到 completed：

- P0 owner / migration / atomic route / UI recovery 全部完成并通过真实 smoke；`route_revision` 有精确递增和并发冲突证据；
- 普通 unbound auto-trigger 已 fail closed，自动助理 / heartbeat / task session 的 route 在创建时原子绑定且有 blocked 负例；
- managed child 同 Runtime 不改父 route / refs / revision，跨 Runtime 与未绑定父会话均在持久化 / Provider 前拒绝；
- P1 handoff 三个目标 Runtime 至少各一条真实成功路径；
- same-runtime capability 矩阵每个 shipping `in_session` / `replay_context` 声明都有协议或真实 smoke 证据；
- usage 不再把未知 cost / cache bucket 渲染为 0，首轮 cohort 报告已登记样本边界；
- compaction 沿用能力已完成三 Runtime 事实对齐，没有重复实现；
- 所有 guardrail、handover、insight 和索引同步；
- Claude Code Review passed，Codex review 的 P1/P2 finding 已修复、测试证明或登记 tech-debt。
