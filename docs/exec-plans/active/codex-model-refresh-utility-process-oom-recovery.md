# Codex Model Refresh × Utility Process OOM Recovery / 模型刷新异常与本地服务 OOM 恢复

> 创建时间：2026-08-10
> 最后更新：2026-08-12
> 优先级：P1（核心聊天、历史会话和文件树同时不可用）
> 计划状态：🟡 Code complete / Tests pass / Review passed / Crash smoke passed（本地范围；2026-08-11 review round 3 P1 闭环已过 Claude Code 复审。ad-hoc arm64 packaged 单次恢复、三次重启预算耗尽与 live-Codex blocked/quit-only smoke 均通过；2 条 P3 nit、active-turn UI、15/60 分钟 soak 与受影响机器 A/B 仍待跑，不能称完整 Smoke passed / 根因已修）
> 审查基线：`main@ff9dc316`

## 给 Claude Code 的审查请求（已完成）

本轮只审计划，不直接改产品代码。请重点挑战以下判断，并在计划中留下修订意见或明确接受理由：

1. `codex_models_manager` 的周期性 refresh timeout 是 OOM 的上游触发信号，还是仅为并行噪声。
2. Codex app-server stdout 的无界 partial-line buffer 是否可能承接超大/不完整 JSON-RPC frame，从而放大到 Next `utilityProcess` OOM。
3. Next child 崩溃后，Codex app-server / MCP 等孙进程是否可能存活；若不能证明不会残留，不能直接上自动重启。
4. recovery safe mode / warmup circuit breaker 应由 Electron Main、Next server 还是 Renderer 持有，才能跨 server 重启保留且不形成重启循环。
5. 本计划的 required checks 是否足够可量化，尤其是 packaged soak、进程唯一性、诚实中断语义和日志脱敏。

审查输出需要包含：事实偏差、遗漏风险、建议 round split、checks 可验收性，以及 `accepted` / `fix_requested` 结论。若建议改变默认 Runtime、权限、DB schema、日志安全边界或发布策略，必须标为 human decision，不得在实现轮自行扩大范围。

## 状态

| Round | Phase | 内容 | 状态 | 用户可见结果 |
|-------|-------|------|------|--------------|
| Round 1A（并行） | Phase 0 | 证据冻结与复现矩阵 | 🟡 本地数值观测已交付；事故归 F（未复现） | 新构建可同窗记录 host/utility/V8/frame/model-list 数值；受影响机器 A/B 仍需 human gate |
| Round 1B（并行） | Phase 2 | 本地服务崩溃后的独立错误页与安全恢复 | ✅ Code complete / Tests pass | Next 死亡时由 Main 加载独立恢复页，提供受控 retry/relaunch 与脱敏诊断复制 |
| Round 2 | Phase 1 | Codex transport 硬边界、wedged instance containment 与 warmup 熔断 | ✅ Code complete / Tests pass | 32 MiB 防御性 byte cap、RPC cancellation、single-flight/cooldown、idle recycle 与 safe-mode UI 已落地 |
| Round 3 | Phase 3 | 有限自动自愈与进程单 owner | 🟡 Code complete / Tests pass；packaged crash smoke 待跑 | 1s/2s/4s 有界恢复、health gate 和 current-generation registry 已落地；身份不明/残留一律 fail-closed |
| Round 4 | Phase 4 | Packaged soak、真实 Codex smoke、guardrail 与发布门禁 | 🟡 自动 gates + packaged server health 通过；长时/崩溃 smoke 待跑 | 产物 server 可启动，但尚未证明真实 UI crash recovery、Codex 长时内存曲线或受影响机器不复发 |

## Signal：用户实际看到的问题

2026-08-10 用户反馈最新版 macOS 客户端出现：

- 点击历史对话后中心区域显示 `Failed to fetch`。
- 文件树同时显示 `Failed to load file tree`。
- 再次进入历史对话或刷新后，窗口只剩透明/灰色背景。
- 完全退出并重开后短暂恢复，但随后再次出现。

用户提供的脱敏主日志记录了四次同形崩溃（日志时间为 UTC）：

| 时间 | V8 崩溃前内存摘要 | 进程结果 | 后续表现 |
|------|------------------|----------|----------|
| 15:07:03 | Scavenge `357.9 (428.9) MB` | server exit `5`，`child-process-gone type=Utility reason=crashed` | `ECONNREFUSED`，chat URL 加载失败 |
| 15:08:22 | Mark-Compact `366.2 (428.2) MB` | 同上 | notification poll 持续拒绝连接 |
| 15:11:47 | Mark-Compact `360.0 (364.1) MB` | 同上 | 本地 API 全部失活 |
| 15:19:14 | Mark-Compact `359.1 (364.4) MB` | 同上 | 同一 chat URL `ERR_CONNECTION_REFUSED` |

四次共同 fatal：

```text
OOM error in V8: Zone Allocation failed - process out of memory
Server process exited with code 5
```

这次已有直接 OOM 和 child type 证据，不再是“疑似闪退”。

## Triage：已确认事实、推断和争议

### 已确认事实

1. **崩溃主体是运行 Next standalone server 的 Electron `utilityProcess`。** 它不是 Renderer，也不是主进程 breadcrumb 中 `rssBytes≈150–170MB` 所代表的 Electron Main；后者不能用来反驳 child 的 360MB 级 V8 GC 记录。
2. **历史消息损坏不是必要条件。** 第四次运行发送的是全新 `test`，日志明确为 `sdkSessionId: none`、`historyMessageCount: 0`，随后仍 OOM。
3. **Provider 401/429 不是必要条件。** 前三次在未发送新消息时已经 OOM；第四次的 401 重试只能作为额外压力，不能定为根因。
4. **打开聊天页会主动启动 Codex 模型目录预热。** `useProviderModels()` mount 后调用 `warmCodexModelCatalog()`，请求 `/api/codex/models`，从而在用户未发送消息时启动 Codex app-server。
5. **受影响机器的 Codex 模型刷新长期异常。** 首次 OOM 前约四小时内至少十二次出现：

   ```text
   codex_models_manager::manager:
   failed to refresh available models: timeout waiting for child process to exit
   ```

