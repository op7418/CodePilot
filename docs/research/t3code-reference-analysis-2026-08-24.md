# T3 Code 对 CodePilot 的可借鉴能力分析

> 调研日期：2026-08-24<br>
> T3 Code 来源：<https://github.com/pingdotgg/t3code><br>
> T3 Code 基线：`643daa51616d0bfcd4c8235ae6966a68f106dcfe`（`fix(web): prevent expanded tool calls from hiding thread content (#8052)`）<br>
> CodePilot 基线：`f9da69f2a74946acf0b0a7583840f6575559499d`（`docs: record production hardening commit`）<br>
> 方法：源码、挂载 / 调用关系与仓库文档对照；未安装 T3 Code 依赖、未启动任一应用、未使用真实 Provider / IM / 远程凭据。CodePilot 针对性 8 文件测试为 160/160 通过；全量 `npm run test` 的 typecheck 与前段单测通过，但尾段未正常退出并被手动终止，不能记录为全量测试通过。

> **事实修正（2026-08-24 用户路径验收）**：CodePilot 当前没有用户可达的终端能力。仓库中的 Terminal UI、hook、IPC 和 `child_process.spawn` manager 没有形成可打开、可使用的产品路径，只能视为未接入 / 遗留骨架。本文据此将终端归类为“从零新增能力候选”，不再称为现有终端的优化。

### 本文证据等级

为避免再次把“代码存在”写成“产品可用”，本文使用以下等级：

| 等级 | 含义 | 本轮能否证明 |
|---|---|---|
| E0 | 文件、类型、计划或注释存在 | 能 |
| E1 | 有真实 import / route / UI mount / 调用链 | 能，限静态接线 |
| E2 | 针对性自动化测试通过 | 部分能；不等于真实 Provider 或打包应用 |
| E3 | 本地应用中按用户路径手动验收 | 不能；本轮未启动应用。终端“不可用”来自用户验收并由静态接线反证确认 |
| E4 | 真实账号、外部渠道、远程设备或发布包端到端验收 | 不能 |

后文未显式写 E3/E4 的“支持”都只表示源码 / 测试证据，不表示生产可用性或成熟度。

## 1. 结论先行

T3 Code 最值得 CodePilot 借鉴的不是 UI，也不是把 Next.js / better-sqlite3 全部改造成 Effect + event sourcing，而是它围绕“编码 Agent 是一个可跨客户端、可恢复、可审计的长生命周期执行环境”建立的底层合同。

对现有能力，优先级最高的五项是：

1. **统一、持久、跨 Runtime 的按轮次工作区检查点**：让每一轮真正拥有 changed files、diff、撤回和恢复能力，替代当前 SDK rewind 与 Native 内存快照两条分裂路径。
2. **为高风险会话命令补幂等回执和生命周期合同**：先覆盖发送、停止、审批、回退、Sub-agent 启动，不需要把全库改成 event sourcing。
3. **完成 Runtime 输出合同迁移并补齐控制面**：当前 canonical 类型和 Codex mapper 只是部分落地；SDK / Native 仍直接返回旧 SSE。先收口真实输出路径，再统一 start/resume/interrupt/approval/rollback 生命周期。
4. **把现有 Remote Core 方案落成共享协议、权限清单和单一连接监督器**：Bridge 可以作为一种 Controller，但不能继续充当远程状态事实源。
5. **把 changed files、diff、恢复状态和执行回执做成用户可见的任务结果面**：不能让底层已有记录却在产品里不可验证。

另有两项值得单独立项的新能力，而不是包装成现有功能优化：

- **从零建设可用终端**：先建立真实入口和明确的产品 surface，再直接采用 PTY、后端持有的 session、snapshot + live attach；不能把现存 pipes 骨架接上 UI 就算完成。
- **增加实时应用预览 / 协作浏览器**：保留 CodePilot 现有文件、Markdown、HTML、媒体和 Sandpack 预览，再补 dev server 发现、线程绑定浏览器标签和 Agent 可控的验证闭环。

一句话取舍：**借 T3 的执行底座，保留 CodePilot 已经形成真实接线的产品 surface。** CodePilot 源码中确有 Provider/API 路由、媒体与 Gallery、Assistant/Memory、IM Bridge、三 Runtime Sub-agent 等额外 surface，但本轮没有同口径 E3/E4 证据，不能据此宣称整体“更宽、更深”或“更成熟”。其中统一 Capability Package 仍是 active plan / tech-debt #63，尚未产品化，不能列为既有优势。

## 2. 拉取结果与分析边界

T3 Code 已完整克隆到仓库根目录的 `资料/t3code`，保留 Git 历史：

| 项目 | 结果 |
|---|---|
| 分支 | `main...origin/main`，克隆后 clean |
| 当前提交 | `643daa51616d0bfcd4c8235ae6966a68f106dcfe` |
| 当前提交时间 | `2026-08-23T20:27:37-07:00` |
| 占用 | 约 529 MiB，其中 `.git` 约 295 MiB，`.repos` 约 126 MiB |
| 历史提交数 | 2,765 |
| 许可证 | MIT，Copyright (c) 2026 T3 Tools Inc. |

主要代码规模（只统计各真实目录下的 `.ts/.tsx`，排除仓库内 `.repos` 参考源码）：

| 区域 | 文件 | 行数 | test/spec 文件 |
|---|---:|---:|---:|
| `apps/server` | 619 | 234,114 | 244 |
| `apps/web` | 849 | 206,255 | 276 |
| `apps/desktop` | 138 | 44,027 | 59 |
| `apps/mobile` | 497 | 83,920 | 113 |
| `packages/contracts` | 54 | 19,368 | 19 |
| `packages/client-runtime` | 153 | 33,454 | 51 |
| `packages/shared` | 99 | 16,433 | 43 |

这说明它不是一个适合按页面快速扫一遍的小项目。本文优先审阅了 server / contracts / client-runtime 的状态所有权，以及与 CodePilot 当前高风险面直接相关的 checkpoint、terminal、remote/auth、provider、timeline、preview、VCS、Sub-agent 和 telemetry。

注意：`资料/t3code` 是嵌套 Git 仓库，目前在 CodePilot 中只是未跟踪的本地参考资料。不要直接执行 `git add 资料/t3code`，否则容易把它作为嵌套仓库 / gitlink 误提交；它也不应进入 Electron 打包资源。

### 反幻觉复核结果

本轮逐项检查了报告中“已有 / 成熟 / 支持 / 验证 / 领先”的陈述，发现除终端外还有六类需要降级或纠正的结论：

