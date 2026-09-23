# Memory Runtime 解耦与辅助调用修复

> 创建：2026-09-21；更新：2026-09-22。用户明确授权修复原因报告中的全部问题；宠物不纳入跨 Runtime 一致性验收。

## 用户问题与取舍

用户反馈 Sentry 免费额度耗尽，并要求 Memory 不因 Claude/Codex/Native 而不兼容。已审阅的 [原因报告](../../research/memory-runtime-root-cause-2026-09-21.md) 确认 settings-only 凭据能力误判、unknown 分类和重复上报、两套 Memory handler、路径边界/全文漏召回、抽取生命周期和来源更正遗忘缺口。不是通过隐藏错误或另装 Memory 引擎解决。

实施保留用户 Markdown 和已有会话，抽出无 Runtime SDK 依赖的共享核心；模型增强明确能力与状态，基础记忆无模型也可用。单一写入与来源回执替代字符串猜测。不同 Runtime 协议可不同，数据/scope/权限/结果语义必须一致。原生会话 owner 不变；无关 Gemini/UI 改动原样保留，不混合提交。Sentry 历史保留，旧入口变更需基于实际 key 和影响核对，不为减量删除历史或吞掉产品异常。

> 当前状态：Shipped — [v0.67.17](https://github.com/op7418/CodePilot/releases/tag/v0.67.17)，2026-09-22 用户明确授权发布；第三轮 Review passed，Tests pass（5704 pass、0 fail、1 skip），隔离 UI smoke 通过。正式 CI 与公开资产审计通过；真实账号完整客户端 smoke 未执行，发布事实不补记为 Smoke passed / Release ready。

> 上轮复审后更新：用户已确定仅助理工作区启用 Memory 工具，保留 AI 重排并接统一执行器。复审前快照保留作历史；本轮完整门禁与额外 UI 修复验证见文末。

## 状态与用户验收

| Phase | 内容 / 用户变化 | 状态 | 验收入口与边界 |
|---|---|---|---|
| 0 | 原因与授权固化、分工与原有改动保护 | 完成 | 报告及本计划；不升级依赖/发版 |
| 1 | 辅助执行能力、固定错误分类、失败冷却与安全遥测预算 | Code complete / Tests pass | settings-only 不再虚报可执行；辅助状态可读；不偷切账号/厂商 |
| 2 | 共享查询核心、正文召回、目录与长度边界、三 Runtime 薄适配 | Code complete / Tests pass | 相同 fixture 三 adapter 同结果；无模型也可读搜 |
| 3 | 记忆来源/更正/忘记、原子记录与幂等、管理 UI | Code complete / UI smoke passed | Settings 记忆记录管理；旧文件不迁不覆盖 |
| 4 | 显式绑定、统一成功回合事件、桌面/Bridge 抽取、错误/取消/旧 owner 门禁 | Code complete / Tests pass | 成功回合一次；失败与只读不伪装已记住；系统回合不自动提取 |
| 5 | 集成回归、真实 UI/工具 smoke、守卫与研究/技术债回写 | 第三轮 Review passed；真账号 smoke 未执行 | targeted + full + UI/三工具 wire；未验证范围明示 |
| 6 | Sentry 旧入口治理核查与可回滚处理 | 已核查；保留现状，发布后观察再决策 | 明确停收影响，保留历史；不把本地修复声称即时消除旧包上报 |

## 设计与执行约束

- 查询核心不 import Claude Agent SDK / AI SDK；参数、1-based 行号、排序、预算、路径 realpath、来源格式一致。默认确定性排序，可选模型增强必须显式使用统一能力接口。
- 用户可读 Markdown 为记忆事实源，索引可重建。记录具备 source/session/message、状态、版本、幂等 key；更正/撤销不得在索引、recent、上下文或自动抽取中复活。
- 无可用模型执行器返回 unavailable/cooldown/failed，不能写成 completed/NOTHING。环境 SDK 凭据与 direct transport 可用性分开；受限套餐策略原样执行。
- Memory 读写工具和自动服务仅在已绑定的助理工作区启用；普通代码项目不挂载 Memory 工具、不追加每轮 recent 指令、不自动扫描或创建 memory/records.md。用户授权的普通文件工具仍可访问项目文件。旧版已按 cwd 识别的助理会话仅在升级时一次性迁移，之后新普通会话不按 cwd 猜身份。
- 抽取只消费成功持久化、owner 有效、有用户内容的回合。任务提交/处理幂等；读取与失败写入不算成功记忆 mutation。Bridge 走同一生命周期；headless/heartbeat 默认禁用自动抽取，避免系统内容自我放大。
- 宠物行为不借本任务重构；基础 Memory 不以宠物存在为门槛。

## 验证矩阵

| 范围 | 正例 | 反例 |
|---|---|---|
| 辅助执行 | 明确 Native 配置成功、route snapshot | settings-only/无key/过期/策略禁止、不意外fetch或切厂商 |
| 遥测 | 首个 unknown/5xx/产品异常可诊断 | 缺key零event、重复预算、无secret/body、suppressed计数 |
| 查询 | 正文唯一词、中文、标签、行号、recent | sibling/symlink/private metadata、过大文件、空query |
| 记录 | 手动保存/来源回查/更正/忘记 | stale revision、重复source、外部编辑、删除重建不复活 |
| 生命周期 | desktop三Runtime/Bridge成功回合 | cancel/error/stale owner/save失败/read-only/failed-write/system origin |
| 作用域 | 显式助理绑定、升级保留已有助理身份 | 同名目录、目录等于assistant但无绑定、跨session伪造 |
| 用户界面 | 真正保存/更正/忘记、状态与错误 | 无凭据仍基础可用、旧数据保留、无假成功 |

## Smoke Ledger

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|------|---------|----------|-------|---------|------|--------|----------|
| 2026-09-21 | Web Dev / 隔离 DB | 无 | 无 | 未配置 Provider | Settings 助理 Memory：保存原文→更正→忘记 | Smoke passed | 127.0.0.1:3107；浏览器实际操作，磁盘两版本正文已清除，保留 2 revoked 标识；真实用户目录未写测试数据 |
| 2026-09-21 | Native / MCP / Codex proxy | 无 | 无 | 无 key | 同 fixture 实际 handler 搜索/读取/最近记忆；Native/MCP mutation；Codex write MCP route | Tests pass | memory-service / codex-memory-mcp-route / parity / permission 定向；不是三 Runtime 真实模型端到端 smoke |
| 2026-09-21 | AI SDK transport | 合成 Anthropic | Haiku | synthetic key | production auxiliary→model factory→AI SDK，合成 SSE 成功及缺 key 反例 | Tests pass | auxiliary-provider / telemetry-provider-noise；不访问真实账号 |
| 2026-09-22 | Web Dev / 隔离 DB | 本机合成 Anthropic | 辅助 Haiku | synthetic key | Quick actions 401重试不发网→429真实冷却→改配置截止前恢复 | Smoke passed | 3107/3108；实际按钮/状态/截图/console；模型请求计数1→2→3，无真实账号调用 |
| 未执行 | Claude / Codex / Native 真账号 | — | — | — | 打包客户端真实模型自主调用/续聊 | 未验证 | 工具与 HTTP wire 用例、隔离 UI 均不能替代此项 |

## 决策与进度日志

- 2026-09-21：用户明确“修一下这里面提到的所有问题”；从研究进入实施。并行分工：辅助 Provider/telemetry、Memory 查询 core、记录/管理 UI；主线程负责生命周期/绑定/集成/验证与文档。无提交/push/release授权，保持工作树交付。

- 2026-09-21：旧/新 Sentry 项目唯一 Default key 均启用、无单独限额；已明确旧入口停收影响与恢复方式，外部停用尚未执行；先发布并观察新版本 24h/7d accepted 分摊，再提停收取舍。研究报告增加实施链接，原探针保留为 v0.67.16 基线证据。
- 2026-09-21：真实隔离 UI CRUD smoke 通过。复审发现 Claude 整服 auto-allow 会放行新写工具，已改精确 read3；Codex write 独立 approval server，Native Plan 根据实际工具过滤能力提示。

## 本轮复审决策与修复映射

用户确认（2026-09-21）：**仅助理工作区启用**，拒绝把每轮 recent、扫描和经审批的文件写入扩到所有项目；**保留 AI 重排**，不可用时确定性降级。两项都是本轮验收边界，不能再次隐含扩大或删除功能。

| Review | 修复与可复核证据 |
|---|---|
| P1-1 / P1-3 | 三 Runtime 挂载使用同一 binding 判定；DB 启动事务一次性回填升级前 cwd 匹配的非 task 会话，不改 Runtime owner；session GET 返回 assistantMemoryEnabled，ChatView 与 context-assembler 共用后端事实；目录切换事件立即清旧标识并重新读取，失败清状态；读 getter 不写 DB。memory-scope-entrypoints 覆盖新旧会话、上下文和 GET。 |
| P1-2 | Bridge 真实 createBinding 在明确请求或已保存默认目录指向助理时绑定；fallback home/process 不绑定。生产创建入口→真实 consumeStream 三回合→durable job 用例无需测试手工绑定。 |
| P1-4 | memory-rerank.ts 统一捕获精确 Provider/配置，通过 runAuxiliaryText 执行 active_turn_memory_rerank；无效结果、不可用、取消和超时均返回确定性候选。三适配实际 AI SDK SSE 测试覆盖快照和相同输出。 |
| P2 凭据与指纹 | 仅 credentials 根因等待配置身份变化，跨 scope/重启也不按 300s 重试；429/400/413 等非凭据 4xx 有界冷却（第二轮纠正了原 user_action_required 过宽判定）；私有 app-data HMAC 密钥不进工作区，ledger 只含带版本 opaque HMAC。auxiliary-provider、claude-settings-credentials 和 lifecycle 回归覆盖。 |
| P2 存储 | capacity/corrupt/storage 与 conflict/invalid 分码及中英文文案；自动抽取先校验文件、32KiB 余量、权限/锁，确定性阻塞等待存储变化；lifecycle 验证阻塞零模型调用和恢复。 |
| P2 写能力 | Claude/Codex 的实际写工具 surface 启用 memory_write 回执提示；Plan/heartbeat 只读无写承诺，Codex proxy 写仍回传审批。 |
| P2 终态 | 桌面/Bridge 使用 stream-turn-outcome 同一 sticky error/is_error/interrupted/inProgress 判定；错误后成功帧不能反转。桌面 enqueue 仍位于持久化 finally 内，须已保存 completed、owner 有效、共享成功判定才入队；不是“移动出 finally”这一形状保证。 |
| P2 真实入口与枚举 | settings-only 测试走生产 buildResolution→runAuxiliaryText，无手工 resolver fixture 替代真实 bug；ProviderCallScene 和 diagnostics 均从同一 as const 数组派生。 |
| P3 | 助理创建与绑定同事务，冲突返回409且回滚新会话；删除不可达 guard；撤回 resolver 全局 small→haiku 改动，Haiku 仅辅助执行器选择；recent 越界单文件返回 partial、ENOENT 不泄路径；说明补写3工具；Memory 管理页 Retry 展示实际冷却（当时 Quick actions 尚未覆盖，第二轮补齐）；新增真实双进程与 SIGKILL 写入恢复。 |

## 实现与复核

- 共享 core 为 fs/zod/用户文件，不含 Runtime SDK 或凭据依赖；Native/Claude MCP/Codex proxy 使用同一 handler。Codex 写操作经独立 MCP server 审批，Claude 精确 auto-allow read3；`memory_write` 单独 capability，Plan 不宣称具备写能力。执行前复核 session cwd 与权限，禁止创建工具后切 scope/Plan 越权。
- 新记忆以 `memory/records.md` 为唯一事实源。原子 CAS、可信来源、幂等、替代版本与撤销 tombstone；active 投影供模型使用，旧索引路径别名也过滤私有历史。长行支持字符分页，扫描总量封顶且明确 partial，避免大型目录无限占用内存。
- 成功回合批次覆盖前 3 回合，前 2 回合来源引用亦持久化。生成返回 messageId + 原文 evidence，写入前重验源文本/绑定/Plan；仅 credentials 根因等待配置变化，429 与其他非凭据 4xx / 瞬态失败使用 retryAt；工作区只持久化应用私有 HMAC 标识，配置变化立即重新评估，但不重置 job 尝试预算；record 已提交但 job 未 settle 通过 operationHash 恢复，不重生成不同文本。失败、系统、心跳、headless、Plan、旧 owner 均不自动写入。
- 查询/权限独立复核 83/83，生命周期独立复核 42/42，包含实际 collector/Bridge 与真实 AI SDK 处理合成 SSE。新增 guardrail [Memory.md](../../guardrails/Memory.md)，Runtime/AssistantWorkspace/Sentry 契约同步。heartbeat 与 toolloop golden 仅按实际工具 surface 更新，未放宽权限断言。

## 剩余边界

1. 第三轮复审允许独立提交，尚未推送或发布；真实用户仍运行旧包时，新增分类/冷却不能改变其线上上报。
2. 三 Runtime 的同 fixture/HTTP/SDK wire 与隔离 UI 已验证，真实账号下模型自主调用/完整打包客户端 smoke 尚未执行，不标记 Release ready。
3. 旧 Sentry Default key 未改动；后续停收须另行明确决策；保留历史不耗新增额度，继续 ingestion 才耗。停用会同时失去旧官方包监控，重新启用可恢复后续接收，停收窗口不能补回。
4. 聊天 DB 与文件 ledger 没有跨存储原子 outbox。已持久化任务/批次可恢复，但极短 metadata 锁冲突或 IO 错误可能在入队前失败；错误日志保留，不能将此声称跨存储 exactly-once，也不能因此撤销聊天保存。
5. 基础记忆不需模型；仅 CLI/settings 可用而 direct transport 不可用的账号，自动增强诚实显示 unavailable。受管文件被外部编辑导致元数据不一致时 fail closed，不自动覆盖；旧有用户文件不迁移。5000 回合 ledger / 2 MiB records 等容量边界会显示限制，非无限存储承诺。

## 复审前验证快照（2026-09-21，不能代替本轮验收）

- `npm run test`：typecheck + harness boundary + 全量 **5653 pass / 0 fail / 1 skip**（共 5654）；日志 `/tmp/memory-integration-accepted.log`。本地 loopback 测试在允许监听的环境完成；没有将沙箱 EPERM 当产品失败或跳过回归。
- 对全部改动/新增 TS/TSX 跑 ESLint：**0 errors / 16 warnings**（现有大文件/unused 类警告），日志 `/tmp/memory-final-eslint.log`。
- `npm run lint:hooks`、`npm run lint:docs-drift`、`git diff --check` 通过。
- 隔离浏览器 UI：保存蓝色笔记本→更正绿色笔记本→确认忘记→刷新仍为两条“已忘记”；磁盘两版本正文均移除，保留撤销来源。使用临时 DB/助理目录与独立 Next 输出，已关闭 3107 测试服务，恢复 Next 自动改写的 tsconfig，3000 日常 Dev 服务保持运行。
- 原有 Gemini 修复与输入框底部间距修改保持原样，整批未提交。研究文档保留修复前证据，并链接实施计划，不能将旧探针 stdout 当新行为验收。

## 第一轮复审后验证快照（2026-09-21，后续发现见第二轮）

- 复审要求的 P1/P2/P3 已按上表落地。用户的两个范围决策同时固化于本计划、Memory guardrail 和 #99。当时 Phase 4 独立只读复审未发现剩余 blocker，第二轮另发现辅助持久 block 与可选增强异常问题；复审补出的 ChatView 切目录旧标识已修复并复核。
- `npm run test`：**5678 pass / 0 fail / 1 skip**（共5679），含 typecheck、harness boundary。日志 `/tmp/memory-review-full.log`；测试使用隔离 DB，loopback/临时 git 用例在允许的环境运行。
- 首轮全量的3处失败均为旧契约 fixture：普通项目 golden 错挂 Memory、mutation fixture 未绑定、Codex prompt pin 未包含实际读写提示。已明确更新真实作用域/能力断言，未放宽 Plan、审批或写入边界；定向16/16后重跑全量通过。
- 生产入口/生命周期定向 **23/23**（`/tmp/memory-review-lifecycle.log`）：Bridge 无手工绑定、老会话迁移/UI GET/上下文一致、创建事务回滚、容量/损坏/锁占用0次模型调用、修复后恢复、配置错误停止定时重试、两 collector 错误帧后终态仍不成功。
- 辅助/遥测定向241/241、xAI27/27；Memory adapter/rerank/权限154/154，最后快照增量真实wire5/5；records/API/UI错误码22/22，含双进程与SIGKILL恢复。
- 改动/新增 TS/TSX ESLint **0 errors / 26 warnings**（大文件、既有依赖/unused等警告），日志 `/tmp/memory-review-eslint.log`。最后 ChatView 切目录刷新增量再次通过 typecheck 与 scoped ESLint（0 errors）；该增量未再重复全量。`lint:hooks`、`lint:docs-drift`、`git diff --check` 通过。
- Browser 隔离 UI（127.0.0.1:3107）：原 CRUD 数据仍保留两条“已忘记”；人为损坏临时文件后显示“先备份并恢复有效版本”，清旧列表且禁用保存；恢复文件后正常显示；合成冷却任务显示真实 retryAt 并禁用重试，截止后点击显示“已请求重试”，后端按缺失来源返回 skipped，无假完成、无模型调用。此次验证不使用真实记忆数据，也不证明真实账号模型端到端。
- 临时 UI fixture 已恢复，3107 服务与测试 tab 已关闭，Next 自动改写的 tsconfig 已恢复。日常3000 Dev不受影响；工作树未 commit/push/release；旧 Sentry key 未变更。

## 用户手动验收方案（2026-09-21）

本节是待执行方案，不是 Smoke passed 记录。优先执行1–6，约15–25分钟；真实模型调用会使用当前账号额度。每条测试使用专用标记 `MEMCHECK-0921`，便于查找和清理，不使用真实敏感偏好。

准备：打开当前源码的 Electron Dev（连接3000），记下 Settings 中的助理目录。在默认审批模式下测试写工具，避免“完全访问”直接跳过审批。Claude、Codex、Native 各准备一个通过助理入口确认绑定的独立会话，记录会话实际 Runtime/Provider/model；仅改全局默认不会把已有会话换成另一个 Runtime。不要为测试删除已有助理文件。

| # | 操作 | 通过标准 |
|---|---|---|
| 1 间距 | 打开旧聊天和新聊天；单行/多行输入；缩小窗口高度 | 输入框底部有稳定留白，发送与模型选择不被裁切，多行不压住底边。 |
| 2 手动记忆 | Settings→助理→记忆，保存“MEMCHECK-0921：测试通知使用蓝色标签”。刷新页面，打开来源；更正为绿色标签 | 保存跨刷新保留；来源明确；更正后旧版本不再作为有效事实。 |
| 3 跨Runtime读取 | 在三个独立助理会话发送：“请使用记忆搜索工具查找 MEMCHECK-0921，给出当前有效内容和来源。” | 三者都实际调用记忆工具，返回绿色标签，能追到同一受管理记录；只口头回答不算通过。 |
| 4 写入与审批 | 在一个助理会话发送：“请通过记忆工具记住：MEMCHECK-0921-B，我希望测试报告先给结论。”第一次拒绝写入审批，第二次允许；Settings刷新 | 拒绝后无新增记录且不说已保存；允许后出现真实记录与会话来源。另两个Runtime各用不同后缀重复写入，检查同一管理面板。 |
| 5 遗忘 | Settings 中忘记 MEMCHECK-0921；新开/使用没有提过该事实的助理会话，再通过记忆搜索检索该标记 | 工具不再返回有效记录；管理页标记已忘记；刷新和另一个Runtime检索也不会复活。原聊天文本仍存在不算失败，不用模型是否“还记得聊天内容”判定。 |
| 6 范围和Plan | 普通项目新会话发普通问候；检查可用/实际工具。助理会话改Plan后明确要求记住新标记 | 普通项目没有codepilot_memory_*，不强制每轮recent，不自动创建records.md；Plan无记忆写工具、不出现saved收据，管理页无新增。模型可用一般文件工具的能力与Memory挂载分开判断。 |
| 7 自动提取 | 新助理会话依次完整结束3轮：“测试报告用中文”“测试通知按北京时间”“测试报告先列失败项”，每轮要求简短回复，不直接要求写记忆；查看自动提取状态 | 有可执行辅助Provider时产生批次，保存的事实有真实用户消息来源；无API transport或策略不允许时明确不可用且基础手动记忆仍可用。模型判定无持久事实可以显示无需新增，不能靠回复文字判保存成功。 |
| 8 中止/失败 | 另用新助理会话，第1轮等输出后点停止，再完整完成2轮 | 停止那一轮不计成功抽取批次；失败不能显示已保存。继续第3个成功回合才满足批次门槛。以新会话避免此前待凑批次干扰。 |
| 9 旧会话与切目录 | 重开以前的助理聊天，检查助理标识和人格；在测试助理目录之间通过Settings切换 | 老会话仍按既有绑定识别；切换后旧页及时撤掉助理身份，服务端不再注入旧目录内容；切回能恢复。不要用普通项目cwd碰巧相等证明新绑定。 |
| 10 Bridge（已配置时） | 将Bridge明确工作目录设为助理目录，新建Bridge会话并完成3个用户回合；随后以普通项目目录新建Bridge会话 | 助理Bridge可排自动提取，普通项目Bridge不挂Memory；记录来源能回查实际Bridge会话。不把测试代码里手工bind当入口验证。 |
| 11 失败与恢复（测试配置） | settings-only Claude配置运行主聊天并触发辅助增强；或用专用测试Provider模拟凭据失败，修正配置后重试 | CLI主聊天可用不意味着辅助transport可用；辅助明确不可用；同一坏凭据不会每5分钟再请求。瞬态失败显示冷却到期时间；到期按钮可用，点击后显示真实请求状态。 |
| 12 AI重排 | 准备至少两条相关但不同的测试记录，三个Runtime分别实际搜索；比较有辅助transport和不可用两种配置 | 可用时工具显示模型重排事实；不可用/超时/无效输出返回确定性排序及降级说明，检索仍有结果，不换Provider。基础排序一致不等于已证明AI调用成功。 |

第二轮补充：在无消息的助理聊天检查动态建议状态；专用测试 Provider 凭据错误后点“重试动态建议”，应有明确结果，不能重复调用；改配置后重新进入应立即恢复。限流应显示冷却截止时间，按钮到期再可用。自动抽取的连续无效输出最多3次后显示停止自动重试，此故障注入已由隔离测试覆盖，不要求用真实付费模型反复制造错误。

容量上限、损坏文件、并发写和写入中断已由隔离测试覆盖。若人工重验，只对临时助理目录的副本操作；预期显示容量/损坏/访问错误，不把它们称为“请输入1–16000字符”或“刷新即可解决”，阻塞期间不继续模型调用。不要通过清空真实records.md模拟恢复。

Sentry：Dev未上报不能证明生产洪水已消失。发布后按release分别检查24h/7d的accepted事件和凭据错误分组；旧包仍上报与旧项目历史保留是两回事。此次不删除旧项目、不停旧key。

记录每个失败：测试编号、会话ID、实际Runtime/Provider/model、操作时间、预期/实际、工具卡片或状态截图；不要附API key。完成后通过管理界面遗忘测试标记，恢复专用测试配置，并将真实结果补进Smoke Ledger。

Dev 启动记录（2026-09-21）：当前项目3000服务 `/api/health` 返回200、database healthy；已重新编译 Electron main/preload 并启动桌面进程。启动采样显示主线程阻塞于 macOS `SecItemCopyMatching`，尚未出现 Dev connecting/窗口就绪日志；等待本机钥匙串交互，不标记客户端启动 smoke 通过。日志 `/tmp/codepilot-dev-client.log`，栈采样 `/tmp/codepilot-dev-startup.sample`。

## 第二轮复审执行清单（2026-09-22）

- [x] 仅credentials持久阻断；429及其他4xx按冷却恢复，兼容清理上一版误封回执。
- [x] identity/block文件失败成为可见辅助状态；重排构造失败不能影响聊天或基础工具。
- [x] 每个抽取job最多3次模型尝试，持久化并停止被动重复消费；明确UI状态。
- [x] Quick actions缓存和状态对齐当前配置，Retry/截止时间/无结果失败均可见。
- [x] 重排超时、非法输出、异常均明确说明确定性降级。
- [x] Bridge/wizard DB事务、checkin过滤task、删除绑定清理、迁移减少重复文件探测及过时注释。
- [x] 定向/full/UI验证、独立复审，同步guardrail/#98/#99与最终状态。

决策：本轮不把所有user_action_required误当持久配置故障；记录最多3次的job预算，未调用模型的不可用/冷却不计入。Sentry旧入口按用户确认维持现状，发布后观察再决策。


## 第二轮根因、修复与最终证据（2026-09-22）

| Finding | 根因与本轮修复 | 验证 |
|---|---|---|
| P1-1 4xx 永久锁 | telemetry `user_action_required` 被误作恢复策略；现只按明确 `rootCause=credentials` 写 v2 持久回执。结构化 401/403、LoadAPIKey/OAuth 过期属于 credentials；429/400/413 冷却后可恢复。旧 v1 回执没有根因证明，忽略并重新分类；旧 ledger `configuration_required` 不再自行锁死。 | actual AI SDK HTTP 错误、跨 scene/scope/模拟重启、旧 v1 两类误封回执、旧 ledger 恢复；auxiliary-provider / telemetry-provider-noise / memory-lifecycle。 |
| P1-2 构造期失败破坏聊天 | route fingerprint 的私有文件故障外抛；现在 capture/run/status 返回 `identity_unavailable` / `persistence_unavailable`，重排构造局部兜底，基础工具与聊天不受可选增强影响。 | 真实临时 key 错误长度/权限、Native/MCP/proxy factory 与读写、实际 Codex proxy 前台路径；70/70 定向。 |
| P2 无界抽取 | `failed+60s` 没有 job 预算；attempt 在生成前持久化，最多 3 次，耗尽显示 unavailable/retry_exhausted 并隐藏无效 Retry。配置变化、重启、被动恢复不重置；未发模型的 unavailable/cooldown 不计次；已写记录先按 operationHash 恢复。 | 连续非法 JSON、重复 resume、改配置、crash 前已占用预算、identity 恢复；30/30 生命周期/入口测试。这里约束生成尝试数，不把 SDK 内部 HTTP retry 混为 job 次数。 |
| P2 文件异常处理 | identity/read block 在 try 外、write block 在 catch 内再次抛错；现在全部转固定 typed status。凭据回执写失败先保留内存阻断，后续只重试持久化，不重复请求模型。 | 捕获 EIO/权限、跨 scene 不再次 generate、getStatus 不展示旧成功；不将异常假称普通生成失败。 |
| P2 Quick actions | 成败缓存只按 workspace/时间、状态不验证当前配置；现在缓存/状态带同一配置身份，迟到旧响应丢弃；配置变化不等 60s，成功缓存也失效。UI 空结果仍显示状态，POST Retry 有结果反馈且遵守 retryAt，显示实际时间。 | 生产 route 401→改 key 同一分钟恢复、429 Retry 不发网、pending 切配置；13/13，另有下述实际页面证据。 |
| P2 重排说明 | 只有结构化 status 降级才有说明；现在 timeout、throw、非法 JSON/映射全部保留确定性候选并说明原因。 | 真实 adapter wire、超时、重复/越界/部分映射等反例。 |
| P3 入口/清理 | Bridge 的 session/binding/channel binding 同一 DB 事务；wizard session/binding 同事务；checkin 只复用 user source，task 拒绝绑定；删除会话清精确 binding；迁移 SQL DISTINCT 目录后 canonical 检查；storage_busy 生效，extractor 注释更新。 | 真实 SQLite trigger 注入失败并断言确实触发该错误、会话/绑定数不变，task 排除、删除清理。wizard 目录/文件初始化不承诺跨文件系统回滚。 |
| P3 key 文件热路径 | 保留逐次 O_NOFOLLOW / lstat / fstat / mode 验证；本轮不为两次 32 字节读取增加缓存一致性状态。 | 权限 0600→0644 后 run/getStatus 立即 unavailable；缓存优化登记 #100，未经实际性能数据不削弱检查。 |

- **完整门禁**：`npm run test` 通过，**5704 pass / 0 fail / 1 skip**（5705 tests），含 TypeScript 与 harness boundary；日志 `/tmp/memory-review2-full.log`。本轮代码冻结后执行，未访问真实模型账号。
- **独立只读复核**：生命周期/绑定事务 30/30，`/tmp/memory-phase2-independent-review.log`；辅助执行器/Quick actions 32/32，`/tmp/auxiliary-independent-review.log`。两组未发现具体 blocker。各域定向补充：辅助/遥测53/53、重排70/70、Quick actions13/13；不能将重叠用例相加当新 full 数。
- **静态检查**：全部改动/新增 TS/TSX ESLint 0 errors / 26 warnings，日志 `/tmp/memory-review2-eslint.log`；现有大文件/unused 等警告保留，不借本轮重构。
- **实际 UI（Browser，隔离 DB + 3107，合成本机 Provider 3108）**：401 后显示凭据提示，点击重试显示“重试结果”，模型请求计数仍为1；换合成429配置立即请求、显示真实截止时间 `00:46:32` 且 Retry 禁用；再换成功配置，`00:46:28` 前已显示新动态建议，旧冷却/失败被清除；全流程模型请求共3次。页面布局无裁切，console 无 error。基础“回顾本周”仍可用。测试不消耗真实 Provider 额度。
- 已关闭3107/3108及测试tab，按差异恢复 Next 自动改写的 tsconfig，未改真实助理数据与3000服务。`npm run lint:hooks`、`npm run lint:docs-drift` 与 `git diff --check` 均通过（`/tmp/memory-review2-hooks.log`、`/tmp/memory-review2-docs-drift.log`）。

决策日志（未提交，无 commit hash）：2026-09-22 接受第二轮两个 P1，纠正“遥测 outcome 等于重试策略”的错误抽象；补持久预算与可见降级。用户两项范围决定保持原样；Sentry 旧入口维持现状，发布后按24h/7d真实 accepted 分摊再决策。以上状态为本地代码与验证完成，不代表打包真账号验收或发布就绪。

Dev 启动补验（2026-09-22）：先前钥匙串等待已结束。PID27854 的 Electron 窗口通过实际 UI 确认已打开当前项目的 `127.0.0.1:3000` 聊天页，输入框/模型选择均可见；`/api/health` 再次返回200、database healthy。可使用上面的手动验收方案；此项只证明 Dev 窗口就绪，不代表真实模型 smoke。


## 第三轮复审与提交范围（2026-09-22）

- 用户提供的独立复审结论为 **Review passed（无 blocker）**，允许进入 commit；`Release ready` 仍以真实账号与打包客户端验收为前提。
- 审查方用生产 resolveProvider + 隔离 app data 复现 429 有界冷却、401 跨场景/重启阻断及改 key 恢复、0644 identity key 降级不抛错；确认 attempts 预持久化/最多3次、重排失败说明、Quick actions 配置失效/Retry 防绕过。83个新增 i18n key 双端一致；#100 保留为非 blocker 性能观察项。
- 审查方沙箱内4个 git init EPERM 与本轮改动无关；本地允许临时 git/loopback 的完整运行结果仍为5704 pass、0 fail、1 skip，见第二轮日志。不是跳过失败或改弱断言。
- 本条随 Memory/辅助调用修复 commit 保存。仅提交该修复及其测试/guardrail/计划/研究；Gemini 测试、media 数值 schema、MessageInput 间距、Gemini 执行计划及其 README 索引行留在工作区，避免混入无关改动。
- 未执行 push/tag/release，未停用 Sentry 旧 key。计划保留 active，继续跟踪真实账号手动验收与发布后24h/7d accepted 分摊。


## v0.67.17 发布准备（2026-09-22）

用户明确要求“发版”。Memory 提交 feed59c7、Gemini 修复7c1564ca、输入框间距c001adb4相互独立；三个提交均正常通过 hooks（5704 pass / 0 fail / 1 skip）。Dev 真实窗口已确认底部留白。

- 版本与发布说明准备为0.67.17；真实账号、打包客户端人工验收仍记未验证，Release Notes明确披露，不把发布授权当作Smoke passed。
- 管理员API实时确认Immutable Releases enabled=true；main与stable-release-tags active、无bypass/exclude、id/updatedAt与管理员确认状态完全一致，确认日期更新为2026-09-22。
- 不修改Sentry旧key。正式CI负责签名/公证/三平台包健康/资产图门禁，成功后仍需复核公开Release与更新metadata；在终态与资产复核前不标Shipped。


## v0.67.17 发布结果（2026-09-22）

- **Shipped**：[正式 Release](https://github.com/op7418/CodePilot/releases/tag/v0.67.17)，公开时间2026-09-22 03:21:36 UTC（北京时间11:21:36）。不可变tag指向4ddcd1a0f7931fc2ba3d3a1cf2802782bdc4712e；非draft、非prerelease、Latest=true、immutable=true。
- [正式CI 35679941503](https://github.com/op7418/CodePilot/actions/runs/35679941503) 七个job全部success：源码门禁、Windows、macOS、Linux两架构、独立Intel ABI与发布。Mac签名/公证/staple、实际产物启动/原生模块检查与central资产审计通过；Windows保持已披露的unsigned NSIS。
- 公开Release精确20个资产，Linux仅手工包；checksum覆盖19个其他资产，并逐一匹配GitHub资产SHA-256。实际下载universal ZIP、Windows NSIS、两份metadata和四份blockmap，大小/哈希均匹配；Mac feed只引用同版本universal ZIP，Windows feed只引用同版本完整NSIS，SHA-512与实际下载字节一致。
- 从公开universal ZIP抽取检查：app.asar与standalone package版本均0.67.17，updater指向op7418/CodePilot。证据目录 `/private/tmp/codepilot-v0.67.17-public/`：ci.json、release.json、latest.json、audit.log、package-audit.log。
- 真实账号三Runtime记忆端到端、打包客户端人工流程仍未执行；计划继续active。Sentry旧key保持不变，发布后24h/7d accepted分摊与是否停收仍待数据验收，不能以发布成功宣称线上噪音已消失。
