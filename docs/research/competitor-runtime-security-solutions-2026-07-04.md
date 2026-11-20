# 竞品对 CodePilot 其他问题的更优解法(Runtime / 安全 / 状态,2026-07-04)

> 类型:竞品源码调研。承接 [competitor-chat-scroll-perf-2026-07-04.md](./competitor-chat-scroll-perf-2026-07-04.md)(那份只覆盖滚动/性能),本份覆盖 `docs/research/stability-fluency-runtime-audit-2026-07-04.md`（已删除，见 git 历史） 里**滚动/性能之外**的问题:stop/abort、turn 所有权、消息队列、新会话导航、工具错误、密钥加密、Electron 安全、崩溃恢复、能力建模。
> 版本:三个项目均已拉到最新(OpenCode `7a8e7c8`/2026-07-04、Codex `98d28aa`/2026-07-03、CraftAgent `v0.10.5`/2026-07-01)。所有竞品证据附 `文件:行号`,高价值迁移项已人工二次核读。

## 一个贯穿性根因(最重要的横向结论)

CodePilot 有一批看似孤立的 bug——排队消息丢失(1.5)、停止后卡死(phase 分裂)、turn 所有权缺失(1.2/1.9)——**根因是同一个:把会话级状态(队列、"是否在流式"、turn 句柄)放在了会按 `key` 重挂载的聊天组件本地,或放在只按 sessionId 索引、无所有权标识的注册表里。**

三家竞品**无一例外**把这些状态上提到会话级、并让后端持有"回合是否 active"的唯一真相:
- **CraftAgent**:后端 `ManagedSession.isProcessing`(唯一 setter `setProcessing`)+ Jotai `sessionAtomFamily`(前端流式状态 atom 化)。
- **OpenCode**:后端 `SessionStatus` map + 按 sessionID 分片的持久化 store。
- **Codex**:单一 `ChatWidget` + `Session.active_turn: Mutex<Option<ActiveTurn>>`,thread 切换显式快照/还原。

CodePilot 与 CraftAgent 架构相近(Electron + React + 每会话后端管理),**CraftAgent 的这些不变量方向上最贴合 CodePilot,可作移植蓝本——但不是直接复制 `SessionManager.ts`**:CraftAgent 后端在 Electron 主进程内、状态集中在单一 `SessionManager`;CodePilot 的对应状态分散在 Next route + runtime registry + DB lock + 前端 snapshot 四处,移植要把这些不变量分别落到这四层并保证一致,是一次有设计量的重写。下面分问题给证据。

---

## 二、逐问题:竞品更优解法 + 可迁移性

### 1. 停止/中断后卡死 + turn 所有权(audit §3 phase-stuck、1.2、1.9、codex-stop-recovery)

**CodePilot 病根**:前端"是否流式"只由 SSE 驱动;后端 watchdog 只 settle DB 锁、**不发终态事件**,两者分裂 → 停止后 UI 永远以为在流式。conversation 注册表只按 sessionId,旧回合 finally 误删新回合句柄。

**三家共识**:后端持有唯一真相,且**"清 active 状态"与"向 UI 发终态事件"是同一段代码的原子行为**;watchdog 超时也走同一出口,而非只清锁。

- **CraftAgent(架构最贴合,作移植蓝本)**:`SessionManager.ts:1169` `setProcessing` 是 `isProcessing` 唯一 setter;`onProcessingStopped(reason)`(:6203)是"清状态 + 发 UI 终态事件(`complete`/`interrupted`)"的**唯一出口**;5 秒 watchdog(`cancelProcessing` :6093)超时也调 `onProcessingStopped('timeout')`,不是只清锁。代码里甚至有注释 `:5954` "we no longer break early on !isProcessing"——刻意让所有路径收敛到同一出口。**turn 所有权**:`processingGeneration` 代际计数(:773 定义、:5645 每回合 `++`、:5666 快照 `myGeneration`),旧回合 finally 发现代际被抬高就不碰共享状态。**重连对账**:会话序列化带 `isProcessing`(`managedToSession` :1087),前端加载会话时从服务端真相收敛。
- **Codex(借两点语义)**:终态事件**必带 `turn_id`**(`tasks/mod.rs:891` `TurnAborted{turn_id}`),前端可据此丢弃过期回合的事件;中断令牌**真传播到模型请求**(`session/turn.rs:1963` 模型流用 `.or_cancel(cancellation_token)` 包裹),而非仅停止转发 SSE。所有权用 `Arc::ptr_eq(turn_state)` 指针身份(`tasks/mod.rs:787`)。
- **OpenCode**:Runner 单调递增 `run.id`,`finishRun` 只在 `id` 匹配时结算(`effect/runner.ts:76`)——过期 run 无法把新 run 拉回 idle。优雅但绑定 Effect 运行时,迁移成本高。