| 原表述倾向 | 复核结论 | 证据与正确口径 |
|---|---|---|
| Runtime 输出侧已有统一 canonical contract | **部分错误** | [`runtime/contract.ts`](../../src/lib/runtime/contract.ts) 与 adapter helper 存在，Codex 路径在使用；但 [`sdk-runtime.ts`](../../src/lib/runtime/sdk-runtime.ts) 和 [`native-runtime.ts`](../../src/lib/runtime/native-runtime.ts) 仍直接返回旧 SSE stream，`RuntimeCapabilities` 也不是三个 runtime 的注册事实。应称“合同类型部分落地”，不是统一输出面 |
| Capability Package 是 CodePilot 既有优势 | **错误** | active plan 与 [`tech-debt #63`](../exec-plans/tech-debt-tracker.md) 明确写着尚未产品化；现有 Skill/MCP/CLI 等是分散 surface，不是统一 Package/Broker |
| Bridge 已成熟，并已验证远程消息、审批和流式回复 | **证据不足** | `/settings/bridge`、多渠道 adapter、manager 与 owner-gate 测试属于 E1/E2；本轮没有真实 Telegram/飞书/Discord/QQ/微信账号和 Provider E4 验证。“成熟”与“已验证”必须删除 |
| Preview 很强、各种格式都已可用 | **表述过强** | `WorkspaceSidebar → TabPanel → PreviewPanel` 挂载成立，格式分支和针对性测试成立；但本轮未启动 UI，Sandpack、媒体播放、编辑、热刷新、HTML 长截图不能升级为 E3。且 export 主要是具体 HTML long-shot，不是所有格式通用导出 |
| Sub-agent 已领先 / 跨三 Runtime 已较强 | **比较结论不成立** | 三条 adapter 接线、SQLite lifecycle、workflow/DAG 和 UI card 有 E1，针对性测试通过有 E2；没有三个真实 Runtime/Provider 的同口径 E4，也没有与 T3 的 benchmark，因此只能说“源码合同较丰富”，不能说“领先 / 成熟” |
| 当前 telemetry 已覆盖生产退出证据 | **表述过强** | recovery、RSS/heap/working-set 代码和 opt-in packaged smoke 脚本已经提交，但本轮没有 CI run、发布包或真实异常退出产物。应称“实现与验证脚本已落地，生产证据未在本轮核验” |
| 现有滚动引擎已经验证 | **证据不足** | TanStack Virtual、动态测量和 anchor 代码 / 测试存在；本轮无长会话 profiler、实际滚动与打包应用 E3，不能称性能已验证 |

另外，基线在调研过程中从 `ff26f22d` 前进到 `f9da69f2`；后者包含生产恢复提交。本文已改用当前 HEAD，并把“工作区正在加入”改为“源码已提交但未在本轮做发布包验收”。

## 3. 两个产品的真实差异

| 维度 | T3 Code | CodePilot 当前状态 | 判断 |
|---|---|---|---|
| 执行边界 | Node server 持有 Provider、终端、Git、文件和线程；所有客户端通过 typed RPC | Electron + Next REST/SSE，本地 UI 与 API 紧耦合；Bridge 另走一条远程链路 | T3 的单一执行边界更适合远程、多端和恢复 |
| 会话状态 | command → pure decider → persisted event → projection；命令有 receipt | SQLite 业务表 + 多个内存 registry / lock / stream snapshot | 不应全量重写，但高风险命令需要幂等回执 |
| Runtime 抽象 | Driver → 多个 Provider instance → 完整 session lifecycle adapter | canonical event/permission 类型与部分 Codex mapper 已存在；SDK/Native 仍直接走旧 SSE，capability 未形成三 Runtime 注册事实；`AgentRuntime` 控制面只有 stream/interrupt | 先完成输出合同迁移，再补控制面；不能把类型定义误报成统一架构 |
| 工作区回退 | 每轮 hidden Git ref；可算单轮/全线程 diff；Provider rollback 与 workspace restore 协调 | SDK 自带 rewind；Native 是进程内文件内容 Map，且 DB 截断先于文件恢复 | T3 的 checkpoint 思路是最直接、最高价值参考 |
| 终端 | 真 PTY、服务端 session、历史、序列、attach/restart/evict | 当前无用户可达终端；仓库只有未挂载的 `TerminalDrawer` / `useTerminal` 与 IPC / `spawn` pipes 骨架，无开启入口、无 renderer 挂载 | 这是从零新增能力，不是对现有终端升级；T3 可作为目标合同参考 |
| 远程 | desktop/web/mobile 共用 connection runtime；direct/bearer/relay/SSH | Bridge 设置页、adapter、manager 与测试已接线（E1/E2），但无本轮真实渠道验证；Remote Core 仍是方案，架构文档所列源码目录实际缺失 | T3 可校正 Remote Core 顺序；Bridge 不能称为成熟远程核心 |
| 预览 | dev server 发现 + 多 tab 浏览器 + Agent automation | PreviewPanel 已挂载，文件/Markdown/HTML/媒体/Sandpack 等源码分支与测试存在（E1/E2）；无本轮 UI 手验，且没有完整 live app browser loop | 两者概念互补；现有各格式生产可用性仍需 E3 |
| 长消息性能 | LegendList + derived row structural sharing + stable renderer | `@tanstack/react-virtual`、动态测量和 prepend anchor 代码 / 测试存在；本轮无 profiler 或手动长会话验证 | 先测量，再决定是否只吸收结构共享；不凭依赖名宣称性能成立 |
| Sub-agent | 多 Provider 原生事件归一、后台 liveness、共享 web/mobile panel model | logical run / physical attempt、SQLite lifecycle、route、DAG 与三 adapter 接线有 E1/E2；无三 Runtime 真实 Provider E4 | 借语义前先补端到端矩阵；不能宣称领先或成熟 |
| 产品 surface | 编码工作区、远程、多端、PR、终端、预览 | Provider/API 路由、媒体、Gallery、Assistant/Memory、Skill/MCP/CLI、IM、Sub-agent 等源码 surface；统一 Capability Package 尚未产品化 | 保留已接线且经用户验收的 surface；计划项不能冒充既有能力 |

## 4. P0：统一按轮次工作区检查点、diff 与安全回退

### T3 Code 做对了什么

T3 的 [`CheckpointStore`](../../资料/t3code/apps/server/src/checkpointing/CheckpointStore.ts) 把检查点作为 VCS driver 的可选能力；Git 实现在 [`GitVcsDriver.ts`](../../资料/t3code/apps/server/src/vcs/GitVcsDriver.ts)：

- 每轮使用 `refs/t3/checkpoints/<thread>/turn/<count>` 隐藏 ref；ref 规则在 [`checkpointing/Utils.ts`](../../资料/t3code/apps/server/src/checkpointing/Utils.ts)。
- 捕获时创建临时 `GIT_INDEX_FILE`，执行 `read-tree`、`git add -A`、`write-tree`、`commit-tree`、`update-ref`，不会改动用户当前 index。
- [`CheckpointDiffQuery`](../../资料/t3code/apps/server/src/checkpointing/CheckpointDiffQuery.ts) 可计算任意两轮之间和整个线程的 patch。
- checkpoint metadata、workspace restore、Provider conversation rollback 分层，由 reactor 协调，而不是把“删消息”当成回退完成。

