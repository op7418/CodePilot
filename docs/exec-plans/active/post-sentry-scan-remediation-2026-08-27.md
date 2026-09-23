# 2026-08-27 Sentry 生产问题修复闭环

> 创建时间：2026-08-27
> 最后更新：2026-09-18
> 当前状态：Shipped — 原修复随 v0.67.11，保存失败/快捷建议及后续修复随 v0.67.16 发布；最终全量 5584 pass / 1 skip、保存提示 UI 5/5；初始 DB 空读、Windows EOF 与生产停增验证仍开放。

## 状态

| Phase | 内容 | 状态 | 备注 |
|---|---|---|---|
| Phase 0 | 只读 Sentry 取证与源码根因核对 | ✅ 已完成 | 以 2026-08-23 为增量边界；未修改 Sentry/GitHub 外部状态 |
| Phase 1 | updater Promise 所有权与 utility 生命周期分组 | ✅ 已完成 | Main 显式消费 nested download Promise；Windows teardown zero-event、app-alive 仍 recovery，真实退出按 class 分组 |
| Phase 2 | token usage 运行时校验与 assistant 消息原子持久化 | ✅ 已完成 | 缺字段隐藏且不补 0；insert/update/select 同事务、空读稳定失败并回滚 |
| Phase 3 | media 用户错误分类与本地路径脱敏 | ✅ 已完成 | expected/user-action 保持 tool error；自动 Sentry zero-Issue；普通文本路径整段脱敏 |
| Phase 4 | targeted/full/build、复审与文档回写 | ✅ 已完成 | 首轮 targeted 91/91；复审 targeted 83/83；final full 5406（5405 pass/1 skip）、production build、scoped ESLint、hook/docs-drift/diff pass |

## 用户结果

- 自动更新下载遇到断网/连接重置时不再产生未处理 Promise rejection，仍按现有错误状态与退避策略恢复。
- Windows 注销/关机导致的 utility 生命周期不会再冒充产品崩溃；真实异常仍保留按 generation 一次的低敏诊断。
- 历史或第三方 Runtime 写入不完整 token usage 时，消息仍正常显示，只隐藏没有真实来源的 token 统计。
- assistant checkpoint/终态写入以单次事务返回真实行；若数据库不满足持久化不变量则明确失败，不在下游以 `undefined.id` 二次崩溃。
- 图片配置、计费、安全审核和不存在的媒体路径继续作为工具错误反馈给模型/用户，但不再被自动通道灌入 Sentry；本地路径不再保留用户名后的目录结构。
- 本轮明确不做：不推测或修改数据库最初损坏原因；不全局关闭 GPU；不在缺少组件证据时猜修 React ref 循环；不 resolve 历史 Sentry Issue，不 push/tag/发版。

## Signal → Triage → Fix → Verify → Guardrail

### Signal

- `CODEPILOT-DESKTOP-3V`：`electron-updater@6.8.3` 的 `checkForUpdates()` 返回未被消费的 `downloadPromise`，网络失败落入全局 unhandled rejection。
- `CODEPILOT-DESKTOP-25`：同一 normalized fingerprint 混入普通 `exit 1`、Windows shutdown/logoff 与其他平台退出状态；最近样本不支持统一归因为 OOM。
- `CODEPILOT-DESKTOP-A`：DB `token_usage` 只做 JSON parse 后即以 TypeScript 类型断言使用，缺字段在 `toLocaleString()` 崩溃。
- `CODEPILOT-DESKTOP-3Z`：terminal assistant insert 后二次 SELECT 可能返回空，调用方再读取 `saved.id`。
- `CODEPILOT-DESKTOP-3Y/3X/3T/2J`：media tool 的 expected/user-action 错误被 Vercel AI 自动通道捕获；路径 sanitizer 只隐藏用户名，仍暴露目录后缀。

### Triage

1. updater 必须显式拥有 auto-download Promise，不能只依赖 emitter；同一失败仍只能增加一次 backoff。
2. utility telemetry 必须在上传前识别已知 Windows shutdown lifecycle，并让 fingerprint 至少区分稳定退出类别，但仍禁止 raw stderr/report/path；exit code 只决定 telemetry，不得绕过 app-alive 的 bounded recovery。
3. token usage 是 DB 外部输入，必须用运行时验证证明必需数字存在；缺证据时隐藏统计，不补 0。
4. `addMessage` 的 insert + session timestamp + row read 必须在同一同步 SQLite transaction 内完成并验证返回行；调用方不再依赖不真实的类型断言。
5. media expected failure 在 tool boundary 写 shared handled marker，使 framework auto-capture 丢弃 rich error；marker 必须有界穿透常见 `cause` wrapper，取消只接受明确信号；错误本身继续 reject，保留真实 tool failure 语义。