**判断**:三家都比 CodePilot 好。**迁移首选 CraftAgent 三件套**:①`isProcessing` 唯一 setter + 唯一终态出口 `onProcessingStopped(reason)`,watchdog 走同一出口;②`processingGeneration` 代际守卫;③会话快照带 `isProcessing` 供重连对账。**再从 Codex 借**:终态事件带 turn_id + 中断令牌真传到模型(对应 CodePilot 的 abortController 要真断底层 fetch,而不只是前端 abort)。→ 直接强化 codex-stop-recovery 的未闭环缺口。

### 2. 流式期间排队消息丢失(1.5)

**CodePilot 病根**:队列在聊天组件本地 state,组件按 key 重挂载即静默丢失。

- **OpenCode(明显更好,最值得抄)**:`pages/session.tsx:529` 队列 store 用 `persisted(Persist.serverWorkspace(...,"followup"), createStore<{items: Record<sessionID, FollowupItem[]>}>)`——**按 sessionID 分片 + 持久化(跨刷新/重载存活)**;`session.tsx:1796` 一个 `createEffect` 监听队首,idle 且未 paused/failed 时自动 `sendFollowup`;`session-followup-dock.tsx` 提供可见/可编辑/手动补发的 dock。
- **CraftAgent**:队列在后端(`SessionManager` 的 `messageQueue` + `processNextQueuedMessage` FIFO 重放),前端只调 `onSendMessage`;abort 时 `craft:restore-input` 事件按 sessionId 把未发消息还原回输入框(`ChatPage.tsx:243`)。
- **Codex**:`chatwidget/input_queue.rs` 队列挂在单 widget 上,thread 切换用 `capture_thread_input_state`/`restore_thread_input_state`(`input_restore.rs:342/387`)显式快照还原。

**判断**:三家都不丢。**迁移首选 OpenCode**:把本地 state 换成"按 sessionId 分片的持久化 store + idle effect 自动补发",顺带得到可见可编辑的 pending dock。

### 3. 新会话首轮导航劫持(1.4)

**CodePilot 病根**:/chat 页发首条时内联消费 SSE,完成后无条件 `router.push`,期间切走被拽回;abortController 无卸载清理。

- **OpenCode(明显更好,逐条对症)**:`components/prompt-input/submit.ts:281` `handleSubmit`——顺序是 `session.create()` **先建会话**(:364)→ `seed()` 塞进本地 store(:375)→ 导航(:382,有 draft 则走乐观 tab 提升不 navigate)→ **之后**才 `promptAsync` fire-and-forget 发送(:565),消息靠全局 SSE 回流,**不在页面组件内联消费 SSE**;abort 用 **module 级 `pending` map + AbortController**(:29/:524),有卸载清理。**没有"发完无条件 push"**——导航发生在发送之前且状态已 seed,切走不被拽回。
- **CraftAgent**:`NavigationContext.tsx:678` `'new-session'`——先 `onCreateSession`(:695)→ 原子导航(`updateFocusedPanelRouteAtom`,:736)→ 再 `sendMessage`(:754);URL 是 source of truth,导航不丢流式状态(在 atom)。

**判断**:两家都更好。**迁移首选 OpenCode 的 pattern**:`create → seed → navigate → promptAsync 异步发 + 全局 SSE 回流 + module 级 AbortController 清理`,正好逐条消解"内联 SSE / 无条件 push / abort 无清理"。

### 4. 工具执行错误不呈现(#49)

**CodePilot 病根**:native agent 循环吞掉 `tool-error` 事件,`execute()` 抛错时 UI 无错误气泡。