这个方案的关键价值不是“Git 技巧”，而是让一轮 Agent 工作拥有可验证的输入 / 输出边界：轮次开始前是什么状态、轮次结束后改了什么、回退要恢复到哪里，都有独立事实源。

### CodePilot 当前缺口

[`src/lib/file-checkpoint.ts`](../../src/lib/file-checkpoint.ts) 当前只在进程内保存最多 20 个 checkpoint，且只有显式调用 `recordFileModification()` 的 CodePilot 工具写入才能被捕获：

- 应用或 Next server 重启后全部丢失；
- CLI / MCP / shell / Provider 自己写文件可能绕过记录；
- 只存 UTF-8 文本，不覆盖二进制、权限、删除目录、重命名和 staged 状态；
- restore 对单文件错误静默继续，调用方不知道部分失败；
- [`POST /api/chat/rewind`](../../src/app/api/chat/rewind/route.ts) 在 Native 路径先删除 DB 消息，再恢复文件；恢复失败时对话已被截断，无法原子补偿；
- 只有仍在内存中的 SDK conversation 会走 `rewindFiles()`；应用重启后的 SDK 与 Codex 都落入 Native fallback，而 Codex 文件修改不会经过 `recordFileModification()`；
- Native dry-run 只要消息存在就固定返回 `canRewind: true, filesChanged: []`，没有检查 checkpoint 是否存在；正式执行即使恢复列表为空也返回成功。这是用户可见的假成功风险；
- SDK、Native、Codex 的回退语义因此不是两条而是三种实际结果，当前 UI 的统一按钮掩盖了差异。

现有 tech-debt #39 还记录了 rewind point 与可见用户消息按位置匹配的问题。T3 的按 turn count / thread id 建模不能直接解决 UI 映射，但说明回退身份应成为持久、显式的领域对象，而不是数组位置。

### 建议的 CodePilot 适配

建立统一 `WorkspaceCheckpointService`，所有 Runtime 都通过它完成：

1. 轮次接受前捕获 base checkpoint；轮次 terminal 后捕获 result checkpoint。
2. SQLite 保存 `session_id / user_message_id / turn_id / workspace_realpath / ref / state / created_at`，Git ref 保存内容快照。
3. 提供 `getTurnDiff`、`getSessionDiff`、`planRestore`、`applyRestore`、`deleteRefs`。
4. UI 将 changed files / diff 作为每轮 Assistant 结果的一部分，而不是只放在 Git 面板。
5. 回退操作必须用明确 checkpoint id 对齐 Provider rollback、workspace restore 和 message projection；任何一侧失败都保留可恢复状态，不能先不可逆删消息。
6. 非 Git 工作区保留一个有上限、持久化的 blob/manifest fallback；超大文件、二进制和目录操作必须显式标记 unsupported/partial，不能显示假成功。

### 不能照搬的危险点

T3 的 restore 直接执行 `git restore --worktree --staged -- .`、`git clean -fd -- .`。这在由 T3 独占的受控 worktree 中可以成立，但 CodePilot 面向用户现有脏工作区，原样复制会删除轮次后由用户或其他进程创建的未跟踪文件。

CodePilot 必须增加：

- restore preview，列出将修改 / 删除 / 冲突的精确路径；
- 只清理由 checkpoint manifest 证明是 Agent 创建的路径；
- checkpoint 后发生外部修改时 fail closed 或进入冲突确认；
- 删除前移入可恢复隔离区，或至少保存 preimage；
- staged / unstaged 状态分别展示；
- 默认只在 CodePilot 派生 worktree 中允许一键全量恢复，普通用户工作区采用更保守策略。

### 完成标准

- 三个 Runtime 对同一轮都产生真实 diff；无改动时显示“无改动”，不是缺失数据补 0。
- 应用重启后仍可查看 diff 和执行 dry-run。
- tracked/staged/untracked/rename/delete/二进制均有明确语义。
- 回退中途失败不会丢消息或把 UI 标成成功。
- 同一 restore command 重试幂等；不同 checkpoint 复用同一 command id 必须拒绝。

## 5. 新能力候选（P1）：从零建设可用终端

### T3 Code 的参考价值

T3 的 [`terminal` contracts](../../资料/t3code/packages/contracts/src/terminal.ts) 把终端当成线程资源，而非 React 组件附属品：

- snapshot 包含 terminal id、状态、PID、label、history 和 sequence；
- 事件覆盖 started/output/exited/closed/error/cleared/restarted/activity；
- attach 先给 snapshot，再接 live events，客户端重连不会丢掉窗口期间输出；
- [`terminal/Manager.ts`](../../资料/t3code/apps/server/src/terminal/Manager.ts) 有历史上限、持久化 coalescing、真实 resize、多 terminal、进程事件串行化与闲置回收；
- 终端进程还能登记到 port discovery，使“这个 dev server 来自哪个线程 / 终端”成为可展示事实。

### CodePilot 当前事实：没有产品终端

源码核验与用户路径验收一致：当前产品没有可打开、可使用的终端。

- [`TerminalDrawer.tsx`](../../src/components/terminal/TerminalDrawer.tsx) 没有被其他 renderer 组件 import 或挂载；因此它自身的 `terminalOpen` 判断和关闭按钮都不可达。
- [`AppShell.tsx`](../../src/components/layout/AppShell.tsx) 仍保存 `terminalOpen` / `setTerminalOpen` 状态并放进 context，但渲染树没有 `<TerminalDrawer />`。
- [`UnifiedTopBar.tsx`](../../src/components/layout/UnifiedTopBar.tsx) 的注释提到 terminal controls，实际既没有读取 terminal state，也没有打开终端的按钮；这是注释 / 实现漂移。
- 全库对 `setTerminalOpen(...)` 的调用只有未挂载抽屉里的关闭动作，没有任何打开动作。
- Main / preload 的 terminal IPC 和 [`electron/terminal-manager.ts`](../../electron/terminal-manager.ts) 虽然存在，但 renderer 无调用入口；“有后端文件”不能当成用户拥有该能力的证据。

即使未来把这套 UI 手动挂上，现存 manager 也只是 `child_process.spawn` + pipes，不是真 PTY，resize 是 no-op；[`useTerminal.ts`](../../src/hooks/useTerminal.ts) 还会在组件卸载时 kill 进程。它最多是需要重新评估去留的遗留骨架，不应标记为“已有终端、体验受限”。历史交接文档中关于交互终端的描述也必须按当前源码与用户路径降级为历史方案，不能作为现状事实。

### 若立项，建议分三步实施

第一步，先建立真实产品路径与状态边界：

- 明确终端出现在哪个 workspace / session surface、谁可以创建、打开、关闭；
- renderer 必须有可发现入口、空态、错误态和 capability detection；
- terminal id 从一开始就绑定 session/thread，不绑定组件实例；
- 先决定遗留 UI / IPC 骨架是复用、重写还是删除，不能因为文件已存在而默认它可用。