6. **同一错误在上游 Codex 有公开同类反馈。** [openai/codex#34397](https://github.com/openai/codex/issues/34397) 记录了完全相同的 models-manager 行、周期性重复、任务挂起且不自愈；[openai/codex#15596](https://github.com/openai/codex/issues/15596) 记录了 macOS 更新后“先正常一段时间，再持续 timeout，重启/新会话不可靠恢复”。这些只作为症状旁证，不直接采信其根因推测。
7. **当前 Electron Main 运行期不监督 server。** child `exit` handler 只记录退出码、把 `serverProcess` 置空；窗口仍指向死亡端口，native notification poll 继续请求旧端口并刷 `ECONNREFUSED`。
8. **旧日志暴涨问题不是本次直接根因。** `codepilot-main.log` rotation、`serverErrors` ring、Codex tracing 降噪已经落地；本次四个 crash breadcrumb 中 `serverErrors` 只有 25–80 行、约 1.2–8.8KB。
9. **仓库已有同类恢复债记录。** `docs/research/stability-fluency-runtime-audit-2026-07-04.md`（已删除，见 git 历史） §1.8 已指出 Next `utilityProcess` 运行期崩溃后无自愈会导致 connection refused / 白屏。

### 当前高置信判断

这是两个问题叠加，而不是一个单点：

1. **触发问题：** Codex model refresh / app-server / transport 路径在特定持久化配置、长任务状态或系统资源条件下，使 Next utility child 遇到不可继续满足的分配请求。现有 GC 摘要中的 `total≈364–428MB` 不是 `heapSizeLimit`，不能据此预判是 JS heap、native/external allocation 还是宿主机整体压力。
2. **放大问题：** CodePilot 把 API、聊天、文件树、scheduler、Codex manager 等都托管在同一个 Next child，且 child 崩溃后没有监督、独立错误面或恢复流程，于是一个 Codex 侧异常升级为全应用灰屏。

### 尚未确认，实施前必须证伪

- OOM 是很多可回收对象被长期保留、一次超大 JSON-RPC frame、无换行 frame 的字符串复制放大，还是 native/external allocation、系统/地址空间压力。
- `timeout waiting for child process to exit` 后是否真的留下 Codex/model/MCP 孙进程；错误文案也可能掩盖网络/WebSocket 层超时，不能只按字面假设“必有僵尸进程”。
- 哪类持久化输入使重启后很快复发：Codex isolated home、model catalog、plugin/skill 配置、rollout/state DB，还是仍在运行的外部进程。
- `--max-old-space-size` 是否对这类 `Zone Allocation failed - process out of memory` 有效。它只能作为诊断 A/B，不得直接当根治方案。
- 当前 stdout partial-line buffer 是否在真实事故中达到大尺寸。代码风险存在，但日志没有 frame byte evidence。

## 目标

### 用户结果

1. 单个 runtime / 本地 server 崩溃不再表现为无解释灰屏。
2. 可安全恢复时自动恢复原 route；不可安全恢复时显示独立错误页，提供“重启应用”“复制诊断摘要”入口。
3. 新会话、历史会话和文件树共享的本地 API 恢复后都能重新加载。
4. 崩溃时正在运行的 turn 必须诚实标为 interrupted / process restarted；不得显示为已完成，也不得伪称无损续跑。
5. 普通日志只记录进程类型、退出码、内存数值、frame 字节数、reason code；不得记录 prompt、tool arguments、凭据、完整路径或 diagnostic report 原文。

### 工程目标

- 找到至少一个可以稳定区分根因类别的 A/B：warmup、Codex home、binary、transport frame、残留进程或系统压力。
- 给 Codex stdio transport 建立按字节计算的 hard cap 和可测试失败语义。
- 保留既有 app-server spawn 去重；给 server-side model discovery 建立 request single-flight、失败 cooldown、显式 retry，并给已启动但 wedged 的 cached app-server 建立 health/recycle 合同。
- 给 Next utility child 建立有限监督状态机、health gate、backoff 和 crash-loop stop condition。
- 保持 stable port、scheduler、native notification、session lock 和 app-server 的 single owner。

## 非目标

- 不在本计划内修复上游 Codex 的所有 model refresh / WebSocket / remote compact timeout。
- 不改默认 Runtime、Provider、Model 或权限策略。
- 不做 DB schema 迁移。
- 不保证崩溃中的 Codex turn 可以无损续跑；首版以“诚实中断 + 可继续发下一条”为合同。
- 不把简单增大 V8 heap 当完成标准。
- 不自动 push、merge、tag 或 release。

## 取舍与被否掉的方案

### 1. 不先“直接加大 V8 heap”

理由：fatal 文案是 process allocation failure，不是已经证明的普通 JS heap ceiling；调大 heap 可能只是把崩溃推迟，同时放大机器内存压力。允许把 `execArgv` heap 参数作为 A/B，但只有同时拿到 heap limit、private memory 和稳定 soak 证据后才能讨论是否保留。

### 2. 不先“无限自动重启”

理由：如果 Next child 死后 Codex/MCP 孙进程仍在，立即拉起新 server 会制造多 owner；如果 chat mount 是触发器，reload 原 route 又会立刻 warmup，形成重启风暴。首轮必须先做独立错误面、cooldown 和 descendant ownership 证明，再开放有限自愈。

### 3. 不永久删除 Codex 模型预热

理由：预热解决的是 Codex Account 模型首次进入聊天不可见的真实问题。正确止血是 bounded warmup + circuit breaker + retry，而不是退回“必须先访问设置页”的隐式前置条件。若需要 release hotfix，可临时进入 recovery safe mode，但 UI 必须诚实显示“Codex 模型目录暂不可用”。

### 4. 不把所有相似公开反馈合并为同一根因

CodePilot 公开 Issues 中没有第二份带 `Zone Allocation failed` / exit 5 的同形证据；UI 卡死、历史记录异常、interrupt 后会话废掉只是症状相近。上游 Codex timeout 也只用于构造复现矩阵，不替代本地 heap / process evidence。

## 详细执行设计

## Round split 与依赖

- **Round 1 双线并行：** Phase 0 只负责证据与根因分类；Phase 2 的离线错误面不依赖根因结论，可先独立降低灰屏伤害。
- **Round 2：** Phase 1 完成 transport / request cancellation / unhealthy instance containment；frame cap 最终值必须由 Phase 0 数据校准，不能把 `32 MiB` 候选直接固化为事实。
- **Round 3：** Phase 3 只有在生产级 descendant registry 与 ownership 证据通过后才可启用自动重启；否则停在 Phase 2 的人工恢复面。
- **Round 4：** Phase 4 执行 packaged soak、真实 smoke、guardrail 和 ledger 收口。每轮完成即同步状态表、决策日志与 Smoke Ledger。

## 执行清单

- [x] Phase 0：补 host / utility / V8 同窗观测、frame/model-list 数值与 descendant generation 证据；本地未复现事故，按退出合同归 F，外部 A/B 不冒充已执行。
- [x] Phase 2：交付不依赖 Next 的离线错误面、脱敏诊断复制、poll pause 与受控 relaunch/retry。
- [x] Phase 1：交付 bounded stdout frame、RPC deadline cancellation、server-side `model/list` single-flight/cooldown 与 unhealthy idle recycle。
- [x] Phase 3：交付 Main-owned safe mode、有限 supervisor 与 current-generation production registry；不杀未知 PID，身份/后代不可证明时自动恢复 fail-closed。
- [ ] Phase 4：targeted/full/build、packaged server health、guardrail、Tracker、Decision Log、packaged kill ×1 / restart-budget / live-Codex blocked smoke 与 Ledger 已完成；15/60 分钟 soak 和 active-turn UI smoke 未完成。

## 2026-08-11 实施结果

- **根因结论：F（未复现）。** 用户日志已证明 Utility OOM，但本地没有 affected profile/机器，不能把无界 frame、Codex internal refresh 或 host pressure 任一项写成根因；本轮交付的是防御边界、观测和 crash containment。
- **Transport / model discovery：** stdout 改为 Buffer fragment NDJSON reader，在复制/拼接前按 bytes 执行 32 MiB hard cap；`model/list` 的外层 deadline 会 abort client pending，同一 cache generation 只保留一个 server-side fetch，失败进入 5 秒 cooldown，连续三次 signal 才标记 unhealthy，且只在已观测无 active turn 时回收。
- **Main recovery：** unexpected exit 暂停 native delivery poll，进入 1s/2s/4s、10 分钟最多三次的 supervisor；新 utility 绑定原 stable port，以 recovery-safe env 启动，通过 `/api/health` 后才恢复原 local route 和 poll。退出/更新路径不触发恢复，恢复交接期再次退出使用单槽 queue，不丢 crash。
- **Safe mode：** owner 是 Electron Main；replacement server 禁止 Codex app-server start、模型目录只读 cache、scheduler 不自启动，Renderer 明示并禁止 Codex Runtime 发送。为避免伪解除，当前实现持续到用户完整重启应用；没有只改 Renderer 状态的“恢复正常”假动作。
- **Ownership：** Utility generation 只通过窄 lifecycle message 登记 Codex app-server 的 PID + owner nonce + role + executable basename；Main 不杀任何登记/未知 PID。活进程、PID 复用疑点或不可验证的更深 Codex tree 都停在本地 blocked page。注册表属于当前 Electron Main 生命周期，不把完整 app relaunch 后的未知进程冒充已证明不存在。
- **Observability / privacy：** utility 每 60 秒只上报 RSS、heapUsed/heapTotal/heapLimit、external、arrayBuffers；Main 对齐 Electron working/private/CPU 与 host free/swap。Utility fatal report 原文、argv/env、frame 内容、prompt/tool args 都不写日志。
- **验证边界：** 最终代码已生成禁用 Developer ID 自动发现的 arm64 目录包，完成 ad-hoc 深度签名并通过严格校验；Resources/app.asar 0 source map，standalone `/api/health` 通过 verifier。它仍只是本地 `--dir` 验证产物，不是 DMG/ZIP 或 Release artifact。未执行 GUI child kill、真实 Codex login 或长时 soak，状态保持 Smoke pending。

### Phase 0：证据冻结与复现矩阵

### 用户会看到什么

无 UI 变化。本阶段只产出脱敏证据、根因分类和实施边界。

### 明确不做

不修改 heap 大小、不上线自动重启、不清理用户 Codex home、不使用真实凭据构造破坏性复现。

### 任务

1. 固化一份不含 prompt、用户名、绝对路径和 token 的 incident fixture：
   - 四次 OOM 的时间、GC bytes、exit code、child type。
   - model refresh timeout 次数和间隔。
   - server start → Codex spawn → OOM 的耗时。
   - fresh chat `historyMessageCount=0` 证据。
2. 诊断构建增加临时、低频观测：
   - Main 侧 `process.getSystemMemoryInfo()` 的 host total/free/swap 数值，以及 Next utility PID、`app.getAppMetrics()` 的 working set/private memory/CPU；采样必须低频且有固定上限。
   - utility 侧 `heapUsed`、`heapTotal`、`external`、`arrayBuffers`、`heapSizeLimit`，并与 Main 侧同一时间窗的 child RSS/private 对齐。日志里的 `total≈364–428MB` 只作为事发采样，不冒充 heap limit。
   - child `error` 事件的 `type`、`location` 和从 Node diagnostic report 中白名单解析出的数值；不持久化 report 原文。
   - Codex stdout 当前 partial frame bytes、完成 frame bytes、最大值和 method/type；不记录 frame 内容。
   - model/list 请求耗时、响应 bytes、model count、timeout/abort reason。
   - Codex/MCP descendant 的 PID/PPID/可执行文件 basename；不记录完整 argv/env。
3. 用 packaged app 做最小 A/B：

   | 变量 | A | B | 目的 |
   |------|---|---|------|
   | Chat warmup | enabled | disabled | 判断 mount 即触发路径 |
   | Codex profile | 受影响拓扑的脱敏副本 | clean isolated home | 判断持久化状态/配置影响 |
   | Codex binary | ChatGPT.app bundled | 同版本独立 binary（若存在） | 判断 binary/启动方式影响 |
   | Chat | fresh / 0 history | affected old session | 排除历史消息必要性 |
   | Network | 保持用户原代理 | direct（环境允许时） | 只判断相关性，不把代理当预设根因 |
4. 在每轮后核对进程树，确认 model refresh timeout 和 Next crash 后是否有 descendant 残留。

### Human gates（只在外部事发机器取证时触发）

- 本地开发机上的诊断构建与脱敏 synthetic A/B 属于实现轮正常验证；但**向外部用户分发诊断构建**是发布渠道动作，必须由用户显式批准版本、投放对象和回收方式。
- **在外部用户机器运行 heap flag / profile / network A/B** 必须另获用户同意，并先约定采集字段与保留时间；未获批准时改用本地或合成样本，不以缺少外部 A/B 阻塞 Phase 2。

### Phase 0 退出条件

必须至少把事故归入下列一类并留证，否则不能宣布“根因已修”：

- A：单个/无换行 transport frame 失控。
- B：完整消息或 request/pending 状态持续保留。
- C：Codex/model/MCP descendant 残留造成系统资源压力。
- D：持久化 Codex profile / model catalog 输入触发异常分配。
- E：native/external allocation、宿主机内存/交换压力，或 Electron utility / V8 运行参数与 packaged 环境的独立限制。
- F：未复现；仅能交付 crash containment，根因继续作为开放 finding。

### Phase 1：Transport 硬边界、观测与 warmup 熔断

### 用户会看到什么

异常 Codex 模型发现会快速失败并显示可重试状态，不会让整个本地服务无限占内存或连续 spawn。

### 明确不做

本阶段不承诺 server 自动重启；不改变正常用户的模型目录内容和默认模型选择。

### 任务

1. 重构 `makeStdioTransport()` 的 partial-line 与 pending request 处理：
   - 以 bytes 而非 JS string length 计数，避免 UTF-8 / UTF-16 误差。
   - 在拼接/复制前执行 hard cap；初始候选 `32 MiB`，最终阈值必须由 Phase 0 的真实最大 frame 和媒体场景 fixture 校准。
   - 超限时返回稳定 reason `CODEX_PROTOCOL_FRAME_TOO_LARGE`，拒绝所有 pending RPC，终止该 app-server，并只记录 bytes / message direction / method class。
   - `/api/codex/models` 的 2.5 秒调用方 timeout 必须向下取消对应 RPC，或把 client timeout 对齐到相同 deadline；不能让底层 entry 继续滞留到现有 30 秒 client timer。现状并非永久泄漏，但每次 timeout 最多会额外保留约 27.5 秒。
   - 覆盖 chunk 边界、CRLF、多字节字符、多个 frame、恰好等于 cap、超过 cap 和无换行流。
2. 对 `model/list` 和 cached app-server 建立 server-side 单航班、失败 cooldown 与健康回收：
   - `getCodexAppServer()` 已用 cached promise 对 spawn/initialize 去重，不重复建设；同一 binary/config fingerprint 的并发 server-side HTTP models 请求仍只允许一个 `model/list`。
   - timeout、fatal config、frame too large、process exit 分开记 reason。
   - cooldown 期间 cache-only feed 继续可用；显式“重试”可以清 cooldown。
   - 连续 N 次可识别的 internal model refresh timeout 或 `model/list` timeout 将当前 app-server generation 标为 unhealthy；阈值和窗口由 Phase 0 校准，不能用单条 warning 误杀。
   - unhealthy instance 只在无 active turn / approval / tool call 时 dispose 并重建；无法证明 idle 时不热杀，保留 degraded/cached feed。进程退出和 initialize 失败继续沿用现有 cache invalidation。
3. recovery safe mode 由 **Electron Main 单一持有**，跨 Next server restart 保留：
   - Main 记录 crash window / attempts，并在 spawn 新 utility generation 时通过只读 env snapshot（例如 `CODEPILOT_RECOVERY_SAFE_MODE=1`）注入；server enforce 跳过非必要 warmup并使用 cache-only catalog，Renderer 只读展示。
   - 快速 crash 后下一次启动默认跳过非必要 Codex catalog warmup。
   - UI 显示模型目录暂不可用及 retry，不把空 catalog 伪装成“账号没有模型”。
   - server 稳定窗口达到约定值后由 Main 解除。用户显式 retry 必须经受控 Main IPC 清除；若没有 live state channel，则由 Main 启动一个不带 safe-mode env 的受控新 server generation，不能只改 Renderer 内存或假装已解除。**（首版实现偏差，见 2026-08-11 决策日志：无可信 live state channel，safe mode 持续到完整 app relaunch；60 秒窗口只重置 attempt budget。本行保留为后续迭代目标，不代表当前行为。）**
   - 纯浏览器 dev 模式没有 Electron Main 时，env 缺省为 safe mode off；不得为测试方便另造第二个持久 owner。
4. 保留现有日志降噪与 fatal-config fail-fast；新 reason code 进入同一脱敏边界。

### Phase 1 验收

- 100MB 无换行 synthetic stdout 不得让 Node heap 随输入线性增长到 OOM；transport 必须在 cap 附近主动失败。
- 十个 server-side 并发 HTTP `/api/codex/models` 只产生一次 `model/list`；现有 cached promise 的 spawn/initialize 去重另有回归断言，不能用 Renderer 的 warmup memo 代替此测试。
- 调用方 timeout 后对应 client pending entry 在同一 deadline 附近回收；连续失败期间普通 chat/provider feed 仍可打开，且不会一直服务于已标记 unhealthy 的 cached instance。
- report/frame 日志中不出现 fixture prompt、path、token 或完整 JSON。

### Phase 2：独立错误面与安全恢复入口

### 用户会看到什么

本地服务死亡后不再只剩灰屏。窗口进入不依赖 Next server 的错误面，展示：

- “CodePilot 本地服务意外退出”。
- 是否正在尝试恢复、尝试次数和下次重试时间。
- “重启应用”“复制诊断摘要”按钮（blocked 态例外：只显示“退出应用”，见本 Phase 任务 4 的 quit-only 合同）。
- 若当前 turn 被中断，明确提示任务可能未完成。

### 明确不做

不在错误页展示原始日志、绝对路径、完整 crash report、prompt 或工具参数。

### 任务

1. Electron Main 在 server `exit/error` 时进入明确状态，而不是只置空引用：
   - 区分 `quitting` / 正常主动 stop 与 unexpected non-zero/fatal exit。
   - 保存崩溃前 route，便于健康恢复后 reload。
   - 暂停 native delivery poll 和所有 main→server timer，停止旧端口 `ECONNREFUSED` 日志洪水。
2. 错误面必须是 bundled local/static 或 Main 原生能力，不依赖死亡的 `127.0.0.1` server。
3. 诊断摘要只含：app version、platform/arch、child exit code/reason、attempt、heap/private memory 数值、sanitized reason codes。
4. “重启应用”必须走受控 quit/relaunch；不能仅 reload 死亡 URL。**例外（review round 2 P1）：blocked 态不得提供任何 relaunch 入口**——descendant registry 是 per-Main 内存态，relaunch 后为空，会在旧 Codex tree 仍存活/不可验证时绕过 single-owner 门禁；blocked 只提供「退出应用」（plain quit），用户清理残留进程或重启电脑后手动重开。
5. 恢复成功前不能 ack 新 notification delivery；恢复后按既有 durable claim/stale lease 合同继续。

### Phase 3：有限自动自愈与 single-owner 证明

### 用户会看到什么

偶发一次 server crash 时应用可在短暂提示后恢复原页面；窗口期内连续崩溃达到上限后停止自动尝试，保留手动重启入口。

### 明确不做

不无限重启，不在未确认 descendant ownership 时自动拉第二套 Codex/MCP/scheduler，不伪造正在执行 turn 的续跑。

### 任务

1. 抽出可单测的 server supervisor 状态机，例如：

   ```text
   stopped → starting → healthy
                 ↓
               crashed → backoff → starting
                 ↓ attempts exhausted
               failed/user_action_required
   ```

2. 推荐初始策略，Claude 审查可调整但必须保持有界：
   - backoff：1s / 2s / 4s。
   - 10 分钟窗口最多 3 次自动重启。
   - 连续健康 60 秒后 attempt 归零。
   - `before-quit` / update / intentional stop 永不自动重启。
3. 重启前证明旧 owner 已清理：
   - utility child 已 exit/reaped。
   - 建立生产级 descendant registry：当前 utility generation 通过窄 lifecycle channel 向 Main 注册/注销其直接拥有的 Codex app-server 与 managed MCP，至少携带 generation、role、PID、可执行文件 basename 和可防 PID 复用的 start identity；不得上报 argv/env。
   - Main 只接受当前 utility generation 的登记。终止前必须重新核对 PID + start identity + role/basename/祖先关系；只凭 PID 或 basename 不得 kill。无法覆盖更深孙进程、无法重新验证身份或清理失败时，Phase 3 fail-closed 停在人工错误页。
   - registry 是启用 auto-restart 的硬前置，诊断构建中的一次性进程树截图不能替代它。旧 utility 也必须确认 reaped，避免两个 Next process 同时打开数据库 WAL。
   - scheduler、bridge、notification consumer 的 ownership 不重叠。
4. 新 child 必须重新绑定原 stable port，通过 `/api/health` 后才能 reload 保存的 route、恢复 poll 和解除 loading。
5. crash loop 与 warmup 联动：快速 crash 后以 recovery safe mode 启动，避免 reload chat 立即重复模型预热。
6. in-flight 语义：
   - 正在执行的 turn 标记为 interrupted/process restarted。
   - session lock 有 bounded settle，不因 server death 无限续租。
   - 用户可以发送下一条，但 UI 不声称上一条已完成。

### Phase 4：验证、Guardrail 与发布门禁

### 用户会看到什么

无新增功能；这是把“不会再灰屏、不会重启风暴、不会重复后台任务”变成发布证据。

### 明确不做

不以 dev server、单次 `/api/health 200` 或“机器上没复现”替代 packaged 长时验证。

### 自动测试

1. `npm run test`：typecheck + unit。
2. `npm run build`：Runtime / Electron / standalone 链路必须通过。
3. `scripts/verify-packaged-server.mjs`：产物 health 与 ABI。
4. 新增/扩展测试至少覆盖：
   - bounded JSON-RPC frame reader。
   - model/list request cancellation、server-side single-flight、unhealthy cached instance idle recycle、cooldown/retry 与 Main-owned safe mode。
   - supervisor 正常退出、单次 crash、三次 crash、健康窗口重置。
   - descendant registry generation/PID-reuse 校验，以及身份不明时 fail-closed 不重启。
   - poll pause/resume，不向死亡端口持续请求。
   - error report sanitizer。
   - stable port recovery 与原 route reload。
   - in-flight interrupted / lock settle。

### Packaged smoke 矩阵

| 场景 | 最低时长 | 必查结果 |
|------|----------|----------|
| fresh chat + Codex warmup | 15 分钟 | 无 OOM；model/list 单航班；memory 数值已记录 |
| 历史 chat + 文件树 | 15 分钟 | 消息与文件树同时可用，无 `Failed to fetch` |
| 周期性 model refresh / 长任务 | 60 分钟 | 无持续单调内存增长、无 timeout spawn 风暴 |
| 强制 kill Next child 一次（无 live Codex descendant） | — | 有限恢复、原 route reload、无重复 owner |
| 强制 kill Next child 一次（存在已注册 live Codex app-server，即 B-030 事故形态） | — | **预期停在 blocked page**（fail-closed），不自动重启、不产生第二个 Codex owner；blocked 判定不得当作 smoke 失败。**必须断言 blocked 页只有「退出应用」，无一键 relaunch/重试入口**，点击后应用退出且不自动重开 |
| 窗口期耗尽三次自动重启预算（连续 kill 四次） | — | 前三次分别按 1s/2s/4s 恢复；第 4 次停止自动重试并进入错误页 |
| crash 时存在 active turn | — | turn 诚实 interrupted，下一条可发送 |
| recovery safe mode | — | 页面可恢复，Codex catalog 显示暂不可用并可显式 retry |
| proxy on/off | 各 15 分钟 | 只记录差异，不把代理可用性混成产品成功 |

内存证据至少包含 post-warmup baseline、峰值、15/60 分钟末值和 utility `heapSizeLimit`。若不能稳定读取 GC 后 heap，不设伪精确 MB 阈值；但 accepted 前必须解释曲线是否持续单调增长，并保存原始数值摘要。

### Guardrail

1. 更新 [ElectronMain.md](../../guardrails/ElectronMain.md)：Next child 运行期必须被监督；unexpected exit 后 poll 暂停；重启有 backoff/上限/health gate；正常 quit 不重启。
2. 更新 Runtime/Codex guardrail：stdio partial frame 必须有 byte cap；model discovery 必须 single-flight + failure cooldown；日志只存尺寸和 reason。
3. 更新 release smoke：packaged server 不只验证启动 health，还要覆盖一次运行期 kill/recovery；Codex 变更至少执行 15 分钟 warmup soak。
4. 完成后回写本计划状态表、Decision Log 和 Smoke Ledger；P1 finding 不能只在聊天中关闭。

## Required Checks（accepted）

| ID | Description / 可量化验收线 |
|----|----------------------------|
| `oom-root-class` | Phase 0 将事故归入 A–F 至少一类；evidence 含 A/B 输入、host free/swap、child RSS/private、heapUsed/heapTotal/heapSizeLimit、PID/frame/model-list 数值和结论，不能只写“疑似内存泄漏” |
| `codex-frame-bound` | transport 以 bytes 做 cap；oversized/no-newline/multibyte/chunk-boundary tests 通过；超限拒 pending RPC 且日志不含 frame 内容 |
| `warmup-circuit-breaker` | 10 个 server-side 并发 HTTP models 请求只执行一次 `model/list`；调用方 timeout 同 deadline 取消 pending；unhealthy cached instance 只在 idle 回收；failure cooldown 与 Main-owned safe mode 协同阻止 server restart 后立即重触发；显式 retry 可解除；普通 provider feed 不被阻断 |
| `server-recovery-bounded` | intentional quit 0 restart；单次 unexpected exit 可恢复；10 分钟 3 次后停止；health 通过前不 reload/poll |
| `single-owner-after-restart` | 生产 registry 覆盖 generation + PID + start identity + role；recovery 前后 Next/Codex/MCP/scheduler/notification owner 数量有证据；PID 复用/身份不明/残留时 fail-closed 不启用 auto restart |
| `honest-interruption` | crash 中 active turn 显示 interrupted/process restarted，session lock bounded settle，下一条可发送，不能显示 completed |
| `offline-error-surface` | server 已死亡时错误页仍可加载；recovering/failed 态提供受控重启应用，blocked 态只提供「退出应用」（quit-only，无一键 relaunch——registry 不跨 relaunch，见 review round 2 P1）；复制脱敏摘要可用；无 raw path/prompt/token/report |
| `packaged-soak` | macOS packaged fresh/history 各 15 分钟、长任务 60 分钟无 OOM；强制 crash 1 次和 3 次矩阵通过并登记内存数值 |
| `regression-gates` | `npm run test`、`npm run build`、packaged server verify 和相关 smoke 全部通过，或逐项记录无法运行原因且不得 accepted |
| `plan-ledger-sync` | 状态表、执行清单、Decision Log、Smoke Ledger、issue tracker 和 guardrail 状态一致 |

## 实施验收状态

| ID | 状态 | 2026-08-11 evidence / 尚欠 |
|----|------|----------------------------|
| `oom-root-class` | 🟡 F 类出口 | host/utility/V8/frame/model-list/descendant 观测代码已交付；本地无 affected profile，未执行外部 A/B，因此只声明“未复现 + containment” |
| `codex-frame-bound` | ✅ Tests pass | exact cap、oversized/no-newline、多字节、chunk boundary、CRLF 与多 frame 定向测试通过；reader 在 copy/concat 前拒绝 |
| `warmup-circuit-breaker` | ✅ Tests pass | 十并发只发一次 `model/list`、deadline abort/late response、cooldown/force retry、internal timeout threshold、safe-mode cache-only 与 UI 禁发均有测试 |
| `server-recovery-bounded` | ✅ Crash smoke passed | packaged 单次 kill 恢复原 stable-port route；连续 kill 时前三次按 1s/2s/4s 自动恢复，第 4 次停在 failed 页且不再 spawn utility |
| `single-owner-after-restart` | ✅ Crash smoke passed | 无 descendant 恢复后仅一个 replacement utility；live Codex descendant 时停在 blocked，restart IPC 返回 false，plain quit 后不自动重开 |
| `honest-interruption` | 🟡 既有恢复合同通过 / UI smoke pending | 既有 startup recovery 会把 running session/message/subagent 标为 restarted/interrupted 并清 session lock；本轮全量单测通过，active-turn crash UI 未实操 |
| `offline-error-surface` | ✅ Crash UI smoke passed | recovering→原 route、failed 页 restart/retry、blocked 页 quit-only 均在真实 ad-hoc `.app` 验证；blocked 直接调用 restart IPC 返回 false |
| `packaged-soak` | 🟡 Crash smoke passed / soak pending | kill ×1、三次 restart budget（第4次 crash 停止）与 live-Codex blocked 已跑；fresh/history 15 分钟、长任务 60 分钟、active turn、proxy on/off 待跑 |
| `regression-gates` | 🟡 自动 gates + 40.10.6 隔离 crash smoke 通过 / soak 未齐 | 原实现轮 `npm run test` 5181 pass / 0 fail / 1 skip（5182 tests），三类 40.2.1 GUI crash smoke 通过。2026-08-12 最终为 5192/0/1；40.10.6 `electron:build`、explicit ad-hoc directory package、deep/strict、0-map、packaged health 与 canonical temp userData 下 single/budget/blocked GUI smoke 全通过。official-signed/真实 userData 仍是发布门禁 |
| `plan-ledger-sync` | ✅ 已同步 | 本计划、active README、B-030、Electron/Runtime guardrail、release gate 与 Smoke Ledger 同步为 Code complete / Tests pass / Review passed / Crash smoke passed |

## 预计改动面（供审查，不是强制文件清单）

- `electron/main.ts`：child lifecycle、poll pause/resume、错误面接线。
- `electron/server-supervisor.ts`（建议新增纯逻辑模块）：状态机、backoff、attempt window。
- `src/lib/codex/app-server-manager.ts`：bounded stdio frame、failure reason、descendant/transport lifecycle。
- `src/lib/codex/app-server-client.ts`、`src/lib/codex/models.ts`、`src/app/api/codex/models/route.ts`：request cancellation、server-side single-flight、timeout/cooldown、size/count telemetry。
- `src/lib/codex/model-catalog-warmup.ts`、`src/hooks/useProviderModels.ts`：safe mode 与显式 retry。
- Electron/Codex/unit/packaged smoke tests。
- `docs/guardrails/ElectronMain.md`、相关 Runtime guardrail、release smoke 文档。

如 Claude 发现可以用更小改动保持同一合同，应在计划中解释为何不损失 required checks，再调整文件拆分；不得为了匹配本清单制造无意义抽象。

## 风险与回滚

| 风险 | 防线 | 回滚 |
|------|------|------|
| 自动重启制造孙进程/任务双 owner | descendant ownership check + health gate + restart 上限 | 关闭 auto restart，保留错误页和手动 app relaunch |
| chat reload 再次 warmup，形成 crash loop | Main-owned crash window + recovery safe mode | 默认关闭自动 warmup，保留显式 retry |
| frame cap 拒绝合法大媒体/工具结果 | Phase 0 测最大 frame；按 bytes；加入媒体 fixture | 提高有证据的 cap，不移除 hard bound |
| crash 后上一轮被误显示完成 | interrupted terminal contract + lock settle tests | 降级为明确“进程重启，请重试”，不做自动 resume |
| diagnostic report 泄漏路径/环境/凭据 | 白名单解析；默认不落原 report | 只保留 type/location/heap numeric summary |
| 增大 heap 掩盖泄漏 | heap flag 仅 A/B，soak 看曲线 | 移除 flag，保留根因修复与 containment |
| 把 GC `heapTotal` 误当 `heapSizeLimit`，错误归因 frame/系统压力 | host + child RSS/private + V8 heap/external 同窗观测；允许 F 类 | 不下根因结论，只交付 containment 并保留开放 finding |
| 外部诊断构建或用户机器 A/B 越权 | 两项独立 human gate；字段白名单与保留时间先确认 | 仅跑本地/synthetic 验证，不向外投放 |

## Smoke Ledger

> 真实 smoke 后立即追加。凭据只写形态，不写值；Evidence 使用 session id、脱敏日志摘要或产物路径，不贴 prompt / tool arguments。

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|------|---------|----------|-------|---------|------|--------|----------|
| 2026-08-10 | codex_runtime | custom compatibility provider | unknown | 用户现有配置（脱敏日志） | 四次 packaged utility OOM 离线分析 | ❌ confirmed | V8 `Zone Allocation failed` ×4；exit 5；Utility crashed；随后 ECONNREFUSED |
| 2026-08-11 | synthetic/unit | 无 | 无 | 无真实凭据 | transport/model/supervisor/registry/offline page + full regression | ✅ Tests pass | implementation targeted 108/108；review targeted 16/16；full 5181 pass / 0 fail / 1 skip；typecheck/harness boundary 通过 |
| 2026-08-11 | packaged standalone | 无 | 无 | 无真实凭据 | arm64 ad-hoc signed directory package health + source-map hygiene | ✅ Tests pass | `electron:build` + `electron-builder --dir` exit 0；deep/strict signature OK；Resources/app.asar 0 maps；`/api/health` 200 |
| 2026-08-11 | packaged Electron | 无 | 无 | isolated data dir，`CODEX_DISABLED=1` | kill Next utility once | ✅ Crash smoke passed | utility PID 9408→9439；offline recovery surface 出现；原 stable-port route 精确恢复；replacement utility owner=1 |
| 2026-08-11 | packaged Electron | 无 | 无 | isolated data dir，`CODEX_DISABLED=1` | exhaust restart budget | ✅ Crash smoke passed | utility PID 9504/9511/9515 前三次按 1s/2s/4s 恢复；第 4 次 PID 9545 后停在 failed 页，utility owner=0 |
| 2026-08-11 | packaged Electron + Codex app-server | Codex local binary | 无生成请求 | isolated data/Codex home；未记录凭据值 | live descendant 后 kill Next utility | ✅ Crash smoke passed | registry 收到 descendant register；PID 9757 后进入 blocked；`#quit` only；restart IPC=false；plain quit 后 Main 退出且未 relaunch |
| _待跑_ | codex_runtime | Codex Account | selected catalog model | ChatGPT login | fresh chat warmup 15m | 📋 | utility heap/private memory + frame/model-list summary |
| _待跑_ | codex_runtime | Codex Account | selected catalog model | ChatGPT login | periodic refresh / 60m soak | 📋 | process tree + memory curve |
| _待跑_ | any | configured local test provider | any | 需可控测试凭据 | crash during active turn | 📋 | interrupted terminal state + next-send evidence |

## Claude Code 审查记录（2026-08-11，基线 `main@ff9dc316`，只审计划未改代码）

### 事实核对：计划断言 vs 代码本体

逐条对码结果（enforcing file:line）：

| 计划断言 | 核对结果 |
|----------|----------|
| chat mount 自动 warmup（已确认事实 4） | ✅ `src/hooks/useProviderModels.ts:278-279` mount `useEffect` → `warmCodexModelCatalog()`；renderer 端已有 in-flight 共享 + `catalogReady` memo（`src/lib/codex/model-catalog-warmup.ts:25-44`） |
| stdout partial-line buffer 无界 | ✅ `src/lib/codex/app-server-manager.ts:70,98-107`：`buffer += chunk` 无任何 cap；每次 `data` 事件 `indexOf('\n')` 会触发 V8 rope flatten，放大常数大。stderr 路径（`:115`）是逐 chunk split、无跨 chunk 累积，**cap 只需覆盖 stdout** |
| Main 运行期不监督 server（已确认事实 7） | ✅ `electron/main.ts:1023-1028` exit handler 只记 code、置空引用；`serverPort` 不清空 → native delivery poll（`:543-612`，2s interval）永续打死端口；全文件无任何 restart/relaunch 逻辑 |
| B-025 日志边界已落地（已确认事实 8） | ✅ `serverErrors = BoundedLineRing`（`electron/main.ts:150`） |
| 审计 §1.8 已有同类记录（已确认事实 9） | ✅ `docs/research/stability-fluency-runtime-audit-2026-07-04.md`（已删除，见 git 历史） |

需要修正/补充的事实陈述（偏差不推翻结论，但影响 Phase 1/3 设计）：

1. **`getCodexAppServer` 已有进程级 spawn 去重**（`app-server-manager.ts:648` cached promise；exit / initialize 失败才清空）。因此 Phase 1 验收里”每个消费者都重新 spawn”只在快速失败循环下成立；更符合日志形态的问题是反面——**仍存活但可能 wedged 的 app-server 会继续被缓存**：无 health check、无回收路径。4 小时 12 次 internal refresh timeout 与同一异常 generation 一直存活相符，但仍需 PID/generation telemetry 才能把“同一进程”升级为确认事实。
2. **`codex_models_manager::manager` 是 Codex app-server 内部（Rust 模块）的周期刷新循环**，不由 CodePilot 的 30s TTL 或 warmup 驱动；`timeout waiting for child process to exit` 指 app-server 自己 spawn 的子进程挂起。CodePilot 的 single-flight / cooldown 管不到这条内部循环，只能围堵。
3. **`model/list` 外层超时后底层 RPC 未同步取消**：`src/lib/codex/models.ts:57-62` 的 `withTimeout` 在 2.5 秒只拒绝调用方；底层 `CodexAppServerClient` 会在自己的 30 秒 timer 删除 entry（`app-server-client.ts:235-240`），因此不是永久泄漏，但每次会额外滞留约 27.5 秒。Phase 1 应补 request cancellation / deadline 对齐，不把这条夸大成无限增长。

### 审查请求五问的回答

1. **refresh timeout 是触发信号还是噪声？** 它至少是 app-server 内部管理循环长期异常的 health signal；在补齐 PID/generation 证据前，不能断言十二次都来自同一进程。它进入 Next child OOM 的因果路径即使存在也可能是间接的（孙进程/系统压力或 stdio 流量），不是已证实直接原因。A/B 矩阵保持仲裁地位是对的；但计划应补一条围堵：**连续 N 次 internal refresh timeout（stderr 可识别）→ 标记 app-server unhealthy → 空闲时 dispose 重建**。这不修上游、不违反非目标。
2. **无界 buffer 能否放大到 OOM？** 代码风险属实、cap 必须做。但四次 crash 的 GC 数字（354–360MB，total ≤428MB）里的 `total` 是当时 heap total，**不是已测得的 `heapSizeLimit`**；`Zone Allocation failed` 也不足以单独证明宿主机内存压力。单靠现有摘要无法区分 JS retained、native/external/RSS 或系统压力。**Phase 0 必须补 host 级内存指标**（Main 侧 `process.getSystemMemoryInfo()` + child RSS/private + `heapSizeLimit`），否则 A/B 会误分根因。frame cap 是正确的防御边界，但不要预设它就是根因。
3. **孙进程会不会残留？** 无法从现有代码证明不残留：app-server 由 Next child spawn，Next child V8 fatal 时 `disposeCodexAppServer()` 不会执行；app-server 是否在 stdin EOF 退出无证据；且其自身 spawn 的刷新子进程可能挂起。同意 fail-closed。**计划缺口**：Phase 0 的 descendant 记录只存在于诊断构建；Phase 3 的 production auto-restart 需要生产级 descendant registry。Codex 采纳时进一步收紧为 generation + PID + start identity + role/basename/ancestor 复核，不能只凭 PID+basename 清理；无法验证即不自动重启。另补一条动机：better-sqlite3 与 Next server 同进程，重启前旧 child 必须确认 reaped，避免双进程同开 WAL。
4. **safe mode / circuit breaker 归属？** **Electron Main 持有**。Renderer 状态随 reload 丢失且不可信；Next server 的模块级状态（`models.ts` cache、warmup memo）随 crash 消失；只有 Main 跨 server 世代存活并观察 crash 时序。建议合同：Main 记 crash window/attempts → 决定 safe mode → spawn 时经 env（如 `CODEPILOT_RECOVERY_SAFE_MODE=1`）注入 → server 端 enforce（跳过 warmup、cache-only catalog）→ renderer 只读展示 + 显式 retry 经 server API/IPC 回 Main 清除。纯浏览器 dev 模式无 Main，env 缺省即 safe mode off。请把 owner 写入 Phase 1 task 3。
5. **checks 可验收性？** 10 条整体可量化，三点修订：`warmup-circuit-breaker` 的”10 个并发请求”须写明是 **server 端并发 HTTP 请求**（现状 spawn 已去重、list 未去重，不得拿 renderer memo 充数）；`single-owner-after-restart` 在生产注册表机制定义前不可执行（依赖问 3 的补充设计）；`packaged-soak` 不设伪 MB 阈值、要求解释曲线，符合反假数据规则，接受。`oom-root-class` 允许 F 类诚实出口，接受。

### 遗漏风险

- Phase 0 观测清单缺宿主机内存压力与 child RSS（问 2）。
- 事发机器与开发机是否同一台未记录；**若为外部用户**：向其投放 Phase 0 诊断构建、在其机器跑 heap flag A/B 均属发布渠道动作 → **human decision**。
- model/list 外层超时后底层 pending 继续滞留到 client 30 秒 timeout，缺 request cancellation / deadline 对齐（并入 Phase 1 task 1）。
- wedged app-server 无检测与回收路径（并入 Phase 1，见问 1）。

### Round split 建议

- **Round 1（并行双线）**：Phase 0（证据）∥ Phase 2（独立错误面）。Phase 2 与根因结论零依赖、无条件有价值，不必排在 Phase 1 后面；Phase 1 的 single-flight / cooldown / safe-mode 骨架也不依赖 Phase 0，仅 cap 数值必须等 frame 证据。
- **Round 2**：Phase 1 收口（cap 按 Phase 0 校准）。
- **Round 3**：Phase 3，硬前置 = 生产 descendant 注册表 + Phase 0 ownership 结论。
- **Round 4**：Phase 4 发布门禁。每轮结束按「完成即回写」同步状态表 / 决策日志 / Smoke Ledger。

### 结论：`fix_requested`（计划级修订，不推翻架构）

| # | 修订项 | 落点 |
|---|--------|------|
| R1 | 观测补 host 内存压力 + child RSS + heapSizeLimit | Phase 0 task 2 |
| R2 | 写明 safe mode 为 Main-owned，env 注入合同 | Phase 1 task 3 |
| R3 | 增补 wedged app-server 检测回收 + 超时 pending RPC 清理 | Phase 1 task 1/2 |
| R4 | 增补生产 descendant 注册表任务，设为 auto-restart 硬前置 | Phase 3 task 3 |
| R5 | `warmup-circuit-breaker` 措辞改为 server 端并发 | Required Checks |
| R6 | 标注两项 human decision（诊断构建投放、用户机器 A/B） | Phase 0 / 风险表 |
| R7 | Phase 2 与 Phase 0 并行，调整状态表顺序说明 | 状态 / Round split |

修订均为增补、不与既有 checks 冲突；Codex 采纳 R1–R7 后可直接转 `accepted`，无需再走一轮全量审查。实施授权仍由用户发起。

### Codex 采纳结论：`accepted`

- R1、R2、R4–R7 已原位写入 Phase、Round split、Human gates 与 required checks。
- R3 的健康回收方向已采纳，同时校准为“外层 2.5 秒 timeout 后底层 pending 最多滞留到 30 秒 client timer”，并要求同 deadline cancellation；不再记录为永久 pending leak。
- heap 反向证据已采纳为“必须补 host/RSS/heapSizeLimit”，但不把 GC `heapTotal` 冒充 heap limit，也不提前判定为系统压力。
- descendant registry 增加 generation/start identity/PID-reuse 防线；只凭 PID+basename 不允许清理。上述收紧不改变 Claude 的 round split 与架构结论。
- 计划级审查闭环；状态转 `accepted`。这不等于授权改产品代码、投放诊断构建或在外部用户机器跑 A/B。

## 决策日志

- 2026-08-11（packaged crash smoke）：Codex 新增 `scripts/smoke-packaged-server-recovery.mjs`，以临时 user-data/DB/Codex home 启动 ad-hoc arm64 `.app`，通过 Electron Main metrics 精确定位并只 kill 本次测试的 `codepilot-server` utility。三条真实进程路径通过：① 无 live Codex 时 PID 9408→9439，原 stable-port route 恢复且 owner=1；② 三次自动重启分别消费 1s/2s/4s 预算，第 4 次 crash 停在 failed、owner=0；③ live Codex descendant 时停在 blocked，DOM 仅 quit，直接调用 restart IPC 返回 false，plain quit 后 Main 退出不 relaunch。由实测校准 smoke 文案：合同是“最多三次自动重启”，故停止点是第 4 次 crash，不是第 3 次。打包后已恢复 workspace Node ABI。
- 2026-08-12：只读 Sentry 复核确认 8 月 10 日四次 utility exit 5 没有远端对应事件；根因不是 Sentry 告警漏筛，而是 Main 当时只记本地日志。补充 stable opt-in、每 generation 最多一次的 `server.utility_process_failed` normalized fatal event；只发送退出码和 utility/host memory 数值，Electron diagnostic report 原文仍在 Main 丢弃。该改动改善下一版本取证，不倒推 B-030 allocator 根因已确定。
- 2026-08-12（Electron 40.10.6 gate）：最终全量 5192/0/1、production build、arm64 explicit ad-hoc 目录包、deep/strict、0-map 与 packaged server health 通过。最初两次 GUI rerun 在 `SecItemCopyMatching` 阻塞；补 canonical temp userData + packaged 双门禁的 Safe Storage 隔离后，single/budget/blocked 三场全通过。隔离 smoke 证明 recovery state machine，不替代 40.10.6 official-signed 包访问真实 userData/旧 ACL 的产品路径。
- 2026-08-11：实施归类保持 F（本地未复现），不把 defensive 32 MiB cap、internal model refresh timeout 或 host pressure 中任一项写成已证实根因。受影响机器 profile/heap/network A/B 和诊断构建投放继续受 human gate 约束。
- 2026-08-11：safe mode 由 Main 通过 utility env snapshot 持有，并持续到完整 app relaunch；当前没有可信 live state channel，因此不做“server 稳定 60 秒后只改 Renderer 状态”的伪解除。60 秒窗口只重置 supervisor attempt budget。
- 2026-08-11：production registry 首版只做 current-generation admission gate，不执行 process kill。Codex app-server 声明 `descendantsVerifiable=false`；登记仍在、PID 存活/复用疑点或更深 tree 不可验证时自动重启停在 blocked page。该收紧牺牲部分自动恢复率，换取 single-owner fail-closed。
- 2026-08-11：自动 gates 与最终 packaged standalone health 通过。第一次目录包因本机 Developer ID 签名阶段长期无输出而终止；随后显式关闭证书自动发现，ad-hoc signed arm64 `--dir` 包完整生成并通过 deep/strict、source-map hygiene 与 `/api/health` verifier。它不是 DMG/ZIP/Release artifact；kill ×1/×3、active-turn UI 与 15/60 分钟 soak 保持未完成，不写 Smoke passed。
- 2026-08-11（review round 3 复审）：Claude Code 复审 P1 闭环 **通过（本地范围，只审未改码）**。核实：restart handler 在任何副作用之前拒绝 blocked（`main.ts:3063`，拒绝路径零状态变更）、quit handler 反向只收 blocked 且无 relaunch、两者保留窄 sender 校验；source-pin 断言了门禁次序（blocked 检查先于 `app.relaunch()`），正确覆盖"只藏按钮不收权限"的回归类。认可 round 3 定性：round 2 修复确实只闭合了按钮/脚本层，blocked 页经 preload 仍可调用 `restartApp()` 且能过 trusted-sender 校验，Main 层双向 fail-closed 是必要纵深。另推演 `retry` IPC 无状态门禁的残余面：从 blocked 发起 retry 会重新进入 ownership 评估并再次 blocked，budget 重置无法绕过 single-owner，不构成 finding。独立复跑 targeted 16/16、全量 `npm run test` 5181/0/1，与 Codex 声明一致。
- 2026-08-11（review round 3）：Codex 复核 round 2 quit-only 修复时发现**按钮层闭合但 Main 权限层仍有旁路**：preload 对 blocked renderer 仍暴露 `restartApp()`，`server-recovery:restart-app` handler 只校验 recovery data URL、未校验 `lastServerRecoveryPageState`，因此仍可直接触发 `app.relaunch()`。Codex 接手修复：restart handler 对 blocked fail-closed，quit handler 反向限定只接受 blocked；source-pin 同时断言 blocked 检查位于 `app.relaunch()` 前，避免以后只藏按钮不收权限。验证 targeted 16/16、全量 `npm run test` 5181/0/1、touched ESLint / docs drift / diff check 通过；`npm run electron:build` 首次在沙箱内因 Turbopack 绑定端口 EPERM 假阴性，按既有门禁在沙箱外复跑成功。状态回到 Code complete / Tests pass，待 Claude Code 复审。
- 2026-08-11（review round 2）：Codex 复核推翻「0 blocker」——**P1：blocked page 的「重启应用」无条件 `app.relaunch()`，而 descendant registry 是 per-Main 内存态，relaunch 后为空 registry，可在旧 Codex tree 仍存活/不可验证时 spawn 第二个 app-server（同一 `CODEX_HOME`/SQLite），一键绕过本轮刚建立的 single-owner 门禁**。Claude Code 对码核实三环节（按钮全状态渲染 / handler 无条件 relaunch / registry 无持久化、启动无孤儿扫描）后接受 `fix_requested`，按最小修复落地：blocked 态改为「退出应用」quit-only（页面脚本按状态生成，blocked 不发出任何 relaunch 绑定）、新增窄授权 `server-recovery:quit-app` IPC（source-pin 断言 handler 无 relaunch）、recovering/failed 保留受控重启。正确语义修正为「自动恢复停止，用户必须先退出并清理残留进程（或重启电脑）后手动重开」。持久化 registry + 跨 relaunch 重验证作为更强方案记 tech-debt #85。验证：targeted 16/16，全量 `npm run test` 5181/0/1；smoke 矩阵 blocked 行补「无一键 relaunch」断言。
- 2026-08-11：Claude Code 完成实现轮复审（独立上下文，逐项对码 + 自跑门禁）：**Review passed（本地范围），0 blocker**（已被 review round 2 推翻，见上条——「0 blocker」判定漏掉了 blocked→relaunch 绕过链）。核实：byte cap 先检查后拷贝且 stderr 路径本就无跨 chunk 累积；RPC abort 竞态已闭合；exit handler 的 generation 守卫顺带修了旧实例晚退清空新缓存的隐患；recovery page 的 retry 只在 `failed` 态渲染（blocked 态不承诺做不到的重试）；诊断/observability 只含白名单数值。复跑 `npm run test` 5179/0/1 与声明一致。接受 507 条对上轮审查两处断言的纠正。登记 2 条 P3 nit：① `observeAppServerActivity` 的 `turn/cancelled` 分支是死代码（协议终态均走 `turn/completed`+status），建议删除或注明；② Phase 1 task 3 的"稳定窗口解除"行与实际 relaunch-only 行为不一致，已在原文标注为后续迭代目标。提醒 packaged kill smoke 必须含一例"kill 时存在已注册 live Codex app-server → 断言停在 blocked page"，因为这正是 B-030 事故形态下自动恢复的预期路径。
- 2026-08-11：用户授权 Codex 直接实施 accepted 计划，并明确不启动 loop。Round 1A/1B 开始；产品代码、测试与 guardrail 进入本地实现，仍不授权 push/tag/release 或外部诊断构建投放。
- 2026-08-11：Codex 复核并吸收 R1–R7，计划转 `accepted`。同时纠正两处证据过度：GC `heapTotal` 不是 `heapSizeLimit`；外层 2.5 秒 model/list timeout 不会让 client pending 永久保留，但会滞留到 30 秒内部 timeout。生产 registry 必须防 PID 复用，身份不明时 fail-closed。
- 2026-08-11：Claude Code 完成计划审查（基线 `ff9dc316`，只审未改代码）。5 项代码断言全部核实；给出 `fix_requested` 与 R1–R7 修订清单，核心增补：host 内存观测、Main-owned safe mode、wedged app-server 回收、生产 descendant 注册表、Phase 2 提前并行。
- 2026-08-10：用户补充完整日志后，将问题从”历史对话打不开”升级为 P1 本地服务 OOM。四次 V8 fatal、exit 5、Utility crash 和 ECONNREFUSED 形成完整证据链。
- 2026-08-10：排除“历史消息损坏是必要条件”和“Provider 401 是必要条件”；fresh `historyMessageCount=0` 仍 OOM，前三次未发送新消息已经崩溃。
- 2026-08-10：不并入旧 [log-bloat-codex-runtime-crash.md](log-bloat-codex-runtime-crash.md)。旧计划治理主日志 rotation、Main `serverErrors` ring 和 tracing 洪水，本次 crash 时这些边界正常且死亡主体是 Next utility child。
- 2026-08-10：采纳既有稳定性审计的有限重启方向，但增加 descendant ownership、warmup safe mode、诚实 turn interruption 和 notification/scheduler single-owner 门；在这些门成立前只交付独立错误面，不盲目自动重启。
- 2026-08-10：上游 Codex issues 只用于说明 model refresh timeout 有同类症状，根因仍以 CodePilot affected-profile A/B、frame size、process tree 和 heap evidence 为准。