- **CraftAgent(最易迁,建立完整链路)**:事件层不吞——`event-processor/handlers/tool.ts:75` `handleToolResult` 显式判错(`isError===true || /^\s*(\[ERROR\]|Error:)/`,:83)写 `toolStatus:'error'`;乱序到达(无 tool_start)也直接从 result 造错误消息(:148)。渲染层 `InlineExecution.tsx` error 态:`XCircle` + "Failed" + 错误 markdown + **Dismiss/Retry 按钮**(:180)。
- **OpenCode**:`message-part.tsx:1528` `<Match when={status==="error"}>` → `<ToolErrorCard>`(可折叠 + **复制错误** + 智能解析);另有 `SessionRetry` 重试倒计时。
- **Codex**:工具失败必进 history(`chatwidget.rs:1417` `finalize_active_cell_as_failed` → 红 ✗),绝不吞。

**判断**:三家都比 CodePilot 好(都不吞)。**迁移**:CraftAgent 的"事件层强制 `status='error'`"补上 CodePilot 缺的那一环(agent-loop 加 `case 'tool-error'`),呈现可参考 OpenCode 的 `ToolErrorCard`(错误卡片 + 复制 + 重试)。

### 5. API key 明文存 SQLite(#40)

**CodePilot 病根**:provider api_key 明文进 SQLite,全仓无加密。

- **CraftAgent(可整文件搬,但非 keychain 级)**:`packages/shared/src/credentials/backends/secure-storage.ts`——AES-256-GCM 加密文件(`~/.craft-agent/credentials.enc`,0o600),密钥由**机器硬件 UUID**(macOS `IOPlatformUUID` / Windows `MachineGuid` / Linux `machine-id`)经 `pbkdf2Sync(...,100000,32)` 派生(:324),自带 v1→v2 迁移。纯 `node:crypto`+`fs`,零原生依赖、跨平台。**安全上限 = 防裸拷贝/跨机解密**(密钥可由同机同用户进程重算,防不住本地恶意进程)。
- **OpenCode**:明文 `auth.json` + chmod 0o600(`auth/index.ts:78`),**无加密**——不比 CodePilot 好多少(仅落独立文件优于塞 DB)。
- **两家都没用 Electron `safeStorage` 或 OS keychain。**

**判断**:CraftAgent 更好且可整文件搬。但**真正的 keychain 级是"竞品之上再进一步"**:建议主进程用 Electron `safeStorage`(底层 macOS Keychain / Windows DPAPI / Linux libsecret)——`safeStorage.isEncryptionAvailable()` 为 true 时 `encryptString(key)` 后 base64 存进现有 SQLite 列,`decryptString` 读取,加解密只在主进程;`isEncryptionAvailable()` 为 false(部分 Linux 无 keyring)时**回退 CraftAgent 式加密文件**。迁移:启动检测 schema flag,旧明文行读出→加密→回写→置 flag。

### 6. Electron IPC 安全:外链协议、任意写、sender 校验(1.1、1.6、1.7)

- **外链协议白名单(1.7)——搬 CraftAgent,别搬 OpenCode**:CraftAgent `packages/shared/src/utils/url-safety.ts` `classifyExternalUrl` 黑名单显式拦 `javascript:`/`data:`/`vbscript:`/`blob:`/`file:`(注释点名 `file:` 在 Windows 上 `openExternal` 可 RCE),配合 `window-manager.ts:273` `setWindowOpenHandler(deny)` + `will-navigate(preventDefault)` 三件套。零依赖纯函数,可整体搬。**OpenCode 的 `open-link`(`ipc.ts:168`)反而是裸 `shell.openExternal` 无白名单,与 CodePilot 同病,不要抄。**
- **文件写入路径(1.1)——两家都可搬**:OpenCode 无任意写 IPC,保存只 `dialog.showSaveDialog` **返回路径不写**(`ipc.ts:156`),读文件用一次性 token 授权(`attachment-picker.ts:6`,token+sender+确切路径三命中才放行)。CraftAgent 服务端 `validateFilePath`(`server-core/.../handlers/utils.ts:73`):`isAbsolute` + `realpath`(防软链逃逸)+ 目录白名单 + 敏感文件黑名单(`.ssh`/`.aws/credentials`/`.env`/`.pem`)。**最优组合:showSaveDialog 定路径 + `validateFilePath` 兜底。**
- **sender 校验(1.6)——竞品也没做精确 senderFrame 校验**,但都有隔离补偿:OpenCode `sandbox:true`+`contextIsolation:true`+`setPermissionRequestHandler` 白名单(`windows.ts:185/413`);CraftAgent 本地 WS + per-launch token 连接级认证。**迁移**:搬 OpenCode 的 permission 白名单 + CodePilot 自加统一 `assertTrustedSender(event)`(校验 `senderFrame` origin);并把 webPreferences 对齐 OpenCode 的 `sandbox:true`(比 CraftAgent 主窗口 `sandbox:false` 更硬)。