第二步，保证执行真实性：

- 使用 `node-pty`（Electron/Node 环境更合适；不必复制 T3 的 Bun adapter）；
- 实现 resize、exit/signal、UTF-8/二进制输出边界；
- 给 `terminal:write` 加输入大小上限、终端 id ownership、cwd realpath 与 env allow/deny 规则；
- 补 macOS arm64/x64、Windows x64/arm64、Linux 的 native module 打包 smoke。

第三步，建立可重连状态所有权：

- terminal id 绑定 session/thread，不绑定组件实例；
- Main/后端持有 process 和有界 history，renderer 只 attach/detach；
- attach 返回 snapshot + sequence，后续事件按 sequence 去重；
- panel unmount 不 kill，只有显式关闭、会话删除、应用退出或闲置策略才清理；
- 支持同一会话多个命名终端；
- 将终端启动的监听端口暴露给实时预览，但不做持续无需求扫描。

这项新能力能同时服务本地命令运行、未来移动端观察、dev server 预览和 Agent 执行可解释性。但验收起点必须是“用户能否真实打开并完成一次交互命令”，不能用 IPC、hook 或 manager 文件存在代替产品可达性。

## 6. P0/P1：高风险命令的幂等回执，而非全库 event sourcing

### T3 Code 的模式

[`OrchestrationEngine`](../../资料/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts) 的核心路径是：

1. command 携带稳定 `commandId` 和 aggregate identity；
2. 先查 command receipt；同 id + 同 aggregate 返回原结果，同 id + 不同 aggregate 报冲突；
3. pure decider 基于当前 read model 产生 event；
4. event append、DB projection、receipt 在同一 SQL transaction；
5. transaction commit 后才替换内存 read model 并 publish；
6. 失败后从持久事件重新 reconcile 内存状态。

这能解决远程重试、断线重发、双击、多个 Controller 和进程重启下的“请求到底执行过没有”。

### CodePilot 应借多少

不建议把现有 50+ REST 路由、媒体系统、Provider 管理和数据库全部 event-source。迁移成本大，双写期反而增加故障面。建议只为有副作用且重试歧义高的操作建立统一 command receipt：

- send turn / queue message；
- interrupt / force stop；
- permission allow/deny；
- workspace restore / rewind；
- Sub-agent spawn / retry / cancel；
- 若终端能力立项：terminal create/restart/close；
- 未来 remote lease takeover。

最小表可以保存 `command_id`、`aggregate_kind`、`aggregate_id`、`command_type`、规范化 payload hash、`accepted|rejected`、result cursor/ref、error code、created_at。相同 command id 但 payload/aggregate 不同必须拒绝，不能误回放别人的成功回执。

与此配套，把 stream/session 的关键状态变化提取成纯 transition 函数，并让 DB commit 先于 UI/SSE 广播。CodePilot 已有 session lock、stream checkpoint 和 Sub-agent durable event；canonical runtime event 只有部分路径落地。仍不必重写全部 event store，但不能把未完成迁移的类型合同计作现成底座。

### 最适合直接采用的测试思想

T3 的 [`DrainableWorker`](../../资料/t3code/packages/shared/src/DrainableWorker.ts) 用 `drain()` 代替测试里的固定 sleep；[`KeyedCoalescingWorker`](../../资料/t3code/packages/shared/src/KeyedCoalescingWorker.ts) 保留每个 key 的最新值并支持 `drainKey()`。它们依赖 Effect，CodePilot 不宜逐文件复制，但应在 Promise/queue 体系中实现同等原语，用于：

- stream checkpoint 写入；
- 未来若建设终端：terminal history 持久化；
- Provider snapshot / model probe 刷新；
- telemetry buffer flush；
- exactly-once 测试 barrier。

原则是只 coalesce 可丢弃的中间快照，tool result、permission 和 first meaningful checkpoint 必须强制 flush；未来的 terminal 输出也应遵守同一规则。

## 7. P1：补全 Runtime 控制面，并支持同类 Provider 多实例

### T3 Code 的抽象

[`ProviderAdapter`](../../资料/t3code/apps/server/src/provider/Services/ProviderAdapter.ts) 不只定义输出流，还定义：start session、send turn、interrupt、respond approval、respond structured input、stop/list/has session、read thread、rollback thread、stop all 和 canonical events。

[`ProviderDriver`](../../资料/t3code/apps/server/src/provider/ProviderDriver.ts) 进一步区分：

- Driver：静态类型、config schema、默认配置和实例工厂；
- Provider instance：一份具体配置和独立资源作用域；
- Adapter：该实例的会话协议；
- Snapshot/text generation：该实例的可用性、模型、skills、命令等能力。

同一个 driver 可以有多个 instance，实例之间不能共享可变 session/process state。当前内置 Codex、Claude、Cursor、Grok 和 OpenCode，见 [`builtInDrivers.ts`](../../资料/t3code/apps/server/src/provider/builtInDrivers.ts)。

### CodePilot 当前基础与缺口

CodePilot 的 [`runtime/contract.ts`](../../src/lib/runtime/contract.ts) 已定义 canonical run event、permission event、opaque session ref 和 capability matrix；[`event-adapter.ts`](../../src/lib/runtime/event-adapter.ts) 也提供 constructor / mapping helper。针对性合同测试通过，说明这些类型不是纯文档。

但调用链没有完成注释所承诺的“三 Runtime UI 只消费 canonical union”：[`sdk-runtime.ts`](../../src/lib/runtime/sdk-runtime.ts) 和 [`native-runtime.ts`](../../src/lib/runtime/native-runtime.ts) 都直接返回旧 SSE stream，也不注册 `RuntimeCapabilities`；canonical mapper 主要被 Codex 与部分 builtin/media 路径调用。因此它是可保留的迁移基础，不是已完成的统一输出合同。另一个缺口是 [`runtime/types.ts`](../../src/lib/runtime/types.ts) 的 `AgentRuntime` 控制面仍只有 `stream / interrupt / isAvailable / dispose`，很多 resume、approval、session ownership、read/rollback 逻辑继续散落在 runtime-specific registry、route 和 DB 字段中。

建议先完成真实输出路径迁移，再在同一合同上增加控制面：

- `RuntimeDriver`：描述一种 runtime implementation；
- `RuntimeInstance`：绑定 Provider/account/config/home/path 的一份实例；
- `RuntimeSessionController`：start/resume/send/interrupt/respond/stop/read/rollback；
- 每个实例独立 session map、process scope 和 event source；
- session ref 继续 opaque，并按 runtime instance 保存，而不是只有 runtime id。