### Fix

- [x] 消费 `checkForUpdates()` 返回的 auto-download Promise，并补行为/源码合同测试。
- [x] 为 utility exit 建立低基数 exit class 与 expected-shutdown zero-event 判定；更新 Main 接线、sanitizer 和回归测试。
- [x] 新增 token usage parser/validator；MessageItem 仅在输入/输出 token 都是有限非负数时展示。
- [x] 将 `addMessage` 改为事务内 insert/update/select，并对不可能的空读抛稳定产品错误；覆盖真实行返回与失败整体回滚。
- [x] media tool catch 在 rethrow 前标记 provider/user-action 错误已由产品拥有；新增缺配置、4xx、安全/计费与文件不存在的 zero-Issue 对照。
- [x] sanitizer 将 POSIX/Windows 用户目录整体替换为固定 `[local-path]`，不保留后缀；更新 fixture 和 guardrail。
- [x] Claude review P2：handled marker 增加 bounded/cycle-safe `cause` 追踪；真实 Node Sentry transport 验证 wrapped handled error 0 event、wrapped 503 1 event。
- [x] Claude review P3：恢复不再被 teardown exit code 短路；media cancel 改为显式 abort/专用类型；updater 补 emitter-first / Promise-first exactly-once + no-unhandled-rejection 行为测试。
- [x] 复跑 targeted、`npm run test`、`npm run build`、docs/diff 门禁并回写最终证据。

### Verify

- Targeted：updater contract、utility telemetry/recovery、token usage、collect owner/DB isolation、media tool、telemetry sanitizer/provider marker。
- Full：`npm run test`。
- Build：`npm run build`；Electron packaged smoke 仅在本轮改动要求且环境允许时执行，不用源码测试冒充真包。
- 发布后：下一个 stable release 按单 release + production 观察对应 Issue 是否停止新增；当前任务不发版。

### Guardrail