### 7. 后端子进程崩溃无自愈(1.8)

**CodePilot 病根**:Next server 跑 utilityProcess,运行期崩溃后不重启、白屏。

- **CraftAgent(最强,同栈可迁移)**:把易崩执行下推到**每会话一个的 agent 子进程**(`pi-agent-server`),崩溃隔离粒度细 → App 永不白屏。`handleSubprocessExit`(`pi-agent.ts:1692`):崩溃转成**会话内结构化 error 事件** + 拒绝所有 pending RPC + **lazy 重生**(下次使用才重建);**同错去重** `MAX_IDENTICAL_SUBPROCESS_ERRORS=3`(:188)防刷屏;传输层 `client.ts:782` **指数退避**(`min(1000*2^attempt, 30_000)`)+ 稳定 10s 后 attempt 归零(:804)+ `shuttingDown` 抑制重连风暴 + seq 续传 + 降级 banner(带 Retry/attempt/`retry in Nms`)。
- **OpenCode(骨架可搬,但同缺自愈)**:`server.ts:55` `utilityProcess.fork` + stall 超时(60s)+ stop 超时(6s)+ 健康探针 `/global/health`(:184);渲染端 SSE **重连循环**(`server-sdk.tsx:161`,250ms 固定)+ 心跳(15s)+ LoadingSplash + 手动重启。**但 `onExit` 只写日志、不自动重生**(`index.ts:339`)——和 CodePilot 同病,不能照抄补齐。
- **Codex**:`app-server-daemon` 用 PID 文件 + 操作锁 + `LifecycleCommand{Start,Restart,...}` + 探活做**幂等 ensure-running**(`lib.rs:37`),`RestartMode{IfVersionChanged,Always}`;解决"幂等拉起 + 防双实例/重启风暴",非运行期崩溃监督。

**判断**:**迁移首选 CraftAgent**——崩溃隔离到可弃可重生的每会话子进程 + 结构化错误 + 同错去重 + 指数退避重连 banner(而非白屏)。若 CodePilot 坚持保留 Next server 子进程,则叠加 OpenCode 的 spawn/健康探针 + Codex 的 PID/锁 ensure-running,**并补上 onExit 里的自动重生+退避**(这正是 OpenCode/CodePilot 都缺的那块)。

### 8. 能力(effort/thinking)不区分 runtime(#41)

**CodePilot 病根**:effort/thinking 是"模型级" flag;Native runtime 其实丢弃显式 effort,但 UI 仍显示选择器,只靠一次性 toast 补救(语义失真)。

- **OpenCode(架构上消灭这类 bug,理念最该抄)**:`native-runtime.ts:82-88` 注释明写——ai-sdk runtime 与 native runtime **消费同一份 `ProviderTransform.providerOptions`**,两侧都用 OpenAI 官方 wire 字段名(`reasoningEffort` 等),"**这是 identity 而非 translation**";native runtime **不会静默丢 effort**。runtime 无法支撑某配置时返回 `{type:"unsupported", reason}`(:59)触发**显式回退**,而非悄悄降级。集中 `ProviderCapabilities{reasoning,toolcall,attachment,modalities,interleaved}`(`provider.ts:977`)。
- **Codex(能力表最丰富)**:服务端下发的集中 `ModelInfo`(`protocol/.../openai_models.rs:354`),`supported_reasoning_levels: Vec<ReasoningEffortPreset>`(每档带 description),**空 Vec = 不支持**;UI 直接据此决定形态(`model_popups.rs:184` 只一档时不弹 effort 选择器);请求生成用同一份数据 gate(effort 为 `None` 就不下发 reasoning 对象)——UI 与请求参数**同源**,不会 UI 显示却 runtime 丢弃。
- **CraftAgent(同栈可迁移)**:显式 **backend driver 抽象**(`agent/backend/types.ts`,注释"Capabilities-driven UI");`thinking-levels.ts` 把 ThinkingLevel 按 provider 映射(Anthropic adaptive effort vs 非 Claude token 预算);UI 不支持时**禁用并明说**(`FreeFormInput.tsx:378` `thinkingDisabled` → `opacity-50` + `thinking.notSupported`),不是"显示了却静默丢弃 + toast";发送端 `filterAttachmentsForModelInput` 按能力丢不支持的图片。