这对 CodePilot 尤其重要，因为 CodePilot 的 API Provider 与账号配置比 T3 的 CLI-first catalog 更丰富。同类 Provider 多账号、多 endpoint、多 CODEX_HOME/Claude config 是自然需求，不能继续假设一个 Runtime 全局只有一个实例。

同时建立 Runtime conformance suite：同一批 start/send/interrupt/approval/resume/unknown-event/cleanup 测试跑遍 Native、Claude、Codex，Provider-specific fixture 只负责构造输入。未来若新增终端，它应有独立的 capability 与 contract suite，不能假定所有 Runtime 天然支持。

## 8. P1/战略 P0：Remote Core、认证和共享连接 Runtime

### T3 Code 的核心取舍

`Remote Architecture` 把远程问题拆得很清楚：

- `ExecutionEnvironment` 是稳定身份，持有 Provider、项目、线程、终端、Git 和文件；
- connection target 只有 primary / bearer / relay / SSH；Tailscale 是 endpoint provider，不是新 runtime 类型；
- “如何启动 server”和“客户端如何访问 server”分离；
- RepositoryIdentity 只做跨环境分组，不用于路由；真正路由必须落到 environment-local project/thread；
- server 是唯一执行事实源，远程不是另一套业务运行时。

`Connection Runtime` 则把连接策略收口到一个 environment supervisor：

- transport 每次只尝试一次，supervisor 是唯一 retry owner；
- offline 不消耗重试，transient failure 3/4/8/16 秒后持续重试，稳定 30 秒重置 backoff；
- auth/config 错误等待凭据或配置变化，不盲重连；
- connected 必须同时证明 socket 打开且 initial config RPC 成功；
- subscription 在新 session 上切换，domain failure 不错误地拆掉健康 transport；
- shell/thread cache 与 live sync 状态分开，旧 cache 不能覆盖快速重连后的新 live data。

### CodePilot 当前事实

CodePilot 现有 [`mobile-remote-control-overall-plan.md`](./mobile-remote-control-overall-plan.md) 定义了 Host / Controller / Session / Lease、多读者单写者方向。Bridge 的 `/settings/bridge` 路由、多渠道 adapter、manager、permission broker 与流消费 owner gate 在源码中接线，相关针对性测试也存在；但本轮没有真实 IM 账号、真实 Provider 和移动设备验证，所以只能把它作为可复用候选，不能写成“已成熟 / 已验证远程消息、审批和流式回复”。

但当前源码仍默认监听 `127.0.0.1`，API 假设本地可信 UI。更重要的是，`ARCHITECTURE.md` 声称存在 `src/lib/remote/types.ts`、`remote-manager.ts` 和 `index.ts`，当前检出中 `src/lib/remote/` 实际不存在。这应被视为文档漂移和 Remote Core 尚未形成生产事实，而不是“骨架已完成”。

### 建议落地顺序

1. **先修事实基线**：更正文档状态；列出现有 Bridge、session lock、permission broker、stream snapshot 中可复用与不能复用的边界。
2. **定义共享 contracts**：environment、project/thread ref、command、event cursor、permission、diff、lease；无需立刻拆 monorepo，但不能再让 Android/Web 各自复制 REST shape。终端只有在产品立项后才加入可选 capability contract。
3. **建立本地 loopback client runtime**：桌面 UI 也通过同一 contract 和 connection supervisor 访问本地环境。先证明协议可替换现有调用，不急着开放网络。
4. **实现配对和 scope**：LAN/SSH 或 Tailscale 先行；再做公网 relay。远程移动端不能成为第一位协议消费者，否则本地桌面与远程路径会再次分叉。
5. **共享 web client 后再做 mobile UI**：先让 web/desktop 在同一 connection runtime 下稳定，React Native 只提供 platform layer。

Bridge 应成为 `ControllerAdapter` / channel surface：它消费 Remote Core 的 session projection 和 command API，不继续直接拥有一套对话执行、stop、permission 和状态收口逻辑。

### 认证必须先于监听地址变化

T3 的 `environment-auth.md` 和 [`RpcAuthorization.ts`](../../资料/t3code/apps/server/src/auth/RpcAuthorization.ts) 有四个值得直接采用的原则：

- 每个 RPC method 都必须在一个穷尽 scope map 中登记；漏登记是类型错误或 fail closed；
- pairing credential 一次性，设备 session 可撤销；
- WebSocket URL 只携带短期 ticket，不放长期 bearer；
- 即使 WS 握手已认证，每个 operation 仍检查 scope。

CodePilot 首期可简化为：设备 key + 一次性配对码 + 短期 WS ticket + read/operate/files/settings/admin scope，不必立即复制完整 DPoP、Cloudflare relay 和 OAuth 控制面。若未来新增终端，再单独引入 terminal scope，不能预先把不存在的能力写进权限承诺。在这些边界完成前，不能把 Next server 从 loopback 改成 `0.0.0.0`。

## 9. P1：实时应用预览 / 协作浏览器，而非替换现有 Artifact 预览

CodePilot 的 `WorkspaceSidebar → TabPanel → PreviewPanel` 挂载链成立；[`PreviewPanel.tsx`](../../src/components/layout/panels/PreviewPanel.tsx) 源码包含 Markdown、HTML、JSX/TSX Sandpack、CSV/TSV、JSON、diff、图片、音频、视频、编辑、信任分层和文件变化刷新分支，相关状态 / 安全测试属于 E1/E2。导出需准确限定为具体 HTML long-shot 等已接线路径，不能泛化成所有格式导出。本轮没有启动应用，因此这些分支不能统一标成 E3 可用。T3 的 live app browser 仍是不同产品面，不是替换关系。

T3 值得借的是另一类产品面：

- [`PortScanner`](../../资料/t3code/apps/server/src/preview/PortScanner.ts) 按需发现监听端口，并通过有界 HTTP(S) probe 确认它真的是可访问 HTML，而不是把任意端口显示成 web app；
- [`preview contracts`](../../资料/t3code/packages/contracts/src/preview.ts) 用 `(threadId, tabId)` 管理多 tab、server epoch 和单调 revision，防止 list 与 event 乱序覆盖；
- [`previewAutomation`](../../资料/t3code/packages/contracts/src/previewAutomation.ts) 提供 open/navigate/snapshot/click/type/press/scroll/evaluate/wait/record/resize/color scheme；
- [`PreviewAutomationBroker`](../../资料/t3code/apps/server/src/mcp/PreviewAutomationBroker.ts) 将 Agent session 固定到一个可用 desktop host/tab，连接替换或断开时清理 pending request，而不是每次任意挑一个浏览器；
- environment-relative port 让远程 Host 的 `localhost:5173` 能被当前客户端正确映射，而不是误指向手机自己的 localhost。

建议在 Workspace Sidebar 中保留两类清晰 surface：

- **文件 / Artifact 预览**：继续使用 CodePilot 当前 PreviewPanel；
- **实时应用预览**：浏览器 tab、dev server、设备尺寸、刷新/历史、Agent pointer 和验证工具。