- `Updater.md` 固化 auto-download Promise 所有权。
- `ElectronMain.md` / `SentryTelemetry.md` 固化 expected shutdown 与 utility exit-class grouping。
- `StreamSession.md` 固化 DB token usage 的运行时 shape 与 assistant insert 返回行不变量。
- 同类 media expected-error 自动 capture 与路径后缀泄漏加入 Sentry telemetry 合同与测试。

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|---|---|---|---|---|---|---|---|
| 2026-08-27 | Sentry API | official `codepilot-desktop` | `codepilot@0.67.x` | 本地只读 token | 增量 Issue、去敏栈帧、utility 退出码与内存样本 | ✅ 只读取证完成 | 未修改外部状态；根因与代码位置写入本计划 Signal/Triage |
| 2026-08-27 | local Node/Electron source | local checkout | current | 无真实用户凭据 | updater/utility/token/DB/media/sanitizer targeted | ✅ | `npx tsx --test ...`：91 tests pass；恢复原有 message persistence 覆盖后单文件 12 tests pass |
| 2026-08-27 | local Node/Sentry SDK | local checkout | current | 无真实用户凭据 | Claude review：wrapped media zero-event、503 阳性、updater 双竞态、utility recovery | ✅ | 复审 targeted：83/83；真实 transport 按 envelope item type 统计 error event，handled wrapper 0、503 wrapper 1；updater 两种顺序均一次失败且无 `unhandledRejection` |
| 2026-08-27 | local Node/Electron source | local checkout | current | 无真实用户凭据 | Claude review 后 Tier 2 final full + production build | ✅ | `npm run test`：5406 tests，5405 pass / 1 existing skip / 0 fail；`npm run build` 成功（1 条既有 NFT dynamic-path warning）；本轮全部 TS/TSX scoped ESLint 0 error / 7 个 `MessageItem.tsx` 既有 warning，`lint:hooks`、`lint:docs-drift`、`git diff --check` 通过 |
| 2026-08-29 | official stable | Sentry production | `codepilot@0.67.11` | U0 opt-in | 新 release cohort 是否停止新增对应 Issue | 🟡 Release 已发布；cohort 观察待进行 | [Actions](https://github.com/op7418/CodePilot/actions/runs/33230535883) / [Release](https://github.com/op7418/CodePilot/releases/tag/v0.67.11)；发布成功不等于对应 Issue 已停增，需等待生产事件窗口 |

## 决策日志

- 2026-08-27：用户在只读根因报告后明确授权“修一下”。本轮只修能够由生产证据和当前源码闭环的缺陷；数据库最初损坏、Chromium GPU 与缺少具体组件的 React ref 循环保持诊断状态，不用猜测改动扩大风险。
- 2026-08-27：utility 组被证实是异质集合，不按 Issue count 直接判断同一产品崩溃；修复目标是 expected lifecycle zero-event、稳定 exit class 分组和保留低敏本地诊断，而不是吞掉真实 `exit 1`。
- 2026-08-27：全量前 diff 审核发现新增事务测试一度覆盖同名既有结构化消息测试；在门禁前恢复全部旧用例并追加事务探针，最终该文件 12/12、全量 0 fail。
- 2026-08-27：首次 production build 被 `.next/dev/lock` 安全门禁拒绝；锁内 PID 21511 已不存在且 localhost:3000 无响应，确认 stale 后只移除该精确锁文件，重跑 build 成功。未停止用户进程、未删除其他 `.next` 内容。
- 2026-08-27：全仓 `npm run lint` 意外递归扫描未改动的 `.claude/worktrees/decouple-claude-code/.next` 大型生成 bundle，连续数分钟只有 Babel/旧 `eslint-env` 警告且未进入源码终态，故中止该无效扫描；改为对本轮全部 TS/TSX 文件精确运行 ESLint并通过。全量 typecheck/unit/build 由独立门禁覆盖。
- 2026-08-27：Claude 复审的 P2 成立：原测试只证明同一异常对象上的 marker，不能证明框架用 wrapper/cause 时 `beforeSend` 仍会丢弃。修复选择 bounded own-data `cause` traversal，并补真实 `@sentry/node` transport 阳性/阴性对照。首版测试把被丢弃事件产生的 `client_report` envelope 误计为 error event；随后按 envelope item type 只统计 `event`，既保留 SDK 丢弃报告，也精确验证 zero-Issue 合同。
- 2026-08-27：Claude P3-2/3/4/6 作为防回归一起收口：teardown code 不再独占 recovery 决策；模糊“aborted”文本不再等同用户取消；`retryExhausted:true` 文档化为 media tool 当前终态边界；updater 从源码正则升级为两种竞态的行为测试。P3-5 的路径尾部丢失是 ST-17 已明确接受的隐私优先取舍：普通 message 不保留本地项目/文件名，stack/debug_meta 仍走独立 canonicalization 保留 symbolication 结构。
- 2026-08-27：final full 首次复跑在 typecheck 阶段发现新 transport 测试的 `reduce` accumulator 被推断为 `unknown`；仅为测试类型缺口，显式指定 `number` 后从头重跑 `npm run test`，最终 5406/0 fail。该失败不被从证据中省略，也不把修复前 targeted 通过冒充 final full。
- 2026-08-28：代码与 guardrail 以 commit `424f566f` 提交；pre-commit 再次完成 code tier 门禁：5406 tests，5405 pass / 1 existing skip / 0 fail。Claude review 的 P2 与可执行 P3 均有实现或测试证据闭环；仍保留发布后 official stable cohort 观察，不把本地验证冒充生产停增。
- 2026-08-29：修复随不可变 `v0.67.11` 正式发布；run `33230535883` 全绿，Latest Release 与 20 个公开资产完成独立复核。该证据把“待发布”推进为“stable cohort 可开始观察”，但在新的生产窗口形成前不宣称 Sentry Issue 已停增。


## 2026-09-06 新版生产复查（开放 follow-up）

用户要求检查 Sentry 上新版报错，本轮仅查询及源码诊断，未获产品代码修改授权。直接查询 Sentry API，最新 release 为 `codepilot@0.67.15`；Issue 查询覆盖 14d、不限制状态，再按相同 release + `production` 分页枚举事件。以下为查询时快照，时间为 UTC，事件区间 2026-09-05 14:08:56 至 2026-09-06 12:43:31；共 8 组、93 条，全部 unresolved。次数由 release-filtered events 得出，未使用跨版本的 Issue lifetime count。userCount=0 不代表没有受影响用户，当前不能确定独立用户数或故障率。

| Issue | 本版事件数 | 本版首次 / 最后（UTC） | 平台与判断 |
|---|---:|---|---|
| [4T](https://codepilot-rg.sentry.io/issues/7715120873/) | 6 | 09-06 10:39:40 / 12:20:37 | Windows x64；消息保存失败，unhandled rejection；本版首次出现的分组 |
| [F](https://codepilot-rg.sentry.io/issues/7648739372/) | 3 | 09-05 14:37:03 / 09-06 12:43:31 | Windows x64；write EOF，fatal、uncaught exception、next_server、POST /api/chat；旧组复发 |
| [20](https://codepilot-rg.sentry.io/issues/7677508289/) | 57 | 09-05 14:13:33 / 09-06 12:37:32 | Windows 51 / macOS 6；Provider unknown；最新样本为 memory-extractor → text-generator |
| [21](https://codepilot-rg.sentry.io/issues/7677511240/) | 20 | 09-05 14:08:56 / 09-06 12:19:27 | Windows 17 / macOS 3；19 条 quick-actions，1 条 skills/search |
| [23](https://codepilot-rg.sentry.io/issues/7677639113/) | 3 | 09-05 14:41:23 / 09-06 12:17:56 | Windows 1 / macOS 2；最新样本为 memory-search-mcp rerankWithAI |
| [2B](https://codepilot-rg.sentry.io/issues/7678353920/) | 1 | 09-05 16:15:57 / 同时 | macOS；managed / openai-compatible，上游 5xx |
| [9](https://codepilot-rg.sentry.io/issues/7648286666/) | 2 | 09-05 14:35:23 / 15:23:51 | macOS；NATIVE_STREAM_ERROR，最新样本经过 OpenAI Responses / ai-provider fetch |
| [3C](https://codepilot-rg.sentry.io/issues/7686218886/) | 1 | 09-05 14:23:17 / 同时 | macOS；NATIVE_STREAM_ERROR，最新样本为 undici Fetch.onAborted |

### 判断与取舍

- **P1 / 4T，开放**：样本 `315f0c889e7b4f9fa39b43f2f1aabbd3` 定位到 `db.ts:3810` 的事务内 INSERT 后 SELECT 空读检测，调用来自 `chat-collect-stream-response.ts:484` 的 catch 内兜底 `persistTerminal`。该兜底再次抛错后，`src/app/api/chat/route.ts:961` 的后台 `collectStreamResponse(...)` 没有 Promise rejection owner，解释了 unhandled rejection。用户风险是助手回复未持久化、刷新后缺失。事务检测在 v0.67.11 已加入，不能把“新分组”直接定性为 v0.67.15 新回归，也不能据此断言 SQLite 损坏或并发是初始根因。
- **P1 排查 / F，开放**：3 条都在 Windows 聊天请求的 next_server 被标记 fatal/uncaught；样本 `09812e83ca2948fb9b40d823a0561874` 仅保留 Node WriteWrap.onWriteComplete。存在服务中断风险，但没有进程退出或 recovery 证据，不能宣称已证实 3 次整机客户端崩溃，也不能猜定为某个 CLI stdin。
- **P2 / Provider 分类，开放**：20/21/23 共 80 条，均 environment + anthropic、status.class=none、needs_classification=yes；最新样本与源码说明涉及辅助 AI 功能，quick-actions 会回退静态建议，memory rerank 会保留原排序。不能将 80 条直接等同 80 次主聊天失败，亦不能在无状态码/原因证据时判断密钥失效、余额或模型错误。需保留低敏原因码并核对这些辅助调用的 provider 选择与恢复反馈。
- 2B 为有明确分类的上游 5xx；9/3C 共 3 条原生流错误仍缺具体低敏原因。仅凭本轮事件不能证明与 TokenDance 接入有关，也没有使用分母证明版本整体变差或变好。

### 后续执行清单

- [x] Signal / Triage：直接 API 核对 release、完整分页事件、每组最新样本位置及当前源码；完成只读取证。
- [ ] 4T：为后台 collector 明确 rejection 所有权，失败后通知/刷新恢复语义必须真实；补“首次保存及兜底保存均失败”的行为回归，验证 lock 清理、无 unhandled rejection、不会显示保存成功。继续采集低敏 DB 诊断定位最初空读原因，不删除用户数据库、不吞掉持久化失败。
- [ ] F：以低敏 I/O 来源、子进程生命周期和 recovery 证据确认写入端，再做 Windows 断管行为回归；不全局忽略 EOF。
- [ ] Provider：补安全分类证据、核对辅助调用选择与 fallback；不恢复 raw responseBody、凭据或用户内容上报。
- [ ] Fix / Verify / Guardrail：尚未实施，本轮未运行产品测试或真实用户 smoke，未修改 Sentry 状态、未发版。

决策记录：2026-09-06，原 Phase 2 的事务不变量和本地测试证据仍有效，但本版 4T 证明不能宣称消息持久化生产问题关闭。上述 follow-up 保持开放，先处理持久化和 Windows 未捕获 I/O，再收敛辅助 Provider 错误分类。


## 2026-09-07 根因复核与启动会话分母

用户要求继续核对比较确定的原因，并给出这段时间的启动次数。本轮仍为诊断，不修改产品代码或外部状态。

### 启动统计（北京时间）

事实源：Sentry `/api/0/organizations/codepilot-rg/sessions/`，project `4511841643200512`，environment `production`，field `sum(session)`，groupBy `release` + `session.status`，interval `1h`。各状态相加，不使用 unique users。按 API 实际返回的 start/end 记录整点窗口；不把窗口外事件直接除以这些数。

| 窗口 | 0.67.15 | CodePilot 命名版本合计 |
|---|---:|---:|
| 09-05 19:00 至 09-06 21:00（覆盖上一轮扫描，向整点对齐） | 149 | 265 |
| 09-05 19:00 至 09-07 13:00 | 295 | 504 |
| 08-31 13:00 至 09-07 13:00（完整 7 天） | 306 | 2445 |

近七天该项目还有改名 release 的 6 次上报，项目不区分 release 名称总数为 2451；上述 2445 只合计 `codepilot@` 命名版本，不宣称验证了每个安装包的来源。0.67.15 七天值比 09-05 19:00 起的窗口多 11，说明存在该窗口前的同名版本 session；不能仅凭 release 创建时间推定每条 session 都属于正式发布后的用户启动。

口径由 `electron/main.ts:47` 的 `mainProcessSessionIntegration({sendOnCreate:true})`、`telemetry/contract.ts` 默认实例替换和所安装 SDK 的 `main/integrations/main-process-session.js` 验证：一个 Electron Main 生命周期创建一个匿名 session，创建即发送。它不是窗口打开次数、请求次数或独立用户数；只代表成功送达 Sentry 的启用遥测启动，关闭遥测/未送达不可见。本轮 0.67.15 的 session 状态均为 healthy，但 next_server 错误不等同 Electron Main session 状态，不能据此宣称没有聊天故障或计算 100% 产品健康率。

API 窗口规则参考：https://docs.sentry.io/api/releases/retrieve-release-health-session-statistics/ 。

### 更确定的原因与验证边界

1. **4T 的错误处理缺口已行为复现**：在独立临时 DB 中运行真实 `collectStreamResponse`，用仅测试的 AFTER INSERT trigger 删除助手行来注入“事务内回读为空”。普通路径保存 1 行；故障路径首次/兜底保存均失败，collector 以 `CODEPILOT_MESSAGE_PERSISTENCE_FAILED` reject，数据库没有助手行。当前 route 后台调用未 await/catch，与线上 unhandled rejection 一致。**同时纠正潜在扩大解释**：该复现中 finally 回调执行一次并正常释放 lock，不能断言本问题必然造成锁不释放/下一轮卡死。trigger 只是故障注入手段，不是用户库存在 trigger 的证据；最初空读原因仍未确定。
2. **辅助 Provider 失败的调用场景已由线上 extras 直接确认**：最新 20 样本 callScene=`automatic_memory_extract`，21=`automatic_quick_actions`，23=`active_turn_memory_rerank`；都是 `provider.class=environment`、anthropic、status.class=none。可以确认辅助调用失败，不能确认认证/计费/模型/代理究竟是哪一种。quick-actions 源码仅成功后写入 10 分钟缓存，失败返回静态建议但不记录冷却，后续请求会再次尝试——这是明确的重复失败放大条件，不能凭没有用户身份的遥测断言全部重复来自同一用户。
3. **F 的初始写入端仍未定位**：新版次数由上一轮 3 增为 9，最新 09-07 10:39:09（北京时间）；最新样本没有 child_process breadcrumb。Codex transport 源码存在 stdin 异步错误所有权疑点，但缺少事件到 transport 的连接证据，不能将这些 EOF 全部归因为 Codex；保持开放诊断。

本次关键组实时复核（约 09-07 13:35，北京时间，非上表 13:00 截止窗口）：4T=6（未增加），F=9，20=96，21=28，23=6。仅复核这五组，不将这些数称为新版全部错误总数。

验证记录：`CODEX_DISABLED=1 node --import tsx --test /tmp/codepilot-persistence-diagnosis.test.ts`，2 tests pass；使用项目 db-isolation preload，未读取/修改真实用户数据库。最初 tsx CLI 因沙箱 IPC listen EPERM 未运行测试，改为 Node `--import tsx` 后通过；没有放宽沙箱或将环境错误当产品失败。两条测试分别覆盖正常保存与注入回读为空后的 rejection/无保存行/cleanup，证明错误处理路径，不证明最初 DB 空读诱因已复现。产品代码未改，未运行 full suite 或 Windows packaged smoke。


## 2026-09-07 确定性问题修复（用户授权）

用户明确要求“修复一下确定性的问题”。只实施已有事件/源码/复现证据支持的 collector rejection 所有权与 quick-actions 重复失败放大；不推测初始 DB 空读和 Windows EOF 的来源。既有 SQLite 原子事务保持 fail closed，不用吞错或假行掩盖失败。

用户可验收结果：助手回复无法确认保存时，当前聊天显示复制内容后再恢复的提示；后台失败仍可观测、无 unhandled rejection，客户端关闭不会取消服务端保存。快捷建议失败时仍返回静态建议，一分钟内不重复请求模型，同 workspace 并发请求共享一次生成，之后可恢复。

| Phase | 内容 | 状态 |
|---|---|---|
| F1 | collector Promise owner、SSE 保存确认错误、双语提示与安全上报 | ✅ 已完成（Code complete） |
| F2 | workspace-scoped 建议缓存、失败冷却与并发合并 | ✅ 已完成（Code complete） |
| F3 | 行为回归、全量测试、实际 UI 验证与文档同步 | ✅ 已完成（Tests pass；mock SSE 页面验证通过） |

- [x] F1：接住后台 collector 拒绝，SSE 在保存结算前不关闭；失败时发送稳定错误码并映射双语提示，保留一次安全遥测。
- [x] F2：成功缓存 10 分钟、失败冷却 1 分钟、相同 workspace 合并 in-flight；workspace 切换不复用旧建议。
- [x] F3：正常保存、首次/兜底保存失败、客户端 detach、failure reporter 失败、冷却边界、并发与 workspace 切换行为回归；full tests、实际用户提示验证、guardrail 回写。

决策：修复保存失败后的错误处理及用户反馈，不声称修复最初数据库空读。错误事件次数不能用吞掉异常降低；显示提示不等于回复已持久化，文案必须明确该限制。失败冷却选择 1 分钟以限制重复错误，同时允许用户修正 Provider 后短时间内恢复。

### 修复验证与决策日志

- 2026-09-07（工作区未提交）：`observeChatCollection` + `createChatCollectionResponse` 明确后台错误归属和 SSE 终态；双入口共同映射错误，首条失败保留当前正文不跳转。Quick-actions 复用单 workspace cache slot，failure/empty 60 秒、成功 600 秒、并发 single-flight。没有修改 DB schema/事务、Provider 选择、模型或原始错误分类规则。
- 定向首轮 37/37，覆盖真实 collector + 临时 DB 故障注入、正常路径、延迟保存结算、客户端 detach 与报告回调失败；后续真实 Sentry transport 和 dev-guard 定向通过，验证 stable 一次安全上报、dev/preview zero-event、不含测试 SQL/消息敏感标记。
- `npm run test` 最终 5554 tests：5553 pass / 1 existing skip / 0 fail，typecheck 与 harness boundary 同时通过。首轮 10 fail 中 2 为新增 telemetry import guard 写法不合编译合同（已修复），8 为沙箱禁止本机监听；第二轮暴露 guard 顺序导致 TS narrowing 冲突（已调整），最终在允许本地回环监听的执行环境完整复跑通过，测试 DB 始终隔离。
- Scoped ESLint：0 errors / 7 个既有 warning（chat route 未使用变量与首条页面 hooks dependencies）；本次未扩大到无关清理。Next dev 自动增加的临时 E2E tsconfig include 在核对无其他更改后恢复。
- Playwright `chat-save-warning.spec.ts`：3/3（20.2s）。前两次 fixture 缺少项目目录、未显式选择有测试凭据的 Provider，未触发发送；补齐实际 UI 前置后通过，没有放宽产品 gate。以下仅为 mock SSE 用户反馈验证，不冒充真实 Windows 空读诱因、真实模型或上线停增 smoke。

| Date | Runtime / Provider | 场景 | Result | Evidence |
|---|---|---|---|---|
| 2026-09-07 | 本地 Next dev / 隔离 DB / mock chat SSE | 首条保存失败：中文正文和复制提示可见、停留原页；已有聊天：英文提示可见；正常首条：仍跳转 | ✅ UI 3/3 | `npm run test:e2e -- chat-save-warning.spec.ts --workers=1 --reporter=line`；`/tmp/codepilot-save-warning-new.png` 目视确认，existing 同场截图；未调用真实模型 |
| 2026-09-07 | 本地 Node / 真实 collector / 临时 SQLite | 正常保存与首写/兜底保存都失败；无假保存行、一次 cleanup、lock 释放、单次错误归属 | ✅ 定向与 full 通过 | `chat-collection-response.test.ts`；full `/tmp/codepilot-sentry-full-final.log` |

剩余开放项：4T 初始空读原因、F 的 Windows 写入端、辅助 Provider 的具体 upstream 原因，以及发布后的 production cohort 验证。旧“4T 修复”清单中的错误处理/客户端反馈/行为回归部分已由 F1/F3 完成；初始 DB 诊断项继续开放，因此不将整个旧条目或此计划关闭。发版未执行。

### Claude 独立审查 follow-up（2026-09-07）

Signal：用户回传 Claude `Review passed with findings`，独立 full 5553 pass / 1 skip、mock SSE UI 3/3。核对源码后接受两个 P2：SSE 关闭等待整个 collector finally，导致 onboarding/check-in 模型与通知延迟进入前台；首条未保存后继续发送会新建 session 并覆盖正文。本轮在已有“修复确定性问题”授权内完成必要修复闭环。

| Phase | 内容 | 状态 |
|---|---|---|
| R1 | 分离 persistence settled 与后台 finally，保留完整 rejection owner | ✅ 已完成（Code complete / targeted pass） |
| R2 | 首条失败使用同一 session 继续，保留内存正文；长聊天不以 DB 覆盖未确认正文 | ✅ 已完成（Code complete / UI 5/5） |
| R3 | 固定码本地日志、回归测试、全量/UI 验证、guardrail 回写 | ✅ 已完成（Tests pass / UI 5/5） |

- [x] R1：独立保存信号只表示 terminal persistence 结算，后台任务失败不能反向将已保存消息标为未保存；覆盖慢 finally 和 finally 抛错。
- [x] R2：失败首条交给同 session 的 ChatView 继续，沿用 route/权限/Stop 的现有契约；明确 renderer-only 未确认标记，防止恢复/裁剪后 reconciliation 覆盖正文。
- [x] R3：dev/preview/遥测关闭时也有固定低敏本地错误码；targeted、full、后续发送 UI 回归与文档同步。

取舍：不把 onboarding/check-in 改成无人拥有的异步任务，也不在新建页另造一套已绑定聊天的路由切换逻辑。P3-3 单 workspace 槽的 A→B→A 并发边界保留为已知限制（single-flight 只对当前槽成立）；不扩展成无界多 workspace cache。P3-4 文案继续使用“未确认保存”，不把 UI completed 当成已落库证明。


#### R1–R3 实施与验证记录

- 2026-09-07（工作区未提交）：R1 在 collector finally 起点发布独立 one-shot 保存结果，SSE 只等待此结果；整个后台 Promise 仍由 observe 拥有，前置异常用 false 兜底，晚到异常不能撤销 true。上报放在 try/finally 中，确保上报同步失败也执行锁资源清理。保留既有后台处理/锁收口时序，不声称解决后台处理期间的 session busy 或 onboarding 初始故障。
- R2 首条失败后在原页面挂载同 session 的 ChatView，重读 metadata 得到真实 binding/revision，不重读历史；Message 带 renderer-only saveUnconfirmed，后续成功仍保留正文。SSE raw code → snapshot → Message 逐层保留标记，离页完成后恢复走本地追加；修正 ChatView 首次 effect 重复写 initialMessages 会覆盖恢复追加的时序。
- P3-1：固定本地码在 dev/preview/遥测关闭时可用，不输出原始错误内容。P3-2：reconcile 的 state updater 内检查未确认标记，防止请求发出后到达的警告被晚到 DB 响应覆盖；UI 覆盖 30+3×100 条历史触发尾部裁剪，再发送失败及下一条成功。P3-3：当前单槽 A→B→A 不保证全局 single-flight，已同步 AssistantWorkspace guardrail，为有界缓存的已知限制。P3-4：不改变“未确认保存”文案和 completed 的运行终态语义。
- Targeted 最终 33/33（`/tmp/codepilot-review-targeted-final.log`）：真实 collector/SQLite 正常与双写失败、真实 onboarding processor 的模型 fetch 被阻塞但 SSE 已关闭、finally 的 getSession 在 onComplete 前抛错仍被拥有并释放锁且不误报保存失败、安全本地日志与 Sentry transport、双入口 parser 转发。慢模型 fixture 最初没有 activate provider，未进入模型请求而失败；补齐隔离 DB 的测试 Provider 启用后通过，没有放宽产品 Provider gate。模型请求由测试 fetch 拦截，不使用真实凭据或网络。
- UI 最终 5/5（26.3s，`/tmp/codepilot-review-e2e.log`）：new/existing/trimmed-existing/detached-existing 都在失败后继续同 session，前文及复制提示保留；healthy-new 正常跳转。第一轮续聊测试在 warning 最后一帧仍 streaming 时发送，调整为等待首轮结束；离页测试初次在 Settings 查找不存在的聊天侧栏链接而超时，改用浏览器返回后通过。保留这些失败原因，不作为产品故障关闭证据。`/tmp/codepilot-save-warning-new.png` 目视确认正文、中文提示、第二轮正文同时可见。
- Scoped ESLint 0 errors / 19 处既有 warning（扩大检查到 ChatView/collector/stream manager 后包含其既有 warning）；hook/docs-drift/diff 检查通过。测试生成的 tsconfig include 与格式变化经 JSON 比较，确认无其他语义改动后恢复。

| Date | Runtime / Provider | 场景 | Result | Evidence |
|---|---|---|---|---|
| 2026-09-07 | 隔离 SQLite + 真实 collector/onboarding processor + fake provider fetch | 保存确认与慢 finally 解耦；finally 异常不撤销保存且有清理 owner | ✅ targeted 33/33 | `chat-collection-response.test.ts`；fetch 未完成时客户端 EOF 已观察到 |
| 2026-09-07 | 本地 Next dev + 隔离 DB + mock chat SSE/history | 失败后第二条复用 session、长历史裁剪、离页恢复、正常首条对照 | ✅ UI 5/5 | `chat-save-warning.spec.ts`；未经过真实模型/Windows DB 故障 |

验证边界：Claude 原审查适用于 R1–R3 之前的 diff；本次 follow-up 尚待独立复审。UI `/api/chat` 仍由 mock SSE 提供，真实 Next Response/取消链、Windows packaged 故障、生产事件停增仍未验证；没有将这些缺口标记完成。初始 DB 空读、write EOF 写入端与辅助 Provider upstream 原因继续开放。

最终验证（2026-09-07，工作区未提交）：清理临时 tsconfig 后 `npm run test` EXIT=0，5556 tests / 5555 pass / 1 existing skip / 0 fail，typecheck + harness boundary 通过（`/tmp/codepilot-review-full-final.log`）；targeted 33/33，UI 5/5。R1/R2/R3 的实现、验证和 guardrail 已完成；没有执行 commit、push、tag 或发布。

## v0.67.16 发布回写（2026-09-18）

保存失败提示、持久化结果与后台处理解耦、正文保留及快捷建议退避随 `17c716c6` / `v0.67.16` Shipped。发版全量 5584 pass / 1 skip；隔离保存提示 UI 5/5（25.9s）；[正式 CI](https://github.com/op7418/CodePilot/actions/runs/35357476827) 与 [公开 Release](https://github.com/op7418/CodePilot/releases/tag/v0.67.16) 20 资产核验通过。没有修改外部 Sentry Issue 状态，也没有把初始 DB 空读或 Windows EOF 根因标成已解决；生产事件停增尚未观察。完整发布证据见 Gemini Native 计划的 v0.67.16 记录。