**判断**:三家都比 CodePilot 好。**迁移**:抄 **OpenCode 的 identity 原则**(effort/thinking 收敛成一份 provider-option,所有 runtime 读同名键;不支持返回 `unsupported+reason` 显式回退)+ **Codex 的能力表结构**(per-model `supportedEfforts` 空则**隐藏**选择器而非禁用后 toast)。这正是 audit §3 #41 说的 "Runtime Capability Adapter" 的现成参考实现。

---

## 三、汇总与迁移优先级

| CodePilot 问题 | 最优参考 | 判断 | 可迁移性 |
|---|---|---|---|
| stop/abort 卡死 + turn 所有权 | CraftAgent(唯一终态出口 + 代际守卫 + 快照对账)+ Codex(turn_id/令牌) | 都更好 | **高**(架构贴合;需把不变量分层移植到 route/registry/lock/snapshot,非复制文件) |
| 排队消息丢失 | OpenCode(sessionID 分片持久化 store + idle 自动补发) | 明显更好 | 高 |
| 新会话导航劫持 | OpenCode(create→seed→navigate→promptAsync) | 明显更好 | 高 |
| 工具错误不呈现 | CraftAgent(事件层 status=error)+ OpenCode(ToolErrorCard) | 都更好 | 高 |
| API key 明文 | CraftAgent 加密文件(可搬)+ 自加 safeStorage(竞品之上) | 更好/差异化 | 中(safeStorage 需自建+回退) |
| 外链协议白名单 | CraftAgent `url-safety.ts` 三件套 | 明显更好 | 高(零依赖) |
| 文件任意写 | showSaveDialog + CraftAgent `validateFilePath` | 更好 | 高 |
| sender 校验 | OpenCode 权限白名单 + 自加 senderFrame 校验 | 略好 | 中 |
| 后端崩溃自愈 | CraftAgent(每会话子进程 + 退避重连 banner) | 明显更好 | 高(同栈) |
| 能力不分 runtime | OpenCode identity 原则 + Codex 能力表 | 都更好 | 中-高 |

**建议动手顺序(接 audit §5)**:
1. **stop/abort 三件套 + turn_id**——命中历史最高复发区,以 CraftAgent 的不变量为蓝本(唯一 setter + 唯一终态出口 + 代际守卫 + 快照对账),分层移植到 Next route/runtime registry/DB lock/前端 snapshot 四处(非复制 `SessionManager.ts`);与 codex-stop-recovery 未闭环缺口合并。
2. **外链白名单 + 文件写校验**——零依赖、见效快,搬 CraftAgent `url-safety.ts` + `validateFilePath`。
3. **排队消息 + 新会话导航**——都抄 OpenCode 的会话级持久化 store + `create→seed→navigate→异步发` pattern,一并消除"会话级状态放组件本地"这个共同根因。
4. **能力建模(#41 Runtime Capability Adapter)**——抄 OpenCode identity 原则 + Codex 能力表;effort 收敛成一份 provider-option。
5. **后端崩溃自愈**——补 onExit 自动重生+退避 + 降级 banner(参考 CraftAgent);或把易崩执行下推到每会话子进程。
6. **密钥加密(#40)**——safeStorage 优先 + CraftAgent 加密文件兜底,单独立项。

> 关键提醒:三家都**没用 safeStorage/keychain**(密钥),也都**没做精确 senderFrame 校验**——这两条是"竞品之上再进一步",不能指望直接抄。其余多数思路可从 CraftAgent(同栈,便于对照)移植——但"同栈"指语言/框架一致,落地仍需按 CodePilot 的 route/registry/lock/snapshot 分层重写,非整段复制。