Agent 自动化第一阶段只需 status/open/navigate/snapshot/click/type/wait；`evaluate` 和录制可以后移。每个动作必须绑定 session、environment、thread、tab、超时和结果大小上限；浏览器 partition、下载、弹窗、外部协议、摄像头/麦克风、剪贴板和导航策略要单独做安全审查。

这项能力会让“Agent 写完网页”从只看文件 diff 变成“启动 → 打开 → 操作 → 截图/DOM 证据 → 修复”的闭环，是用户可明显感知的提升。

## 10. P1：消息流性能只做结构共享和写入合并

T3 的 [`MessagesTimeline.tsx`](../../资料/t3code/apps/web/src/components/chat/MessagesTimeline.tsx) 使用 LegendList，但真正值得参考的是：

- derived rows 经 `useStableRows` 做 id-based structural sharing；
- 未变化 row 保持对象引用，流式新增一条 work event 不让整个列表 row props 全变；
- `renderItem` 没有 closure dependency，共享低频/高频状态拆进 context；
- 显式处理 initial-at-end、maintain-at-end、visible-position、prepend anchor 和 disclosure toggle settling。

CodePilot 的 [`MessageList.tsx`](../../src/components/chat/MessageList.tsx) 源码使用 `@tanstack/react-virtual`、稳定 message id、动态测量、overscan 和 prepend anchor，相关纯逻辑 / contract 测试存在；但本轮没有长会话 profiler 或应用内滚动验收。默认不更换虚拟列表库仍是较低风险选择，但理由是避免无证据迁移，不是“现有性能已经验证”。更窄的候选优化是：

- 把 message/tool/reasoning/task marker 先归一成稳定 timeline rows；
- 对 row 做按 variant 的浅比较和结构共享；
- 把 streaming 高频状态与历史 row props 分开；
- 为展开/折叠工具、prepend、流式追加、切换会话后恢复建立 scroll-anchor 行为测试；
- 对 SQLite streaming checkpoint 使用 keyed coalescing，但 tool/permission 强制 drain；未来的 terminal 流也应强制 drain。

这些措施理论上能降低 React commit 与 SQLite write amplification；是否值得做必须先用 profiler、长会话和滚动 anchor E3 建立基线，不能把推断写成已实现收益。

## 11. P1/P2：VCS driver、工作树隔离和任务结果面

T3 的 [`VcsDriver`](../../资料/t3code/apps/server/src/vcs/VcsDriver.ts) 把 repository detection、workspace files、remotes、ignore filtering、init、diff preview 和 checkpoint 能力收进 SPI，并用 [`VcsDriverContractHarness`](../../资料/t3code/apps/server/src/vcs/testing/VcsDriverContractHarness.ts) 对所有 driver 跑同一套契约。

CodePilot 的 Workspace Sidebar 已挂载 Git Tab，源码中存在 status/branch/checkout/log/commit/push/worktree derive 的 UI/API/service 链；本轮未手动执行这些写操作，因此证据止于 E1/E2，不宣称所有 Git 路径生产可用。架构上仍不需要为 T3 重新做第二个 Git 面板，更值得调整的是：

1. 让当前零散 Git service 先进入一个最小 VCS interface，为 checkpoint、diff 和未来不同 VCS 留边界。
2. 每个 chat/session 显示真实 workspace realpath、branch 和 worktree identity；Sub-agent 写操作也必须落到同一 identity。
3. 支持“新任务在派生 worktree 中运行”，并将 workspace lock 按 realpath 统一到 Native/Claude/Codex，直接承接 tech-debt #58 的跨 Runtime 写冲突。
4. 优先做“本轮改动 / 整个任务改动 / 回退”结果面，再考虑 PR 创建与 reviewer/comment UI。
5. GitHub/GitLab/Bitbucket/Azure DevOps 的完整 PR 工作区是 T3 的强项，但对 CodePilot 属于 P2；在 checkpoint 和结果 diff 尚未统一时先做多平台 PR，会扩大而非收敛状态面。

## 12. Sub-agent：CodePilot 源码合同较丰富，但不能宣称领先

T3 的 Sub-agent 源码包含一组值得参考的合同：[`subagentRuntime.ts`](../../资料/t3code/packages/client-runtime/src/state/subagentRuntime.ts) 从持久 task/tool activity 容错折叠 roster，区分 reusable agent identity 和 activation，处理迟到/乱序 start/complete、idle 非 terminal、provider-specific usage、nested agent attribution 和最近活动 ring；[`ThreadBackgroundLiveness`](../../资料/t3code/apps/server/src/orchestration/ThreadBackgroundLiveness.ts) 则区分后台 monitor/shell 与真实 Sub-agent 对主回合存活状态的影响。本轮没有运行 T3，不能据此评价其产品成熟度。

CodePilot 源码与针对性测试已经覆盖：

- `logical_run_id` + physical attempt；
- running → settling → terminal；
- SQLite `subagent_runs` / `subagent_run_events`；
- requested/effective Provider/model provenance；
- 三 Runtime adapter；
- workflow dependency/DAG；
- terminal immutable 与结构化结果；
- 页面切换后的 durable polling 和详情 surface。

这些项目在针对性测试中通过，但其中不少是 source-pin、纯函数或模拟 DB 测试；本轮没有 Native、Claude、Codex 三条真实 Provider 子任务 E4。因此不建议仅凭架构形状替换现有 roster/store，也不能据此宣称 CodePilot 领先。下一步应先补真实端到端矩阵，再选择性借四类语义和测试：

1. 累计 usage frame 用 field-wise max，activation delta 才累加，不能把两种 Provider 语义混在一个 merge 中。
2. complete 可先于 start 到达；迟到 start 只能补 metadata，不能把 terminal 改回 running。
3. `idle` 是可恢复的 settled-ish 状态，不等于 completed；waiting 仍是 active，因为在等用户。
4. nested agent 内部 shell/monitor 不应污染父任务工作日志或错误地延长父回合，但 nested agent 自己仍应出现在 roster。

T3 的 denylist 分类也值得参考：Provider 对 agent-flavored task type 的命名会漂移，纯 allowlist 容易静默丢新类型；服务端应写入明确 `agentKind`，客户端只在旧数据缺字段时启发式降级。

## 13. P2：资源诊断按需增强，不立即复制 Rust sidecar

T3 的 `resource-telemetry.md` 是很完整的长期参考：独立 Rust sidecar 通过 `sysinfo` 采集进程树，使用 `(pid, startTime)` 识别进程，历史在 sidecar 内有界保存，只有诊断页打开才向 Node 流式传输；Electron `app.getAppMetrics()` 同样按需开启。sidecar 崩溃不会破坏 Node，且可以独立监督、重启和 version-check。

当前 HEAD 已提交 packaged utility 的 RSS/heap、Electron working set/CPU、host memory、fatal exit 诊断、safe-mode recovery 和 opt-in packaged smoke 脚本。它证明实现与验证入口存在，但本轮没有对应 CI run、发布包日志、Sentry 事件或真实异常退出产物，不能写成“生产退出证据已经覆盖”。在取得这些证据前，不应因看到 T3 就另开一套并行 telemetry 重写。

建议按需求升级：

- 近期：在现有数值采样上增加 `(pid, creationTime)` 校验、有界 ring、diagnostics-open demand gate，避免把周期性日志当历史库；
- 中期：只跟踪 CodePilot server、Provider、Sub-agent 等已登记 descendants，先不扫描全系统；未来真正建设终端后再纳入 terminal process；
- 出现“需要完整孙进程树、跨平台 I/O/CPU 归因、shell probe 成本过高”的明确需求后，再评估 standalone Rust monitor；
- 不把 T3 的 1s 常态采样直接照搬到 CodePilot，尤其当前目标是解决 OOM/异常退出证据而非构建任务管理器。

## 14. 工程与测试方法：值得直接纳入评审清单

T3 仓库最稳定、最可迁移的资产其实是一组工程约束：

- **单一 owner**：connection retry、session execution、preview tab、provider instance 各自只有一个生命周期 owner；未来若新增 terminal process，也必须遵守同一规则。React 不创建 transport 或后台 retry loop。
- **合同穷尽**：新增 RPC 必须登记 scope；新增 provider/runtime 必须过相同 conformance suite。
- **持久化先于广播**：DB 成功后才发布 event；失败时从持久层 reconcile 内存状态。
- **显式反向状态**：不仅测 start/success，还测 stop、interrupt、waiting、idle、resume、disconnect、credential change、process replacement。
- **不用固定 sleep 等异步完成**：worker 提供 drain/receipt，测试在确定性 barrier 上断言。
- **跨版本能力协商**：preview host 公布支持的 operations，客户端不假设所有已连接版本能力一致。
- **缓存不是健康证明**：有 cache 不等于 connected；连接、shell sync、thread sync 分别有状态。

这些原则可进入 CodePilot guardrail，但不要复制 T3 的“计划和调研不进仓库”流程。CodePilot 的 exec-plan / research / handover 已经是三方协作事实源，工作方式不同，不能盲目统一。

## 15. 不建议照搬的部分

| T3 做法/能力 | 不建议照搬的原因 | CodePilot 的取舍 |
|---|---|---|
| 全量 Effect + event-sourced orchestration 重写 | 迁移面过大，现有媒体、Provider、Bridge、Sub-agent 和 SQLite 业务表会长期双写 | 只给高风险 session commands 加 receipt/pure transition |
| CLI-first Provider catalog | CodePilot 的 API Provider、proxy、模型目录和多账号策略更丰富 | 借 Driver/Instance/Adapter 生命周期，不借产品模型 |
| 整体 UI / 路由 / workspace shell | CodePilot 已有 Sidebar、Artifact、Gallery、Assistant、Bridge 的 E1 源码 surface，但本轮没有整体 E3 成熟度证据 | 只借结果 diff；live browser、terminal 作为独立新能力评估，不假设已有 surface |
| LegendList 替换 TanStack Virtual | CodePilot 已接入 TanStack Virtual 与滚动锚点逻辑，但本轮没有长会话性能基线 | 先测量；若有问题优先借 structural sharing 和 stable renderer，不先换库 |
| 原样执行 `git clean -fd` restore | 普通脏工作区会有用户/其他进程新文件，存在数据破坏风险 | manifest + dry-run + conflict + recoverable delete |
| 立即建设完整 React Native app | 若 contract/auth/supervisor 未先稳定，移动端会固化第二套协议 | 先 loopback shared client，再 LAN/SSH/web，最后 mobile |
| 立即复制 Cloudflare relay + DPoP | 首期复杂度和运维面过高 | 短期 ticket + scoped device session 起步，公网 relay 后置 |
| 立即复制 Rust telemetry sidecar | 当前 CodePilot 已在补退出期内存证据，完整进程树不是近期阻塞 | 先扩现有按需数值观测，有明确需求再 sidecar |
| 先做四平台 PR review workspace | checkpoint/diff/identity 尚未统一时会制造更多状态分叉 | 先做 task outcome，再做 PR publish/review |
| 用 T3 Sub-agent store 替换 CodePilot | CodePilot 的 logical attempt、DAG、多模型 route 和 durable result 更适合自身产品 | 借乱序 fold、usage merge、background liveness 测试 |

## 16. 推荐工作包与顺序

### Wave A：先把“执行结果可信”做实

| 工作包 | 目标 | 依赖 | 验收重点 |
|---|---|---|---|
| A1 Workspace checkpoint | 三 Runtime 每轮都有持久 diff、dry-run、safe restore | VCS SPI 最小切片 | 脏工作区、重启、partial failure、untracked safety |
| A2 Command receipt | send/stop/approval/rewind/subagent 幂等 | SQLite migration + command identity | 重试同结果、冲突拒绝、commit-before-publish |

### Wave B：把工作区闭环补齐

| 工作包 | 目标 | 依赖 | 验收重点 |
|---|---|---|---|
| B1 Runtime lifecycle control plane | Driver/Instance/SessionController + conformance | A2 | 三 Runtime 统一 start/resume/interrupt/approval/rollback |
| B2 Task outcome surface | 每轮/全任务 changed files + diff + revert | A1 | 真实 source breadcrumb，不显示假 0 |
| B3 Worktree isolation | 新任务/写 Sub-agent 可选独立 worktree，统一 realpath lock | A1 | 跨 Runtime 不并发写同一 worktree |
| B4 Timeline structural sharing | 降 React/SQLite 流式放大 | drain/coalescing primitive | 长会话 profiler + anchor 行为测试 |

### New Capability Lane：产品决策后再进入主排期

| 工作包 | 目标 | 依赖 | 验收重点 |
|---|---|---|---|
| N1 Terminal product surface | 从无到有建立可发现入口、空态、错误态和 session identity | 明确产品范围；审计遗留骨架 | 用户路径真实可达，不以代码文件存在代替能力 |
| N2 Terminal PTY + session owner | 真 resize/full-screen、attach/snapshot/live、多 terminal | N1 + native packaging | mac/win/linux packaged smoke、sequence、history bound、explicit close |
| N3 Live app preview | dev port discovery + thread-bound browser + basic automation | 可独立建设；接 N2 或后续 supervisor 可增强归属 | on-demand probe、tab identity、security partition |

### Wave C：远程产品化

| 工作包 | 目标 | 依赖 | 验收重点 |
|---|---|---|---|
| C1 Remote contracts + local supervisor | 桌面也走共享 environment client | A2/B1 | 单 retry owner、断线恢复、cache/live 防覆盖 |
| C2 Pairing + scope auth | 安全 LAN/SSH/Tailscale 控制 | C1 | one-time code、ticket、revoke、per-method scope |
| C3 Web/mobile client | 共享 projection/command，平台只提供 storage/lifecycle/network | C1/C2 | foreground reconnect、offline outbox、lease takeover |
| C4 Source control workspace | PR publish/view/review，多 host provider | A1/B2/B4 | repo identity 不用于误路由，写操作有确认 |
| C5 Deep telemetry | 完整 process tree / history / attribution | 明确诊断需求 | demand-driven、有界、observer cost 可见 |

若近期产品目标不是远程，多端相关 C1/C2 可放到 B4 之后；但一旦决定开放非 loopback 访问，C2 的认证与 scope 必须前置，不能后补。N1-N3 是新增产品能力，不应因仓库已有终端骨架就自动获得比现有可靠性问题更高的优先级。

## 17. 可近距离参考的源码清单

### 建议重点精读

- `docs/internals/overview.md`：server-authoritative + orchestration 总览。
- [`OrchestrationEngine.ts`](../../资料/t3code/apps/server/src/orchestration/Layers/OrchestrationEngine.ts)：receipt、transaction、commit 后广播和失败 reconcile。
- [`ProviderAdapter.ts`](../../资料/t3code/apps/server/src/provider/Services/ProviderAdapter.ts) / [`ProviderDriver.ts`](../../资料/t3code/apps/server/src/provider/ProviderDriver.ts)：控制面与多实例边界。
- [`CheckpointStore.ts`](../../资料/t3code/apps/server/src/checkpointing/CheckpointStore.ts) / [`GitVcsDriver.ts`](../../资料/t3code/apps/server/src/vcs/GitVcsDriver.ts)：isolated index + hidden ref。
- [`terminal.ts`](../../资料/t3code/packages/contracts/src/terminal.ts) / [`terminal/Manager.ts`](../../资料/t3code/apps/server/src/terminal/Manager.ts)：snapshot/live attach 与历史所有权。
- `connection-runtime.md` / [`supervisor.ts`](../../资料/t3code/packages/client-runtime/src/connection/supervisor.ts)：单一 retry owner。
- `environment-auth.md` / [`RpcAuthorization.ts`](../../资料/t3code/apps/server/src/auth/RpcAuthorization.ts)：配对、ticket、scope fail-closed。
- [`previewAutomation.ts`](../../资料/t3code/packages/contracts/src/previewAutomation.ts) / [`PreviewAutomationBroker.ts`](../../资料/t3code/apps/server/src/mcp/PreviewAutomationBroker.ts)：Agent 与人共享 browser surface。
- [`MessagesTimeline.logic.ts`](../../资料/t3code/apps/web/src/components/chat/MessagesTimeline.logic.ts)：derived row structural sharing。
- [`DrainableWorker.ts`](../../资料/t3code/packages/shared/src/DrainableWorker.ts) / [`KeyedCoalescingWorker.ts`](../../资料/t3code/packages/shared/src/KeyedCoalescingWorker.ts)：确定性异步与最新值合并。

### 参考时必须带着 CodePilot 现有事实对照

- [`src/lib/runtime/contract.ts`](../../src/lib/runtime/contract.ts) / [`event-adapter.ts`](../../src/lib/runtime/event-adapter.ts)：canonical 类型与 helper 可保留，但 SDK/Native 迁移尚未完成。
- [`src/lib/file-checkpoint.ts`](../../src/lib/file-checkpoint.ts) / [`rewind route`](../../src/app/api/chat/rewind/route.ts)：当前回退分裂和持久性缺口。
- [`TerminalDrawer.tsx`](../../src/components/terminal/TerminalDrawer.tsx) / [`AppShell.tsx`](../../src/components/layout/AppShell.tsx) / [`UnifiedTopBar.tsx`](../../src/components/layout/UnifiedTopBar.tsx)：共同证明终端 UI 当前未挂载、无开启入口。
- [`electron/terminal-manager.ts`](../../electron/terminal-manager.ts) / [`useTerminal.ts`](../../src/hooks/useTerminal.ts)：仅作为遗留骨架审计；即使未来接入，仍有非 PTY 和组件卸载即 kill 的问题。
- [`MessageList.tsx`](../../src/components/chat/MessageList.tsx)：已虚拟化，只补结构共享。
- [`PreviewPanel.tsx`](../../src/components/layout/panels/PreviewPanel.tsx)：文件 Artifact 能力应保留，与 live app preview 并列。
- `same-runtime-multi-model-subagents.md`：Sub-agent 设计 / 交接基线；必须继续用源码、测试和真实 Provider 证据校验，不能单独作为可用性证明。
- [`mobile-remote-control-overall-plan.md`](./mobile-remote-control-overall-plan.md)：Remote Core 方向正确，但需以实际源码状态重新标记阶段。

## 18. 许可证与复用边界

T3 Code 是 MIT，概念、算法和源码都可以参考或复用；若复制实质性源码，仍必须保留 T3 的版权与 MIT 许可声明。CodePilot 当前是 BUSL-1.1，这不妨碍纳入 MIT 代码，但不能因为目标仓库许可证不同就删除上游 notice。

工程上更现实的做法是：

- checkpoint hidden-ref 流程、scope map、contract shape 可以近距离适配；
- `DrainableWorker`、`KeyedCoalescingWorker`、connection supervisor、Provider registry 大量依赖 Effect，应移植语义和测试，不要为了复制几份代码把 Effect 引入 CodePilot 主链；
- 对直接复制的文件建立 `THIRD_PARTY_NOTICES` 或文件头 attribution；
- 不把整个 `资料/t3code` 当 vendor dependency 或打包资产。

## 19. 最终判断

如果只选一项，选 **统一工作区 checkpoint + 每轮 diff/安全回退**：它能同时提升信任、审查、撤销、Sub-agent 归属、远程结果摘要和未来 PR 工作流。

如果选一个针对现有能力的连续三步路径，建议是：

1. checkpoint / diff / safe restore；
2. Runtime command receipt + lifecycle control plane；
3. task outcome surface + worktree isolation。

这三步完成后，CodePilot 才拥有更可信、状态边界更清楚的执行 Host。随后再接 shared connection runtime、配对权限和 mobile，投入不会被第二套临时协议吞掉。终端与 live app preview 应作为独立产品分支评估；若决定建设终端，应从真实入口 + PTY + server-owned session 起步，不要把遗留 pipes 骨架短暂接回 UI 当成完成。

T3 Code 给 CodePilot 的最大启发不是“功能更多”，而是：**会话、工作区和远程连接，以及未来若建设的终端、浏览器，都必须是后端持有、可重连、可审计的资源；UI 只是它们的一个视图。** 这条原则与 CodePilot 源码 / 计划中持续处理的 stream owner、Sub-agent durable lifecycle、Bridge 状态分裂问题同源，值得成为后续优化的总架构约束；是否真正解决仍要由 E3/E4 验收裁决。
