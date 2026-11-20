# 千问 Token Plan 与 Grok 接入

> 创建时间：2026-07-21
> 最后更新：2026-08-15
> 状态：🟡 Claude 第三轮复审已通过（附条件），代码 blocker 全部闭环，尚待真实凭据 smoke：Grok 4.6 UI 只展示锁定 SDK 可承载的 Low/Medium/High，动态 `redirect_uri`、媒体真源/失败语义/实际工具挂载与四入口取消均有确定性回归。v0.67.0 发布快照全量为 5246 pass / 0 fail / 1 skipped（5247 tests），production build 通过，production `@smoke` 22/22；smoke 还捕获并闭环了真实 ChatGPT.app `Codex Desktop/<release>` user-agent 被严格版本门误拒的问题。但第三轮复审曾观测 5242/2/1，两个失败均为已跨机器复现的 `telemetry-native-stream-loop` 真 flake，现登记 tech-debt #86，不能用本次绿色覆盖其存在。authenticated `/v1/models`、真实 4.6/Imagine entitlement 与 fresh 资产 smoke 仍待跑。
> 事实基线：[外部事实手册](../../external-facts.md)

## 用户问题与争议

用户观察到阿里云百炼 Codeplan 的文档入口变成千问 Token Plan，并希望按新产品迭代；同时希望通过订阅 OAuth 使用账号内的 Grok。2026-07-23 的后续反馈指出：Grok 在 CodePilot 中称无法查找推特/X 信息，与用户对 Grok 原生能力的合理预期不符。2026-08-13 用户又要求适配 Grok 4.6，并明确订阅授权必须跟随 Grok Build，而非只更新 API 目录。

调研后的取舍不是“把百炼改个名字，再复制一份 OpenCode OAuth”：

- 千问侧当前有 **Coding Plan、Token Plan 个人版、Token Plan 团队版** 三个独立产品。个人版和团队版共用 URL，但模型目录、配额和数据条款不同；现有 URL matcher 无法可靠区分。
- Grok 侧最初参考 OpenCode/Grok CLI 快照实现订阅 OAuth；2026-08-13 起以 xAI 官方开源 Grok Build 为当前真源，同时继续把非自有 client 的上游可撤销风险写进产品文案、错误分类和发布 smoke。
- Grok 同时提供两条互不阻塞的渠道：官方 API Key + Responses，以及复用公开 Grok Build client 的浏览器/设备 OAuth。后者接受上游可能收紧的兼容风险，以 API Key 作为稳定兜底。
- “接入 Grok 模型”不等于“已经接入 X Search”。xAI Responses 要求客户端显式发送 `tools: [{ type: 'x_search' }]`（当前 SDK 对应 `xai.tools.xSearch()`）；现有实现只发送 CodePilot 客户端函数工具。OAuth 与 API Key 复用同一个 xAI Responses model factory，只在凭据注入上分流，因此两条凭据路径必须拥有相同的 X Search 产品合同；但 OAuth 登录/文本回复成功不能代替真实 `x_search` entitlement smoke。

## 状态

| Phase | 内容 | 状态 | 用户能看到什么 |
|---|---|---|---|
| Research | 千问三产品与 OpenCode/xAI OAuth 事实核验 | ✅ 已完成 | 有可追溯的产品边界、精确模型白名单和 OAuth 风险结论 |
| Phase 0 | Provider preset 身份持久化与迁移 | ✅ 已完成 | 同一 Base URL 的个人版/团队版不会再被静默选错；不确定的旧配置会要求确认 |
| Phase 1 | 千问三套餐 preset、目录与使用策略 | ✅ 已完成 | 添加服务时可明确选 Coding Plan / Token Plan 个人版 / 团队版，并看到真实模型和条款 |
| Phase 2 | 千问三 Runtime 对齐与套餐场景 gate | ✅ 已完成（合同测试） | 前台交互可用；不允许的后台自动调用会被结构化拦截 |
| Phase 3 | xAI API Key + Grok Responses | ✅ SDK transport 边界闭环 | 当前默认 4.6、4.5 legacy；当前锁定 SDK 下只承诺 Low/Medium/High |
| Phase 4 | Grok Build-compatible OAuth 核心 | 🟡 426 修复 Code complete + Tests pass；真实复验待跑 | 动态 callback/scopes/host gate 与完整推理 headers 已落地；账号模型目录和 4.6 real smoke 仍待完成 |
| Phase 5 | xAI 双渠道 UI、生命周期与 packaged hardening | ✅ 代码完成（含 0.59.1 HTTP(S) system-proxy bridge） | API Key/OAuth 并列可选；浏览器与 server xAI 请求不再因 Node fetch 默认直连而分流，packaged macOS Chrome 登录与回复已验收，Windows 真实登录仍待测 |
| Phase 6 | Tier 2 回归、真实凭据 smoke 与发布说明 | 🟡 第三轮 Review passed（附条件）；Tests、production build 与通用 Smoke pass，全量已知 #86 telemetry flake 另行跟踪；真实凭据 smoke 待跑 | 4.5 历史 packaged 验收有效；4.6 自动门禁与 v0.67.0 production route 已闭环，真实账号仍待验证 |
| Phase 7 | Grok X Search 双凭据、双 Runtime 能力闭环 | 🟡 Code complete + Tests pass，2/4 真实凭据组合通过 | xAI 交互路由已获得原生 `x_search`；OAuth × CodePilot/Codex 已验证，API Key 组合不据此推广 |
| Phase 8 | Grok Build OAuth 模型发现与 Imagine 媒体 | 🟡 媒体 Code complete + Tests pass；历史回显 Smoke passed；模型发现与新生成复验待完成 | 账号可用文本模型来自 proxy `/v1/models`；图像/视频作为聊天工具生成并进入 Gallery，不伪装成聊天模型 |

## 范围与非目标

本计划负责：

- 三个千问订阅产品的稳定身份、文本模型目录、角色映射、运行时与交互式使用限制。
- xAI 官方 API Key 的 Grok Responses 接入，当前默认 4.6。
- 参考 xAI 官方 Grok Build 实现浏览器 PKCE、device-code OAuth、token refresh 和订阅 proxy 请求注入。
- 以 Grok Build authenticated `/v1/models` 作为订阅文本模型 entitlement 真源；媒体能力另按 image/video tool 接入。
- 为 xAI API Key 与 OAuth 两条凭据路径接入官方 Responses `x_search` hosted tool，并在 CodePilot/Codex Runtime 诚实呈现调用状态、来源与不支持原因。

本计划不负责：

- 不把千问或 Grok Imagine 图片/视频模型塞进聊天 picker；媒体生成使用 Harness tool/producer 合同。
- 不把 OpenCode Zen 当成 xAI/Grok Build，不接 `grok-build-0.1` 网关 SKU。
- 不读取或复制 `~/.grok`、OpenCode `auth.json` 等其他客户端凭据。
- 不把复用公开 Grok Build client 描述成 xAI 与 CodePilot 的官方合作；申请自有 client 是后续升级，不是当前前置。
- 不借本计划顺手解决全部凭据加密债；首版与现有 OpenAI OAuth 使用同一存储架构并如实继承 tech-debt #40，不宣称 OS keyring 安全存储。
- 不把 xAI provider 伪装成 Claude Code 兼容渠道；首版只承诺 CodePilot Runtime 与 Codex Runtime。

## Phase 0：Provider preset 身份持久化与迁移

### 用户会看到什么

Settings → Providers 的卡片、编辑弹窗和模型页能稳定显示用户当初选择的套餐。个人版和团队版即使 Base URL 一样，也不会因 catalog 数组顺序变化而互换；无法证明来源的旧行会显示“请选择套餐类型”，不会擅自替用户决定。

### 本阶段不做什么

- 不更新千问模型目录。
- 不删除、重建或批量覆盖用户的 provider/model 行。
- 不把 provider 名称、API key 前缀或当前模型猜成套餐身份。

### 取舍

采用 `api_providers.preset_key TEXT NOT NULL DEFAULT ''` 独立列作为显式身份，而不是继续塞进 `options_json`。原因：preset identity 同时被 DB/API、server matcher、renderer matcher、runtime compat、doctor 和迁移使用，它不是一个仅影响 UI 的可选项。

### 执行清单

- [x] 按 `DatabaseSchema.md` 的 on-touch 要求补全 schema guardrail，再修改 schema。
- [x] `api_providers` 新增 `preset_key`；同步 `ApiProvider`、create/update request、CRUD SQL、API response 和 mask 路径。
- [x] 新建 provider 时强制保存被选 preset 的 key；编辑 provider 时只有用户显式切换套餐才允许改 key。
- [x] 把 server、renderer、resolver/doctor/connection-test 的匹配收口到 `resolveProviderPresetIdentity()`：先读 `preset_key`，再验证 protocol/base URL 合同；派生谓词只消费 resolver 结果。
- [x] identity resolver 的 record 输入要求 `preset_key`（legacy 调用显式传空字符串），生产调用点已迁移。
- [x] legacy fallback 仅用于唯一识别；同 URL 多 preset 返回 ambiguous，不取数组第一项。
- [x] backfill 规则：
  - `coding.dashscope.aliyuncs.com/apps/anthropic` 的可证明旧行 → `bailian`。
  - Token Plan URL 且符合旧团队 preset fingerprint 的行 → `bailian-token-plan-cn`。本计划采用保守 fingerprint：catalog 管理且非 manual/user-edited 的模型集合必须**恰好**为 `{qwen3.6-plus, glm-5, MiniMax-M2.5}`，`role_models_json` 的 default/sonnet/opus/haiku 必须均为 `qwen3.6-plus`，且不存在目录外 catalog/discovery 行；manual/user-edited 行不参与证明也不得被改写。只满足子集不自动回填，宁可要求确认，避免把用户手工配置误判为旧团队版。
  - Token Plan URL 但 fingerprint 不明确的行保持空 identity，保留原 DB models/role mapping，并要求用户确认。
- [x] 覆盖 `createProvider` INSERT、`updateProvider` UPDATE、create/update API body、masked response；迁移保持幂等和 no-destructive。
- [x] 身份采纳不隐含目录改写；只有用户在套餐选择器明确确认并发送 `reconcile_catalog` 意图时才 reconcile catalog-managed 行，`manual` 与 `user_edited=1` 继续 DB-wins。
- [x] provider doctor、Models 页、Add Service 分组和 Runtime compat 全部消费同一 identity。
- [x] 新增 migration idempotency、旧 DB backfill、ambiguous URL、matcher parity 和 user-edited 保留测试。

### 验收标准

- 同 URL 创建个人版、团队版两个 provider，刷新/重启后仍分别命中自己的 preset 和目录。
- 去掉 `preset_key` 的 legacy row 不会随机命中 personal/team。
- migration 重跑不改变结果，不删 provider/model/session 数据。

## Phase 1：千问三套餐 preset、目录与使用策略

### 用户会看到什么

Settings → 添加服务 → Code Plan 中出现三个明确入口；Token Plan 作为当前主产品，Coding Plan 显示真实供给状态，不与新产品等权误导：

- 阿里云百炼 Coding Plan（Lite 仅存量；Pro 限量可购）
- 千问 Token Plan 个人版
- 千问 Token Plan 团队版

每张卡显示对应的精确文本模型、官方获取 Key/文档链接、额度/数据说明；默认模型与 Claude Code 官方示例一致。

### 本阶段不做什么

- 不合并或重命名掉现有 `bailian`。
- 不改变现有团队 preset 稳定 key；`bailian-token-plan-cn` 继续代表团队版，避免存量断链。
- 不把图片/视频模型加入 chat catalog。
- 不对官方未声明的模型推断版本兼容、effort 或 context。

### 执行清单

- [x] `bailian` 更新为 Coding Plan 当前 10 个精确文本 ID；新增 `qwen3.7-plus`，保留独立 host/文档。
- [x] 新增 `qwen-token-plan-personal-cn`，目录为 6 个精确文本 ID。
- [x] 更新 `bailian-token-plan-cn` 为团队版 15 个精确文本 ID。
- [x] personal/team 默认 role mapping、subagent 与 983616 context capability 已落位。
- [x] `qwen3.8-max-preview` 只声明有证据的 always-thinking、`low/high/xhigh`、默认 `xhigh`。
- [x] sampling 合同记录 thinking temperature 默认/最小 `0.6` 与上游钳制语义。
- [x] 其他模型能力复用 catalog capability 真源，没有另造 effort 规则。
- [x] 个人/团队文档、API Key 页面和购买/管理入口分开并保留官方 breadcrumb。
- [x] UI 显示个人/团队/Coding Plan 的数据、席位与计量差异。
- [x] UI 显示限购、Key 一次性展示和各套餐 usage 条款。
- [x] Coding Plan 卡显示 Lite/Pro 当前供给状态与购买页。
- [x] 三种订阅 preset 增加 `usagePolicy: 'interactive_only'` 并纳入 schema/test。
- [x] discovery 维持 catalog-only，不用 `/models` 污染套餐白名单。
- [x] 更新 `provider-model-discovery.md` 与 tech-debt #16 的 2026-07-21 Qwen/Bailian 核对状态。
- [x] 团队版目录不推导逐模型 verified；真实 wire smoke 前保持保守。

### 验收标准

- 三张 preset 的 model ID 与官方页面逐字符一致。
- personal/team 共享 URL，但 renderer/server 分别返回正确名称、模型数、默认模型和条款。
- 媒体 ID 不出现在 Settings → Models 的 chat 分组或 Composer picker。
- 团队版 `deepseek-v3.2`、`kimi-k2.7-code`、`MiniMax-M2.5` 未经 Anthropic wire smoke 前不显示逐模型“已验证”。

## Phase 2：千问三 Runtime 对齐与套餐场景 gate

### 用户会看到什么

在前台用户发起的会话中，千问三套餐可按 capability matrix 出现在 Claude Code、CodePilot、Codex Runtime；选择哪个 provider/model，实际 wire 就使用哪个。若用户试图让订阅套餐承担定时任务、heartbeat 或其他非交互后台生成，页面会显示“该套餐仅允许交互式编程/智能体使用”，不会静默请求或换到别家。

### 本阶段不做什么

- 不把“单测能构造请求”当作三个 Runtime 已验证。
- 不在后台调用失败后偷偷 fallback 到默认 provider，避免计费渠道和数据条款漂移。
- 不把 Bridge 中的所有消息自动判成合规；只有可证明由用户即时发起的交互请求才可进入讨论，首版默认 fail closed。

### 调用场景裁决

审查确认，原计划除已列的 title/compact/scheduled/heartbeat/media 外，还漏了 **17 个实际调用位点**：memory extractor 1、memory search rerank 1、onboarding 4、check-in 3、quick actions 1、dashboard CLI/file refresh 2、CLI describe 1、skill search raw fetch 1、task-scheduler 默认 provider fallback 1、connection test 1。它们不能继续靠“记得在每个 route 加 if”治理。

| 场景 | 当前入口 | `interactive_only` 处置 |
|---|---|---|
| 前台聊天 / 用户发起 Agent | 主 chat/agent runtime | 放行；provider/model 必须绑定当前 session |
| 当前用户回合触发的 compact | `context-compressor.ts` | 视为维持本次交互所必需，允许当前 session 的套餐 provider；不得从其他会话借套餐 provider |
| 自动标题 | `title-generation.ts` | 拦截 LLM，使用现有确定性 fallback |
| 隐藏自动记忆抽取 | `memory-extractor.ts` | 拦截，不发请求；保留会话内容，不伪造已写入记忆，必要时一次性提示 |
| 用户回合内主动记忆搜索 rerank | `memory-search-mcp.ts` | 仅绑定正在进行的用户回合时放行；否则退回本地排序 |
| 用户提交 onboarding / check-in | `onboarding-processor.ts` 4 次、`checkin-processor.ts` 3 次 | 作为明确用户动作放行；必须沿用该 session provider，不用全局默认偷偷换渠道 |
| 自动快捷建议 | `workspace/quick-actions` | 拦截 AI 分支，返回静态/文件派生建议 |
| Dashboard 刷新 | `dashboard/refresh` CLI/file 两分支 | 用户点击刷新可放行；自动打开/定时刷新拦截并保留旧 widget |
| CLI 工具描述 | `cli-tools/[id]/describe` | 用户点击生成时放行；批量后台预生成拦截 |
| Skill 搜索 | `skills/search` raw fetch | 收编到统一调用层；用户主动查询可放行，其他触发退回本地搜索 |
| 定时任务 / heartbeat | `task-scheduler.ts`、`agent-task-runner.ts` 的 `assistant_heartbeat` 分支 | 硬拦截，请求数必须为 0；不得 fallback 到套餐或其他付费 provider |
| Connection test | `claude-client.ts:testProviderConnection` | 用户明确点击且已展示会产生最小推理请求时放行；仍带 scene 与 preset identity |
| 媒体规划 | `media/jobs/plan` | 首版拦截；本计划也不把套餐媒体 SKU 接入聊天/规划器 |
| Structured 预留端点 | `api/chat/structured` | 先确认调用方；无法证明用户即时触发则 fail closed，不允许无 scene 的裸请求 |
| Bridge | bridge/headless 路径 | 首版 fail closed；Release Notes 明说千问套餐暂不支持 Bridge |

### 执行清单

- [x] resolver、Models API、Composer picker 和 Codex proxy 以持久化 identity 计算 compat。
- [x] 定义 20 个 `callScene` 的封闭联合，并在所有 credential-bearing 收口点强制；遗漏 scene fail closed。
- [x] `skills/search` 裸 fetch 收编到统一 generation 层，不再自行推断鉴权/identity。
- [x] auxiliary tier 排除 `interactive_only`；active-turn compact 可用当前主 provider，后台不可借用。
- [x] server-side gate 按裁决表逐项实现。
- [x] gate 返回 `ProviderCallPolicyError` 结构化原因，不 fallback。
- [x] 三 Runtime 的 env/adapter/proxy 路径有合同测试；真实凭据验证留在 Phase 6 ledger。
- [x] 未经真实 smoke 的 image/tool/effort/context 组合保持保守，不从目录存在推导 verified。
- [x] 回归 DB-wins、hidden/manual/user-edited 与 session/provider binding。

### 验收标准

- 三个 Runtime 的 picker、resolver、实际请求 provider/model 一致。
- scheduled/heartbeat/自动记忆抽取绑定订阅 provider 时请求数为 0，有用户可操作提示；前台手动聊天和同回合 compact 不被误拦。
- 失败不会换 provider、换模型或产生额外按量计费。

## Phase 3：xAI API Key + Grok Responses（4.5 首版；4.6 增量）

### 用户会看到什么

Settings → 添加服务中出现 xAI；用户粘贴 `XAI_API_KEY` 后，可以在 CodePilot Runtime 与 Codex Runtime 默认选择 `Grok 4.6`，4.5 保留为 legacy。Provider 卡和模型菜单明确标注“xAI API Key”，不把它写成 Grok Build 订阅登录。

### 本阶段不做什么

- 不等 OAuth 决策才开始。
- 不把 xAI 归类成普通 OpenAI-compatible Chat Completions preset。
- 不向 Claude Code Runtime 暴露 Grok。
- 不加入未经 xAI API 文档/真实账号证实的 `grok-build` 别名或 OpenCode Zen SKU。

### 执行清单

- [x] 引入 `@ai-sdk/xai`；新增显式 `xai` protocol/sdk type，并更新 catalog、resolver、adapter、compat 和 form。
- [x] branded preset 固定官方 `https://api.x.ai/v1`、API Key auth；2026-07 首版承诺 `grok-4.5`，2026-08 增量默认 `grok-4.6`、4.5 legacy。
- [x] CodePilot 使用 `xai.responses(...)`，补 Responses request/stream/客户端函数 tool-choice fixtures；这些 fixture 不代表 `x_search` 已接入，X Search 由 Phase 7 单独闭环。
- [x] Codex proxy 使用 `xai` provider-options namespace、映射 `reasoningEffort`；显式发送 `store:false`（CodePilot 不复用 previous response），不继承 OpenAI namespace。
- [x] connection test 使用有 timeout 的非生成 `GET /models/grok-4.6`，且 official endpoint 校验先于 bearer fetch。
- [x] 在 `@ai-sdk/xai` 支持 XHigh 前，用户目录只承诺 Low/Medium/High，外部 `xhigh/max` 安全折叠为 High；minimal/low/medium/high/xhigh/max 已逐档通过生产 builder → 锁定 SDK → fetch，禁止手抄 provider options 冒充覆盖。
- [x] 未经真实 smoke 的能力不标 verified；Phase 6 按 context/vision/tool/effort 分项记录。
- [x] API key 存储明确继承 tech-debt #40，不宣称安全存储。

### 验收标准

- CodePilot Runtime 与 Codex Runtime 各完成两轮同 session 对话，wire model 为 `grok-4.6`。
- 至少一个真实客户端函数工具调用通过；不支持能力返回诚实错误，不降级成纯文本伪成功。xAI 托管的 `x_search` 不计入本阶段，见 Phase 7。
- Claude Code Runtime picker 不出现 xAI provider。

## Phase 4：Grok Build-compatible OAuth 核心

### 用户会看到什么

Settings → 添加服务 → Grok Build OAuth 中提供浏览器登录与设备码登录（Headless / Remote / VPS）。登录成功后，用户可在 CodePilot Runtime 与 Codex Runtime 选择 `grok-4.6`，请求使用该账号的订阅 OAuth 渠道。

### 本阶段不做什么

- 不宣称这是 CodePilot 自有/官方合作 OAuth client。
- 不读取 Grok Build/OpenCode 的凭据文件。
- 不把 OAuth 与 API Key 合并成一个模糊状态或共用注销动作。
- 不把 Grok Build ACP 混进本轮模型 Provider；ACP 是未来完整 coding-agent Runtime 方向。

### Grok Build 当前公开合同（2026-08-13 更新）

- [x] 使用公开 Grok Build client id `b1a00492-073a-47ea-816f-4c329264a828`；代码保留来源与兼容风险注释。
- [x] endpoints 固定为 xAI authorize/token/device 官方地址。
- [x] scope 精确跟随 Grok Build，包含 `openid profile email offline_access grok-cli:access api:access` 与 conversation/workspace read/write；authorize 带 PKCE S256、state、nonce、`referrer=grok-build`，不再发送旧 `plan=generic`。
- [x] callback 只监听 `127.0.0.1`，生产由 OS 分配动态端口；授权与 token exchange 复用同一 redirect URI。实现与测试均调用真实 manager，token form 的 `redirect_uri` 严格等于 authorize URL 中的动态 URI。
- [x] 推理 fetch 只允许精确 Build proxy origin + `/v1/responses`，在 refresh 前 fail closed；按锁定上游兼容版本 `1.0.3` 发送 version、token-auth、identifier、authenticate-response、interactive mode 与用户实际选择的 `x-grok-model-override`，并有真实 AI SDK wire 断言。
- [ ] OAuth 文本模型目录改为 session-authenticated `GET https://cli-chat-proxy.grok.com/v1/models` 真源，保守缓存并按服务端返回的 model/agent capability 生成 picker；网络失败只回退已验证默认项，不把公共 API `/models` 或静态 4.6/4.5 当订阅 entitlement。

### 浏览器与设备码

- [x] xAI browser state/nonce/token parser 与 OpenAI 状态隔离。
- [x] callback 校验 code/state/nonce，处理 provider error、HTML escape、取消、5 分钟超时与 supersede；动态端口避免旧固定端口碰撞。
- [x] CORS 仅允许 xAI auth origins，并处理 OPTIONS/Private Network preflight。
- [x] device flow 展示 verification URI + user code，处理 interval/pending/slow_down/denied/expired/deadline/cancel。
- [x] browser/device 汇入同一 `xai-oauth` credential identity。

### Token lifecycle 与 API 注入

- [x] 新增 `xai-oauth` virtual provider；与 API-key provider 复用 xAI Responses factory，credential resolution 分离。
- [x] fetch override 每次取 fresh token、替换 dummy bearer；精确 official-origin gate 在 refresh 前，拒绝 custom gateway 且不改 caller headers。当前只实现 proxy inference origin；Phase 8 的 public API media 必须另建 purpose-specific fetch，不能直接放宽该 gate。
- [x] access token 在 2 分钟 buffer 内刷新；stored expiry 与 JWT `exp` 取更早边界。
- [x] token bundle 作为一个 JSON setting 原子更新，避免 rotation 半状态。
- [x] refresh 使用进程级 single-flight，支持 refresh-token rotation。
- [x] `invalid_grant` 清 bundle；network/429/5xx 保留；持久化失败 fail closed。
- [x] API Key 与 OAuth 显式分离，header 不跨渠道泄漏。
- [x] 新增 39 个 OAuth 协议/manager 行为测试，覆盖 OpenCode 26 项合同及本计划的端口、并发、nonce、header、持久化、browser/device 取消竞态与 logout 加固项。

### 验收标准

- browser/device 两种登录在真实 Grok Build entitlement 账号完成，先记录 `/v1/models` 返回并选择其中一个 exact model；两轮文本的 `x-grok-model-override`、response model 与 UI 选择一致，客户端函数工具调用通过。X Search 是独立的 hosted-tool 合同，见 Phase 7。
- xAI Usage 页面能看到对应账号消耗；如果无法证明额度归属，不标完成。
- OAuth 登录失败不影响 API Key provider；API Key 删除也不注销 OAuth。
- allowlist/redirect/referrer 变化能分类成上游 OAuth 兼容错误，而不是泛化为“网络失败”。

## Phase 5：xAI 双渠道 UI、生命周期与 packaged hardening

### 用户会看到什么

Settings 中同时存在“xAI API Key”和“Grok Build OAuth”入口。OAuth 桌面环境默认浏览器登录，另提供设备码登录；已登录时仍显示入口但置灰并标注状态。Provider 卡可注销、重连，模型选择器默认显示 `Grok 4.6`，不显示伪造剩余额度。

### 本阶段不做什么

- 不承诺能读到精确周额度，除非 xAI 提供官方 API；没有数据就只链接 Usage 页面。
- 不用 API 调用失败猜 plan 名称或剩余额度。
- 不把 browser/device 两种登录存成两个 provider，它们是同一 xAI account 的两种认证方法。
- 不隐藏兼容性风险：帮助文案说明 OAuth 依赖 xAI 上游策略，API Key 可作为备用接入。

### 执行清单

- [x] Add Service 分离 xAI API Key（官方 API）与 xAI OAuth（授权登录），名称、计费来源和状态不混淆。
- [x] 已登录 OAuth entry 不隐藏；browser/device 是同一 identity 的方法选择；错误在未登录时也可见。选择 browser 后锁定该方法并明确“不需要设备码”，不在 callback 完成到 status poll 之间继续展示设备码入口。
- [x] 进程内并发 refresh single-flight；重启从原子 bundle 恢复；OAuth 与 API-key request 分离。
- [x] logout 只清 xAI OAuth；链接 `accounts.x.ai` 手动管理，API/status/log 文案不回显 token、不承诺远端 revoke。
- [x] `CODEPILOT_XAI_OAUTH_ENABLED` 可独立关闭入口；关闭时保留原因和 API Key fallback，不静默消失。
- [x] xAI browser exchange、device、refresh 与 bearer fetch 显式消费 packaged server 的 HTTP(S) proxy env，遵循 `NO_PROXY`；dispatcher 保持局部，不代理 loopback/其他 Provider。
- [ ] packaged macOS/Windows 验证系统浏览器、动态 loopback、device flow、应用重启与深色/中文 UI；Linux 按当前发行支持范围验证。
- [x] 更新 `ProviderManagement.md`、`Onboarding.md`、`ElectronMain.md` 与 i18n guardrail。

### 验收标准

- browser/device 两种登录都能在全新 profile 完成；端口占用、拒绝、过期、取消、刷新失败均有可操作错误。
- access token 过期后两条并发请求只触发一次 refresh，并持久化 rotated refresh token。
- 注销后 OAuth 模型不可发送；API Key provider 不受 OAuth 注销误伤。
- API response、日志、Sentry、诊断导出中搜索不到 access/refresh token；落盘加密状态按 tech-debt #40 如实记录，不虚假宣称已加密。

## Phase 6：验证、发布与文档

### 用户会看到什么

Release Notes 能准确说明“新增哪种千问套餐”“Grok 是 API Key 还是兼容订阅 OAuth”“哪些 Runtime 可用”，并附迁移/重新选择套餐指引。OAuth 文案不冒充 xAI 官方合作，同时给出 API Key 备用入口。

### 本阶段不做什么

- 不用单元测试关闭真实凭据、真实套餐、真实 OAuth 或 packaged Electron 验收。
- 不把某一个 Runtime 的成功推广成全 Runtime 成功。
- 不删除 Smoke Ledger 中的失败记录；修复后追加新行。

### 测试分层

- [x] Tier 0：catalog schema、exact allowlist、preset matcher parity、ambiguous URL、migration idempotency、usage policy gate、runtime compat、request shape、OAuth mock lifecycle。
- [x] Tier 1：0.59.1 修复后 `npm run test`（4537/4537）；docs drift/hooks；`npm run build`；`npm run electron:build`。
- [ ] Tier 2：v0.67.0 production `@smoke` 22/22；xAI OAuth browser 与 Qwen Personal 已在 CodePilot/Codex Runtime 真实连接并回复，0.59.1 packaged macOS 也已通过 Chrome 完成 xAI OAuth 登录与 CodePilot Runtime 文本回复。Phase 7 `x_search` 已通过 OAuth × CodePilot Runtime 与 OAuth × Codex Runtime 真实会话，API Key × CodePilot/Codex 两组合仍待测；packaged 0.60.0 managed Grok child 的两 Runtime 路由、文本、X Search 与 UI 也已复验。Settings 编辑/切换/注销、同 session resume、device/refresh/客户端函数工具/effort、Windows packaged UX 与其他浏览器仍需对应凭据/产物。
- [ ] Windows/macOS 验证 loopback、系统浏览器、端口占用、device flow 与 app restart。
- [x] CI 同配置 macOS arm64 打包：`CSC_IDENTITY_AUTO_DISCOVERY=false`，0.59.1 DMG 内 `.app` 通过 `codesign --verify --deep --strict`，`CFBundleShortVersionString=0.59.1`，Electron ABI 143 与 packaged server health 通过；这不替代 packaged 真实登录或 Windows/x64 验收。
- [x] 2026-07-21 发布前复核官方 Qwen Coding/Token Plan exact allowlist 与 xAI `grok-4.5` slug；未据此提升未经真实调用验证的 capability。
- [x] identity 四路径 parity 覆盖 explicit/legacy/fuzzy/ambiguous，派生谓词消费同一 resolver。
- [x] 20 个 `callScene` 有封闭枚举与正反例；自动场景在模型构造/fetch 前 fail closed，用户交互场景放行。
- [ ] 团队版真实 Anthropic wire spot-check 至少覆盖 `deepseek-v3.2`、`kimi-k2.7-code`、`MiniMax-M2.5`，按单模型记录响应，不能用一个成功推广到 15 个模型。

## Phase 7：Grok X Search 双凭据、双 Runtime 能力闭环

### 用户会看到什么

用户在 CodePilot Runtime 或 Codex Runtime 选择 xAI API Key / xAI Grok OAuth 下的 Grok 后，可以直接要求检索 X（原 Twitter）的实时帖子、用户或讨论串。实际发生搜索时，聊天流展示 `x_search` 调用状态和可点击的 X 来源；如果账号、模型或上游套餐不允许使用，产品显示结构化的不支持/权限错误，不让模型用训练知识伪装成实时搜索。

### 根因与取舍

- 当前 `src/lib/ai-provider.ts` 只建立 `xai.responses(model)`，`src/lib/agent-loop.ts` 传入的是 `assembleTools()` 生成的客户端函数工具；没有导入或注入 `xai.tools.xSearch()`。所以 Grok 回答“不能查找推特信息”是当前请求能力的真实反映，不是模型本身不支持。
- [xAI 官方 X Search 文档](https://docs.x.ai/developers/tools/x-search)要求在 Responses 请求中显式传入 `type: x_search`；模型名称、OAuth 登录成功或普通文本回复成功都不能证明本轮获得了搜索工具。
- OAuth 与 API Key 共用 xAI Responses provider，OAuth fetch override 只负责换入 fresh Bearer token。产品决策是两条凭据渠道能力对齐，不允许 API Key 有 X Search、OAuth 却静默缺失。
- `api:access` scope 只证明 OAuth token 可以访问 API，不据此推断具体账号已经获得 `x_search` entitlement。两类凭据必须分别做真实调用并核对 server-side tool event、来源和错误分类。

### 本阶段不做什么

- 不把普通网页搜索、第三方 Twitter MCP 或模型训练知识冒充 xAI 原生 `x_search`。
- 不因接通 X Search 就宣称 CodePilot 等同 grok.com 或完整 Grok Build；本阶段只承诺 xAI Responses hosted tool。
- 不静默删除 CodePilot 现有文件、Shell、MCP 等客户端工具来换取 X Search；如果 xAI/AI SDK 不允许 hosted tool 与客户端函数工具同请求混用，必须先做 wire POC，再选择显式研究模式或分轮路由，并让用户知道能力差异。
- 不默认给其他 Provider 打开网络搜索，也不把 X 外部内容当成系统指令；搜索结果始终按不可信外部数据处理。

### 执行清单

- [x] 在 xAI provider-aware tool assembly 中注入 `xaiTools.xSearch()`；仅 `interactive_chat` / `delegated_interactive` 的真实 xAI route 得到该工具，非 xAI 与后台/辅助场景保持空集。
- [x] 补 request-shape 正反例：xAI 请求含 `tools[].type === 'x_search'`，API Key/OAuth 共用同一 tool assembly，非 xAI/后台无该字段；hosted 与客户端函数工具分别有合同断言。
- [x] 锁定混用合同：安装版本 `ai@7.0.11` + `@ai-sdk/xai@4.0.18` 能在同一 Responses 请求中同时序列化 function tool 与 `x_search`；名称碰撞 fail closed，不静默覆盖现有工具。
- [x] 映射 `x_search` provider-executed lifecycle、result 与 URL sources：Native 走现有 SSE，Codex proxy 走 canonical side-channel；同 `tool_use_id` last-wins 富化来源，流式 checkpoint 与最终消息均持久化，刷新后可恢复。
- [x] 定义边界：X 内容写入 `trust: external` 并注入反提示词规则；hosted search 不另造本地权限升级，费用只由上游真实账单决定，UI 不显示猜测金额；401、403（scope/entitlement 不武断细分）、429、network、5xx 有可判别类别。
- [x] CodePilot Runtime 与 Codex proxy 分别补回归；两条 Runtime 不共享“某一条成功就全部 verified”的状态。
- [x] 更新 UI：搜索工具使用专用搜索图标，并展示去重后的可点击来源；capability verified 状态保持不提升，四组合继续在 Ledger 单列记录（OAuth × 两 Runtime 已通过，API Key × 两 Runtime 待测）。
- [x] v0.60.0 route 回归修复：已认证 `xai-oauth/grok-4.5` 使用 picker / resolver / managed Sub-agent 共享 catalog，在 CodePilot 与 Codex Runtime 同时出现；未认证/disabled 与 Claude Code 协议不兼容场景保持 fail closed。
- [x] packaged 0.60.0 OAuth/Grok Sub-agent 复验：CodePilot/Codex managed child 均命中 exact route、返回 X 结果并形成单一 completed 胶囊；Codex proxy 的命名 `x_search` 由独立 packaged direct session 证明，两个 API Key 组合继续待测。

### 验收标准

- xAI API Key × CodePilot Runtime、xAI OAuth × CodePilot Runtime、xAI API Key × Codex Runtime、xAI OAuth × Codex Runtime 四个组合分别发起一个要求近期 X 信息的查询，并观察到真实 `x_search` server-side tool call。
- 每个成功组合至少返回一个可点击的 `x.com` 来源，来源能支持回答中的核心时效性结论；只返回模型文本或普通函数工具调用不算通过。
- OAuth 至少用真实 Grok Build-compatible browser 登录完成一次；device flow 共用同一 credential identity 的自动化合同必须通过，真实 device smoke 继续在 ledger 单列，不用 browser 成功替代。
- entitlement/429/5xx/网络失败均保留原始可判别类别且不泄漏 token；失败组合不被标记为 verified。
- 外部 X 内容中的提示词不得改变系统权限、工具白名单或用户任务；补一条提示词注入反例测试。

## Phase 8：Grok Build OAuth 模型发现与 Imagine 媒体

### 用户会看到什么

Grok Build 登录后，聊天模型列表来自该账号的 proxy `/v1/models`，不再由 CodePilot 猜测；要求生成或编辑图片、制作视频时，Grok 以工具方式调用 Imagine，结果作为 `MediaBlock` 出现在聊天并进入 Gallery。Imagine 模型不出现在聊天模型 picker。

### 已确认的上游合同

- [x] OAuth session 模型目录：`GET https://cli-chat-proxy.grok.com/v1/models`，带 fresh bearer、token-auth、version、identifier、client-mode 等 Build headers。
- [x] 文本路由：proxy 以 `x-grok-model-override` 为实际模型真源，JSON body 不能替代该 header；只有默认 `grok-build` 可安全省略。
- [x] 图像：官方外部名称为 Grok Imagine Image 2.0（API model `grok-imagine-image-2.0`）；`image_gen` / `image_edit` 直连 `https://api.x.ai/v1/images/*`。当前 Build 源码默认 wire alias 仍为 `grok-imagine-image-quality`，远端可覆盖为 `grok-imagine-image`，不得把内部 alias 当 UI 名称。
- [x] 视频：`image_to_video` / `reference_to_video` 使用 `grok-imagine-video-1.5`，POST `/videos/generations` 后轮询 `/videos/{request_id}`。
- [x] free / X Basic 对 Imagine 为 tier restricted；付费 SuperGrok 使用统一 weekly allowance。CodePilot 不显示猜测额度，不用一次成功外推所有账号。

### 实施状态

- [ ] 新增 OAuth model-list client/cache/parser；只暴露服务端返回且 CodePilot wire 已验证的聊天/agent 模型，未知字段或空目录 fail closed。
- [x] 每条 proxy inference 请求发送 exact `x-grok-model-override`；Native/Codex/managed Sub-agent 共用同一 resolved model，request-shape 测试穿过真实 SDK fetch。
- [x] 为 OAuth media 新建精确 host+path allowlist：只允许 `api.x.ai/v1/images/generations`、编辑路径、`videos/generations`、`videos/{id}` 与受控下载；proxy-only headers 不发往 public API。
- [x] 复用 `ensureXaiTokenFresh()`、env proxy 与 401 强制 refresh 单次重试；媒体调用和 proxy inference 使用不同 fetch wrapper，未扩大 bearer 泄漏面。
- [x] 图像接入既有 `image_generation` / `MediaBlock` / Gallery；视频作为同一媒体 capability package 的第二个跨 Runtime 工具和独立 `xai-imagine-video` producer，支持异步轮询、取消、超时、下载 MIME/250 MiB 上限和 durable provenance。
- [x] 工具文案和 Gallery 记录只使用官方产品名 Grok Imagine Image 2.0 / Grok Imagine Video 1.5，公共 API wire 使用官方 model id；不暴露 `*-quality` 等 Build 内部 alias。
- [x] 将媒体 capability prompt 抽成无 Claude SDK 依赖的纯模块，并静态挂载 Native image/video/import 工具；工具组装失败会显式报错，不再被空 `catch` 静默吞掉。
- [x] Markdown 对托管 `.codepilot-media` 绝对路径兼容重写到 allowlisted `/api/media/serve`；远端 URL、普通站内路径、任意本地路径继续保持原合同，历史消息无需改库即可回显。
- [ ] 真实账号 smoke 分列：模型目录、exact model routing、image generation、image edit、image-to-video/reference-to-video、free/X Basic entitlement 反例；每项记录实际 endpoint/model、输出资产和账单/weekly allowance 可见性。

## 关键文件（供实施定位，不是限制性清单）

| 范围 | 文件 |
|---|---|
| Provider schema/CRUD | `src/lib/db.ts`、`src/types/index.ts`、`src/app/api/providers/*` |
| Catalog/matcher | `src/lib/provider-catalog.ts`、`src/components/settings/provider-presets.tsx` |
| Provider UI | `src/components/settings/ProviderManager.tsx`、`ProviderForm.tsx`、`ProviderCard.tsx` |
| Runtime/model gate | `src/lib/runtime-compat.ts`、`src/lib/provider-resolver.ts`、`src/app/api/providers/models/route.ts` |
| CodePilot model factory | `src/lib/ai-provider.ts`、`src/lib/agent-loop.ts` |
| Codex translator | `src/lib/codex/provider-proxy.ts`、`src/lib/codex/proxy/*` |
| xAI X Search tool/events | `src/lib/agent-tools.ts`、`src/lib/agent-loop.ts`、`src/lib/codex/proxy/*`、聊天流 tool/source 渲染组件 |
| Usage-policy choke points | `src/lib/provider-resolver.ts`、`src/lib/claude-client.ts`、`src/lib/text-generator.ts`、`src/lib/agent-task-runner.ts`、`src/lib/context-compressor.ts`、`src/lib/title-generation.ts` |
| 自动/辅助调用清单 | `src/lib/memory-extractor.ts`、`src/lib/memory-search-mcp.ts`、`src/lib/onboarding-processor.ts`、`src/lib/checkin-processor.ts`、`src/lib/task-scheduler.ts`、`src/app/api/workspace/quick-actions/route.ts`、`src/app/api/dashboard/refresh/route.ts`、`src/app/api/cli-tools/[id]/describe/route.ts`、`src/app/api/skills/search/route.ts`、`src/app/api/media/jobs/plan/route.ts`、`src/app/api/chat/structured/route.ts` |
| OAuth precedent | `src/lib/openai-oauth.ts`、`src/lib/openai-oauth-manager.ts`、`src/app/api/openai-oauth/*` |
| Guardrails | `docs/guardrails/ProviderManagement.md`、`Runtime.md`、`DatabaseSchema.md`、`Onboarding.md`、`ElectronMain.md` |

## 依赖与相邻计划

- [模型目录与推理强度统一适配](./model-capability-reasoning-refresh.md)：拥有模型级 effort/capability 统一合同；本计划拥有 provider/product identity 与 SKU 白名单。
- MiMo UltraSpeed + OpenAI-compatible 三方 API（已完成并删除，见 git 历史）：拥有通用 OpenAI-compatible 基础；xAI 因 Responses + native SDK 建议使用 branded protocol，不复用 Chat Completions 假兼容。
- [tech-debt tracker #16](../tech-debt-tracker.md)：套餐 catalog 主动核准；千问部分由本计划接管。
- [tech-debt tracker #40](../tech-debt-tracker.md)：API key/OAuth 凭据统一加密仍是独立工程；本轮沿用现有 OAuth 存储架构并如实记录，不再把它设成 xAI 接入前置。

## 决策日志

- 2026-07-21：裁决“Coding Plan 改名 Token Plan”为错误。三个产品同时存在，必须保留三套稳定 identity。
- 2026-07-21：选择独立 `preset_key` 列而非继续依靠 URL 或藏入 `options_json`；personal/team 同 URL 是必须解决的产品身份问题。
- 2026-07-21：保留 `bailian-token-plan-cn` 作为团队版稳定 key，避免存量断链；个人版使用新 key。
- 2026-07-21：千问订阅 preset 标为 `interactive_only`，后台自动调用 fail closed；官方禁止非交互脚本/后端，不能只靠提示文案。
- 2026-07-21：Grok 4.5 API Key 与 SuperGrok OAuth 分开排期；OAuth 不阻塞官方 API 路径。
- 2026-07-21（用户裁决）：参考 OpenCode，接受复用公开 Grok CLI OAuth client id 的兼容风险并直接实施 browser/device OAuth；API Key 保留为稳定兜底。文案不得冒充 xAI 官方合作。
- 2026-07-21（用户裁决）：CodePilot 自有 OAuth client 与 Grok Build ACP 改为后续升级方向，不再阻塞本轮 xAI Provider OAuth；仍禁止读取/复用其他客户端 token 文件。
- 2026-08-13（Grok Build 合同刷新）：xAI 已公开 Grok Build 源码，旧 OpenCode/Grok CLI 快照不再是首选真源。Browser callback、scope、referrer 与订阅 inference host 按官方当前实现更新；这仍不代表 CodePilot 获得 xAI 官方合作身份，也不授权读取 Grok Build 本地凭据。
- 2026-08-14（Claude review P1/P2）：带阳性对照的生产 builder → `@ai-sdk/xai@4.0.18` 探针证明 high 正常发 wire，xhigh 在发网前失败且 0 请求；npm latest 仍为 4.0.18，因此升级路线当前不可用。官方 Grok Build commit `e5fd4816…` 又明确将 `x-grok-client-version` 用于 proxy version gate，并为 production proxy 注入 token-auth、authenticate-response、client-mode 与 identifier。裁决 4.6 增量 review failed：UI 暂只承诺 Low/Medium/High，外部 xhigh/max 折叠 High；补真实 SDK effort 矩阵、redirect URI 等值与完整 headers 测试后重跑定向/全量/build。2026-08-13 证据为定向 108/108、全量 5195 pass / 0 fail / 1 skipped、build 通过；commit 待提交，未跑真实 4.6 entitlement smoke。
- 2026-08-14（用户 426 反馈修复）：Electron dev 真实 `grok-4.6` / High 请求返回 `Grok CLI version (none) is outdated`，确认缺失 version header 是当前失败根因。修复将用户选择的 model id 注入 OAuth fetch，并强制发送上游整组 Build proxy headers；caller 无法伪造覆盖，wrong origin/path 在 refresh 前拒绝。真实 `@ai-sdk/xai` Responses wire 与正反例定向 222/222、全量 5197 pass / 0 fail / 1 skipped、production build 通过。该证据只记 Code complete + Tests pass；真实账号重试前不记 Smoke passed，XHigh 与 authenticated `/v1/models` 仍独立待修。
- 2026-08-14（Imagine 媒体适配）：采用“同一 media capability package、两个用户工具”而不是新增孤立 capability id：`codepilot_generate_image` 覆盖生成/编辑，`codepilot_generate_video` 覆盖 text/image/reference-to-video，三 Runtime 都产出同一 `MediaBlock`/Gallery 合同。OAuth media 与文本 proxy 使用独立精确 fetch；401 refresh 只重试一次，下载有 xAI CDN/MIME/250 MiB 门禁。公共 API 使用官方 `grok-imagine-image-2.0` / `grok-imagine-video-1.5`，不继承 Build 内部图片 alias。只记 Code complete + Tests pass；真实 entitlement/计费/资产 smoke 待用户验证。
- 2026-08-14（用户媒体回显反馈修复）：真实会话 `dd697228ecee5bb65a83de64baee7664` 出现 31 个步骤与裂图。根因是 `builtin-tools/index.ts` 同步 `require('./media')`，而 `media.ts` 经 `media-import-mcp.ts` 静态带入 Claude Agent SDK 后被 Turbopack 编成异步 chunk；同步加载失败又被空 `catch` 吞掉，模型因此看不到 `codepilot_generate_image`，转而长链路自行探测和写库。修复为依赖无关的 canonical media prompt + Native 静态媒体工具装配 + fail-visible 组装错误；同时把托管 `.codepilot-media` 绝对路径安全重写到 `/api/media/serve`。定向 65/65、全量 5215 pass / 0 fail / 1 skipped、production build 通过；dev/production 编译产物均确认 media 模块同步静态进入 `/api/chat`。真实页面回放中历史 PNG 以 2496×1664 加载且控制台 0 错误，记 UI replay Smoke passed；未发起新的计费生成请求，fresh `codepilot_generate_image` real-account smoke 仍待用户复验，commit 待提交。
- 2026-08-15（Claude 审查 remediation）：**Signal**：复审确认 xAI XHigh 在 SDK 序列化前崩溃，并指出媒体 provider/失败语义/授权可见性、英文媒体 gate 与动态 redirect 等值缺口。**Triage**：锁定 `@ai-sdk/xai@4.0.18` 只接受 none/low/medium/high；文本 session provider 不是图片计费真源；视频工具在 OAuth 不可用时不能挂载或宣称已连接。**Fix**：4.6 catalog 改为 L/M/H，builder 将外部 xhigh/max 折叠 High；图片路由只信显式 provider/model family/active image provider，xAI reference 校验仅作用于 xAI；三 Runtime 按 OAuth 状态挂载视频，Native 失败抛 tool error 并贯穿 AbortSignal；共享中英文媒体意图 gate；OAuth token form 严格断言 authorize 动态 redirect URI，文本/媒体 fetch 进一步拒绝 credential/query/hash 并禁重定向。**Verify**：生产 builder→锁定 SDK effort 矩阵、OAuth、媒体正反例与标准 `npm run test` exit 0；live dev lock 存在，production build 安全跳过。**Guardrail**：真实 Grok 4.6/Imagine entitlement、版本/identifier 服务端接受情况和 fresh 资产仍在 Smoke Ledger 待跑，本条只记 Code complete + Tests pass，不记 Review/Smoke passed。
- 2026-08-15（Claude 复审收尾 N1–N2）：**Signal**：四个原 P1 已闭环，但复审用 logged-out fixture 证明 compiler 仍从静态 descriptor 宣称视频可用，并打红 tool-loop golden；取消信号也仅到 Native，Claude MCP、Codex bridge 与 `/api/media/generate` 可继续消耗上游资源。**Triage**：工具提示的真源必须是当前 request 实际挂载的 bridge surface；媒体取消必须在每个入口复用同一 transport AbortSignal 合同。**Fix**：context compiler/runtime adapter 新增实际 `availableToolNames` 过滤，Codex proxy 传入 bridge `toolNames`，golden 显式固定 logged-out 状态并补 OAuth 正例；Claude MCP 从 SDK extra 提取 signal，Codex bridge 接收 execute options，确认 API 使用 `request.signal`，与 Native 一起传入生成、轮询和下载。**Verify**：两个原始失败先定向复现；修复后相关 7 文件 150/150，TypeScript 通过，touched ESLint 0 error；标准 `npm run test` 一次观测为 1218 suites / 5245 tests（5244 pass / 0 fail / 1 skipped），exit 0。**Guardrail**：Onboarding/Handover 固化“提示只描述实际挂载工具”和“四入口取消”；取消发生在轮询/下载完成前时不落库，下载字节已返回时保留可能已计费资产。production build 因 live dev lock 安全跳过，真实账号 fresh generation/video smoke 仍待跑，不记 Build/Smoke passed。
- 2026-08-15（Claude 第三轮复审 P3 收口）：**Signal**：复审确认全部 blocker 已真实闭环，但仓库只用源码 pin 证明四入口取消，文档误称“落盘前检查”；GLM 版本门宽松匹配任意三元组；全量的 Sentry initial-503 exactly-once 断言已在两台机器复现 flake。**Triage**：Imagine Stop 应阻止未完成轮询/下载，但不能丢弃已完整下载、可能已计费的资产；版本能力必须按真实 `codex --version` release 比较；测试 flake 不属于 Grok 修复面却会破坏门禁可信度。**Fix**：`xai-imagine.test.ts` 收编取消后轮询冻结、无 Gallery 行、无 listener 残留及晚到取消保留已完成资产四项行为；Onboarding/Handover 改写取消边界；Codex provider effort 复用严格、prerelease-aware 的共享 release parser；tech-debt #86 登记 telemetry flake，并在状态/ledger 明示。**Verify**：新增相关定向组 117/117，TypeScript 与 touched ESLint 通过；标准全量 1218 suites / 5247 tests（5246 pass / 0 fail / 1 skipped），exit 0。该绿色观测不关闭 #86。**Guardrail**：本轮代码审查层 `Review passed（附条件）`；真实 entitlement/计费/CDN 与 build 仍按原 smoke 边界待跑。
- 2026-08-15（v0.67.0 发布门禁）：**Signal**：释放 live dev lock 后 production build 通过，但首次 production `@smoke` 为 21/22；Codex 自动代审 route 在真实 ChatGPT.app bundle 上返回 unsupported。**Triage**：严格 parser 只接受 bare/`codex-cli`，而 app-server availability 的真实版本是 `Codex Desktop/0.147.0-alpha.6.5 (...)`；这是 production-only 格式缺口，同时会误伤无账号缓存时的 GLM Max binary gate。**Fix**：共享 release parser 增加全串锚定且带明确产品前缀的 `Codex Desktop/<release>` grammar，继续拒绝无关 user-agent 中夹带的版本；补 CLI/Desktop 正反例。**Verify**：版本门定向 78/78；最终全量 1218 suites / 5247 tests（5246 pass / 0 fail / 1 skipped）；production build 通过（136 static pages，保留既有 NFT warning）；复跑 production `@smoke` 22/22。**Guardrail**：本条只提升 build/通用 route smoke，不替代 Grok 4.6/Imagine 真实 entitlement 与 fresh 资产 smoke；tech-debt #86 继续有效。
- 2026-07-21（用户裁决）：xAI OAuth 首版沿用现有 OpenAI OAuth 存储架构；tech-debt #40 继续独立治理，日志/API 脱敏与 refresh rotation 可靠性仍是本轮硬门。
- 2026-07-21（Claude 审查修订）：确认 `findPresetForLegacy` 与后台 17 个遗漏调用位点为 P1；identity 改为四路径统一，usage policy 改为必填 `callScene` 收口 gate，并明确 active-turn compact 与隐藏自动化的不同处置。
- 2026-07-21（审查事实校正）：OpenCode 当前源码有 26 个显式测试用例，合并 PR 的 runner 证据为 51 pass/144 expectations；两项同时保留，不再互相替代。
- 2026-07-21（审查裁决保留）：Coding Plan 不是整体停售；准确状态为 Lite 仅存量、Pro 限量可购。xAI 官方未文档化 OAuth revoke endpoint，因此只承诺本地 logout + 手动撤销入口。
- 2026-07-21（实现）：`preset_key` additive migration + 共享 identity resolver 已覆盖 DB/API/renderer/resolver/doctor/runtime；显式 managed identity 与 endpoint 不一致时拒绝保存，不允许通过改 URL 绕过 usage policy。
- 2026-07-21（实现）：调用策略使用 20 场景封闭联合；所有 credential-bearing 生成/流式入口要求 scene，Qwen 三套餐在未知/自动场景 fail closed，auxiliary tier 不借用套餐凭据。
- 2026-07-21（实现）：xAI API Key 使用 `@ai-sdk/xai` Responses、`providerOptions.xai` 与 `store:false`；connection test 在发送 bearer 前拒绝非官方 endpoint。
- 2026-07-21（实现）：xAI OAuth browser/device 共用一个 virtual identity；bundle 原子 JSON、refresh single-flight、rotation 与瞬时错误保留已落实，fetch 在 refresh 前做 official-origin gate 且 clone caller headers。
- 2026-07-21（实现）：测试导入暴露两个 Node 顶层 timer 会拖住 runner；只在 Node 环境对 stream snapshot GC 与 bridge delivery cleanup timer 调用 `unref()`，浏览器定时行为不变。
- 2026-07-22（Claude review gate）：修复 device UI 提前超时但服务端继续轮询，以及 abort 在 sleep/fetch 完成后仍可能落库的竞态；前端 deadline 对齐上游 `expires_in`，超时调用 server cancel，协议层与持久化边界都在写入前二次检查 abort。
- 2026-07-22（Claude P3 随手关闭）：browser callback 的 token exchange 也持有独立 AbortController，signal 透传 token fetch，并在解析后与落库边界再次检查；关闭/超时后到达的浏览器 token 响应不会持久化。
- 2026-07-22（Claude review gate）：把 legacy `preset_key` 身份采纳与 catalog reconcile 拆成两个显式意图；普通编辑不再静默整理模型，套餐选择器会先说明影响再发送 `reconcile_catalog`。
- 2026-07-22（Claude review gate）：修正 ModelDiscovery、Onboarding、ProviderManagement、DatabaseSchema 中 5 处 endpoint、符号名、分组数量和测试文件 breadcrumb 漂移。
- 2026-07-22（用户真实反馈）：xAI OAuth 浏览器登录成功后等待 status poll 的短窗口仍显示设备码入口，造成“还需要设备码”的误解。UI 增加本次登录方法状态：browser 只显示浏览器等待说明并明确无需设备码；只有显式选择 device 才请求/展示 user code。
- 2026-07-22（用户真实反馈）：CodePilot 已完成 xAI OAuth 登录，但 xAI 浏览器页仍停在“输入此代码以完成登录”。根因是 loopback callback 只给 OPTIONS 预检返回 CORS/PNA，实际 GET 成功响应缺少允许源头，xAI 页面脚本无法读取完成结果；修复为对 allowlist 内的 xAI origin 在 OPTIONS/GET 全程返回相同 CORS/PNA/Vary 头，其他 origin 继续 fail closed。
- 2026-07-22（用户真实复验）：补齐 callback GET 的 CORS/PNA 后，用户再次完成 xAI OAuth 浏览器登录并确认授权完成页行为正常；关闭该反馈项，未据此扩展为 device/refresh/tool/logout 已验收。
- 2026-07-22（v0.59.0 发布裁决）：用户在 callback 复验通过后明确要求 push 并发版。发布提交 `a740acb`；门禁采用 4532/4532 unit、19/19 Web smoke、production/Electron build，以及与正式 CI 一致的 ad-hoc macOS arm64 DMG 深度签名和版本校验；用户接受计划中仍列为待测的 device/refresh/tool/effort、Qwen Team/Coding、xAI API Key 与 packaged 真实登录继续留在 active ledger，不把它们误写为已验收。
- 2026-07-22（本地打包诊断；2026-08-12 更正）：默认 `npm run electron:pack:mac` 自动发现本机 Developer ID 后，生成的最终 bundle 签名失效；当时正式 CI 用 `CSC_IDENTITY_AUTO_DISCOVERY=false` 重打 ad-hoc bundle/DMG 并通过 deep/strict。后续 Safe Storage 取证证明“公开发版不受影响”结论错误：ad-hoc 身份漂移会触发钥匙串 ACL 授权。tech-debt #57 已以 stable/preview Developer ID + exact Team ID + 最终产物后置 gate 关闭。
- 2026-07-22（0.59.0 packaged 用户反馈）：另一台 macOS 在 `127.0.0.1:10987` HTTP system proxy 下，xAI 浏览器授权与 loopback 已完成，但 `auth.x.ai/oauth2/token` 报 transport-level `fetch failed`（无 HTTP status/OAuth code）。根因是 browser 使用系统代理，而 packaged Next/Node 全局 fetch 只收到 proxy env、没有显式 dispatcher，token exchange 仍直连。
- 2026-07-22（0.59.1 修复）：新增 opt-in env proxy fetch，覆盖 xAI browser/device/refresh/bearer 全生命周期；HTTP(S) proxy 使用 Undici `ProxyAgent`，遵循 `NO_PROXY`，不设置 global dispatcher，SOCKS/PAC 保持既有 direct/TUN 行为。底层错误只追加稳定 code，不记录代理地址/凭据；定向 44/44，含真实本地 CONNECT tunnel 反例。
- 2026-07-22（0.59.1 Claude release gate）：独立复验未发现 P0/P1/P2；P3 文案与注释当场收口，并记录 undici 大版本维护钉子。既有 `NO_PROXY` matcher 对裸 IPv6 `::1` 的端口剥离缺陷不影响本次 xAI 域名链路，留作后续 matcher 债务，不在 release gate 临时扩行为。
- 2026-07-22（0.59.1 发布提交）：修复提交 `a61faa4`；pre-commit 再次通过 4537/4537，发版标签只在本条回写、工作区清洁与远端 main 推送成功后创建。
- 2026-07-22（0.59.1 正式发布）：`v0.59.1` 指向计划回写提交 `51e2edb`；GitHub Actions run `29895409535` 的 verify-source、macOS arm64/x64、Windows x64、release jobs 全绿。稳定 Release 已上传两套 DMG/ZIP、Windows EXE 与 `SHA256SUMS.txt`；同一故障电脑的 HTTP proxy 真实复测继续保留 ⏳。
- 2026-07-22（0.59.1 packaged 用户复验）：同一账号在故障 macOS 上首次经 Dia 完成 OAuth 后，CodePilot Runtime 调用 `grok-4.5` 收到 xAI team RPM `0/0`；改默认浏览器为 Chrome、重新授权后同账号可正常回复。当前电脑 dev 的同账号/xAI OAuth/CodePilot Runtime 也正常。按用户裁决只记录为 Dia 授权上下文相关观察，不修改代码、不泛化为 Dia 必现缺陷；未据此关闭 refresh/device/tool 或 Windows 验收。
- 2026-07-23（用户反馈与能力审计）：用户指出 Grok 应能直接检索推特/X，且 OAuth 登录的 Grok 也应具有同样能力。审计确认当前只接入 `xai.responses('grok-4.5')` 与 CodePilot 客户端函数工具，未发送 xAI hosted `x_search`；官方 SDK 已提供 `xai.tools.xSearch()`。裁决新增 Phase 7，API Key/OAuth 与 CodePilot/Codex Runtime 四组合分别验收；OAuth `api:access` scope、登录成功和文本回复不再被当作 `x_search` entitlement 证据。
- 2026-07-27（Phase 7 实现，commit `ec7f356a`）：选择共享 `xai-hosted-search.ts` 作为 provider-aware hosted-tool、外部 source 与失败分类真源。Native 直接把 provider-executed event 映射到现有 SSE；Codex proxy 抑制 Codex 不应执行的 hosted call，同时通过既有 per-session event bus 镜像 lifecycle，避免建立第四套工具协议。SDK request-shape 证明 function tool 与 `x_search` 可同请求混用；提交门禁为 4686/4686、production build 通过，真实 entitlement、来源质量和四组合可用性仍只能由凭据 smoke 关闭。
- 2026-07-27（Phase 7 真实 smoke）：会话 `e034a05b12615c632393018afbb3449b` 证明 xAI OAuth × CodePilot Runtime × `grok-4.5` 能执行并持久化原生 `x_search`。DB 中共有 21 个成功 `x_search` tool result，最终纠错轮含 54 个唯一 `x.com` URL，来源信任均为 `external`；用户确认最终交互可用。核对同时发现 response-level 54 个 citations 被复制到该轮 14 个 tool result（756 source rows、消息约 119 KB）；记为非阻塞 P3，后续应把 response-level 来源只归属一次，避免存储与详情 UI 线性膨胀，不影响本次能力结论。
- 2026-07-27（v0.60.0 正式发布）：Grok X Search 随 `v0.60.0` 发布（feature commit `ec7f356a`，release commit `d6c4090e`）；GitHub Actions run `30272492570` 全绿。Release Notes 按台账口径注明"已验证 xAI OAuth × CodePilot Runtime 组合，API Key 与 Codex Runtime 组合仍在验证中"，未把 X Search 宣称为全组合 capability verified；其余三组合与 citation fan-out P3 保持待办。
- 2026-07-27（v0.60.0 Sub-agent route 回归）：另一台已更新客户端中，xAI OAuth Grok 4.5 主会话可访问，但 managed Sub-agent 枚举不到该 route。根因是 OAuth virtual Provider 只在模型 API 手工追加、不存在于 `providers` 表，而 Sub-agent 目录只遍历 DB。修复为 picker、resolver、managed Sub-agent 共用认证感知 catalog；CodePilot/Codex 包含精确 `xai-oauth/grok-4.5`，Claude Code 不因本修复放宽协议兼容。自动化覆盖路由/认证负例，定向 93/93、完整 unit 4703/4703、production build 通过；真实 packaged Sub-agent + X Search 仍单列待测。
- 2026-07-27（Claude review P2 闭环）：Claude route 不再靠“未枚举 OAuth virtual Provider”碰巧排除 Grok，而是先消费共享候选、再由精确 `codepilot_only/xai` compat 过滤；Codex proxy 也不再复制 compat/protocol，改从共享静态定义派生。变异可观测的 compat/protocol 与 proxy metadata parity 回归已加入；定向 93/93、完整 unit 4703/4703、production build 通过。
- 2026-07-27（Packaged real smoke）：当前提交 `7ea8100e` 构建的 macOS arm64 0.60.0 `.app` 通过深度签名校验；packaged server 使用同一 Electron 原生 ABI 与真实 SuperGrok OAuth 完成三条独立会话。CodePilot managed child `d14f966d847de5a16c7f7714d824ac96` 真实执行 5 次 `x_search`；Codex Account managed child `2818c311bea4e0cd5f54c5a2760a95fe` 命中 `xai-oauth/grok-4.5` 并 durable completed；Codex direct `7ef47943f864e9c58728a2b863cd8ffb` 的 canonical SSE 明确出现 8 次命名 `x_search` 与 external X sources，故 Phase 7 的 OAuth × Codex 组合由 1/4 提升为 2/4。真实 Electron renderer 复核两条 child 各 1 个 completed Grok 胶囊、详情路由/Runtime 正确。Smoke 同时再次证实 response-level citation/tool-result fan-out：Codex direct 一轮 272 个渐进 tool-result，Native child 最近 200 条 lifecycle 几乎全被匿名 completed 事件占满；Codex managed child 详情只显示匿名 item，未保留 hosted-tool 名称。能力 smoke 通过，但去重和 child lifecycle provenance 继续作为 tech-debt #58，不把体验标为完全收口。

## Release Notes 草案（已写入 `RELEASE_NOTES.md`，版本 v0.59.1）

### 修复问题

- 修复开启 HTTP(S) system proxy 时，xAI 浏览器授权成功但 CodePilot 后台 token exchange 因直连失败而无法完成登录的问题。
- xAI browser/device/refresh 与后续 Grok 请求统一遵循 proxy env 和 `NO_PROXY`，不全局影响其他 Provider 或 loopback。
- 明确 HTTP(S) proxy 支持边界；SOCKS/PAC 保持直连，TUN 模式仍可接管该连接。

### 优化改进

- 网络失败附带脱敏底层 code，帮助区分 DNS、连接拒绝和连接重置，不记录 proxy URL、认证信息或 token。

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

> 实施 Agent 未读取、记录或代填用户凭据。用户在 Electron dev 中确认：xAI OAuth 浏览器登录、Qwen Token Plan 个人版均在 CodePilot/Codex Runtime 完成连接与回复；未报告的模型/轮次/tool/refresh 等字段不作推断。未覆盖路径继续保持 ⏳，自动化/mock 证据不得替代真实凭据 smoke。

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|---|---|---|---|---|---|---|---|
| 2026-07-21 | research | Qwen Token Plan personal/team | exact catalogs | 官方文档 | 产品/URL/模型/条款核验 | ✅ | research fact base |
| 2026-07-21 | research | OpenCode xAI | Grok OAuth | 源码/PR/官方文档 | PKCE/device/refresh/client ownership 核验 | ✅ | research fact base |
| 2026-07-21 | release recheck | Qwen Coding/Token Plan + xAI | exact allowlists / grok-4.5 | 官方页面 | 发布前 slug/白名单复核 | ✅ | Qwen 个人 6、团队 15、Coding 10；xAI 官方 model page `grok-4.5` |
| 2026-07-21 | unit | all | all | isolated/mock | 首轮 `npm run test` | ❌ 4524/4526 | 两个旧 source-contract 断言未接受 xAI OAuth 第三入口/skills shared resolver；生产行为测试未失败 |
| 2026-07-21 | unit | all | all | isolated/mock | 修订合同后 `npm run test` | ✅ 4526/4526 | typecheck + 1099 suites，29.3s |
| 2026-07-21 | unit | Qwen identity/policy + xAI API/OAuth/UI | exact catalogs / grok-4.5 | isolated/mock | 高风险定向回归 | ✅ 78/78 | policy 27、OAuth protocol/manager 36、其余 identity/API/UI |
| 2026-07-21 | web | CodePilot UI/routes | n/a | isolated local dev | `npm run test:smoke` | ✅ 19/19 | Playwright `@smoke`，19.9s |
| 2026-07-21 | build | Electron main/standalone | n/a | sandbox local build | 首轮 `npm run electron:build` | ❌ 环境阻断 | Turbopack CSS worker 绑定本地端口被 sandbox EPERM 拒绝；非源码编译错误 |
| 2026-07-21 | build | Next + Electron main/standalone | n/a | escalated local build | production/electron build | ✅ | `npm run build`、重跑 `npm run electron:build`；保留既有 NFT dynamic-trace warning |
| 2026-07-21 | policy-negative | Qwen Token Plan personal/team | configured default | mock credential | automatic scenes blocked before model/fetch | ✅ | `provider-call-policy.test.ts`；真实 provider 负向 smoke 仍待凭据 |
| 2026-07-22 | review-targeted | xAI OAuth + Qwen preset adoption | device grant / shared Token Plan URL | isolated/mock | timeout cancel、sleep/fetch abort、late persistence、显式 reconcile | ✅ 49/49 | 新增 4 个回归用例；协议/manager/UI/route 定向通过 |
| 2026-07-22 | unit | all | all | isolated/mock | Claude review 修复后 `npm run test` | ✅ 4530/4530 | typecheck + 1099 suites，28.1s |
| 2026-07-22 | review-targeted | xAI OAuth | browser/device grant | isolated/mock | browser exchange cancel + device 四层取消防线 | ✅ 39/39 | protocol 19 + manager 20；迟到 browser response 不落库 |
| 2026-07-22 | unit | all | all | isolated/mock | P3 首轮 `npm run test` | ❌ typecheck | 新测试的 catch 结果为 `void \| Error`，断言前缺类型收窄；生产代码未进入单测阶段 |
| 2026-07-22 | unit | all | all | isolated/mock | 类型收窄后 `npm run test` | ✅ 4531/4531 | typecheck + 1099 suites，26.0s |
| 2026-07-22 | codepilot_runtime | xAI OAuth | grok-4.5 | SuperGrok browser OAuth | 登录、连接、文本回复 | ✅ 用户手测 | Electron dev；未覆盖 device/refresh/tool/logout |
| 2026-07-22 | codex_runtime | xAI OAuth | grok-4.5 | SuperGrok browser OAuth | 登录、代理连接、文本回复 | ✅ 用户手测 | Electron dev；未覆盖 refresh/tool/logout |
| 2026-07-22 | codepilot_runtime | Qwen Token Plan Personal | 用户所选模型（未记录） | `sk-sp-` personal | 连接、文本回复 | ✅ 用户手测 | Electron dev；未据此推广 tool/effort/context |
| 2026-07-22 | codex_runtime | Qwen Token Plan Personal | 用户所选模型（未记录） | `sk-sp-` personal | 代理连接、文本回复 | ✅ 用户手测 | Electron dev；未据此推广 tool/effort/context |
| 2026-07-22 | review-targeted | xAI OAuth | browser/device UI + lifecycle | isolated/mock | browser 方法锁定、无需设备码文案、取消边界 | ✅ 47/47 | UI 8 + protocol 19 + manager 20 |
| 2026-07-22 | unit | all | all | isolated/mock | 用户 OAuth UI 反馈修复后 `npm run test` | ✅ 4532/4532 | typecheck + 1099 suites，23.6s |
| 2026-07-22 | electron-dev | xAI OAuth | browser loopback | SuperGrok browser OAuth | CodePilot 登录成功后的 xAI 完成页 | ⚠️ 登录成功、页面未收起 | 用户截图；callback GET 缺 CORS/PNA，浏览器脚本无法读取成功响应 |
| 2026-07-22 | review-targeted | xAI OAuth | browser loopback | isolated/mock | allowlisted GET callback CORS/PNA + origin fail-closed | ✅ 47/47 | manager 20 + protocol 19 + UI 8；真实页面在后续 ledger 行复验通过 |
| 2026-07-22 | unit | all | all | isolated/mock | callback 完成页修复后 `npm run test` | ✅ 4532/4532 | typecheck + 1099 suites，28.7s |
| 2026-07-22 | electron-dev | xAI OAuth | browser loopback | SuperGrok browser OAuth | callback 完成页修复后的真实页面复验 | ✅ 用户手测 | 用户确认“好了，没问题”；仅关闭完成页反馈，不推广到 device/refresh/tool/logout |
| 2026-07-22 | local-package | macOS arm64 | CodePilot 0.59.0 | auto-discovered Developer ID | 默认 `npm run electron:pack:mac` 后签名复核 | ❌ 签名失效 | builder 内 afterSign 曾通过，但最终 `.app`/DMG `codesign --verify --deep --strict` 失败；2026-08-12 已增加正式/preview Developer ID 与最终 bundle 后置门禁，见已关闭 tech-debt #57 |
| 2026-07-22 | ci-equivalent-package | macOS arm64 | CodePilot 0.59.0 | ad-hoc（与 `build.yml` 一致） | DMG/ZIP、DMG 内 app 深度签名与版本 | ✅ | `CSC_IDENTITY_AUTO_DISCOVERY=false`；DMG 内 `.app` valid on disk，版本 0.59.0；未替代 packaged 真实登录 |
| 2026-07-22 | web | CodePilot UI/routes | n/a | isolated local dev | 打包后未恢复 Node ABI 的首轮 `npm run test:smoke` | ❌ 9/19 | `afterPack` 按设计把 workspace better-sqlite3 重编为 Electron ABI 143，Node dev ABI 127 导致 API 500；`npm rebuild better-sqlite3` 后恢复 |
| 2026-07-22 | web | CodePilot UI/routes | n/a | isolated local dev | 恢复 Node ABI 后首轮完整 smoke | ⚠️ 18/19 | API 全部恢复 200；既有 composer 清空用例在并发冷编译中一次 5s 超时 |
| 2026-07-22 | web | CodePilot UI/routes | n/a | isolated local dev | 预热后完整 `npm run test:smoke` | ✅ 19/19 | 9.1s，零失败 |
| 2026-07-22 | packaged-macos | xAI OAuth 0.59.0 | browser code exchange | SuperGrok + HTTP system proxy `127.0.0.1:10987` | 浏览器授权、loopback、token exchange | ❌ transport failure | 用户提供 sanitized main log；browser/callback 到达，server `fetch` 无 status/code，确认网络分流 |
| 2026-07-22 | review-targeted | xAI OAuth 0.59.1 | browser/device/refresh/bearer proxy | isolated + local CONNECT proxy | env precedence、NO_PROXY、dispatcher cache、不可解析目标经 proxy 到达、OAuth 生命周期 | ✅ 44/44 | proxy 4 + protocol 20 + manager 20；低层 code 脱敏 |
| 2026-07-22 | unit | all | all | isolated/mock | 0.59.1 `npm run test` | ✅ 4537/4537 | typecheck + 1100 suites，零失败 |
| 2026-07-22 | web | CodePilot UI/routes | n/a | isolated local dev | 0.59.1 `npm run test:smoke` | ✅ 19/19 | Playwright `@smoke`，17.6s；dev server 已正常关闭 |
| 2026-07-22 | ci-equivalent-package | macOS arm64 | CodePilot 0.59.1 | ad-hoc（与 `build.yml` 一致） | DMG/ZIP、DMG 内 app 深度签名、版本、Electron ABI、packaged server health | ✅ | `CSC_IDENTITY_AUTO_DISCOVERY=false`；版本 0.59.1，ABI 143，server health `127.0.0.1` 通过；未替代真实代理登录 |
| 2026-07-22 | ci-package | macOS arm64/x64 | CodePilot 0.59.1 | GitHub Actions | 双架构 DMG/ZIP、版本、native ABI、packaged server、checksum | ✅ | run `29895409535`，build-macos 5m59s；资产已上传稳定 Release |
| 2026-07-22 | ci-package | Windows x64 | CodePilot 0.59.1 | GitHub Actions | EXE、版本、native ABI、packaged server、checksum | ✅ | run `29895409535`，build-windows 6m17s；资产已上传稳定 Release |
| 2026-07-22 | packaged-macos | xAI OAuth 0.59.1 | grok-4.5 / codepilot_runtime | SuperGrok + HTTP system proxy + Dia | 浏览器授权、登录、文本回复 | ⚠️ 授权成功、推理被拒 | xAI 返回 team RPM `0/0`；同账号随后改用 Chrome 授权成功，故不归因于账号权限或 0.59.1 proxy |
| 2026-07-22 | packaged-macos | xAI OAuth 0.59.1 | grok-4.5 / codepilot_runtime | SuperGrok + HTTP system proxy + Chrome | 重新授权、登录、文本回复 | ✅ 用户复验 | 同一账号改默认浏览器为 Chrome 后正常；仅关闭 packaged macOS browser login + one-turn text，不推广到 Dia 普遍兼容、refresh/device/tool |
| 2026-07-23 | claude_code | Aliyun Token Plan（用户当前配置） | qwen3.8-max-preview / qwen3.7-max | 用户本地 Token Plan | managed Sub-agent one-turn entitlement probe | ❌ 403 | 两个模型均返回 `Access to model denied`；仅证明当前 provider/account/plan route 不可访问，不证明 Qwen 3.8 Max Preview 全局下线；旧 UI 的 completed 误判由 Sub-agent P1 修复处理 |
| 2026-07-27 | phase7-contract | xAI API/OAuth assembly | grok-4.5 | isolated/mock | provider-aware injection、mixed request shape、Codex/Native lifecycle、external sources 持久化、错误分类 | ✅ 218/218 targeted | 不使用真实凭据；只证明接线与序列化合同，不能替代下方四组合 smoke |
| 2026-07-27 | unit | all | all | isolated/mock | Phase 7 完整 `npm run test` | ✅ 4686/4686 | typecheck + 1116 suites，零失败；不替代真实 xAI entitlement/source smoke |
| 2026-07-27 | build | Next production | all | local build | Phase 7 `npm run build` | ✅ | production compile + typecheck + 128 static pages；保留既有 NFT dynamic-trace warning |
| 2026-07-27 | route-contract | xAI/OpenAI OAuth virtual | grok-4.5 / shared GPT catalog | isolated authenticated token fixtures | picker、resolver、CodePilot/Codex managed Sub-agent route 同源；unauth/disabled/Claude negative | ✅ 93/93 targeted；4703/4703 full；build ✅ | 修复 v0.60.0 非 DB OAuth route 漏枚举；不发外部请求，不替代 packaged 用户 smoke |
| 2026-07-27 | packaged macOS arm64：codepilot_runtime / codex_runtime | xAI OAuth | grok-4.5 | SuperGrok browser OAuth | managed Sub-agent route + 文本 + `x_search` + Electron 胶囊/详情 | ✅ 路由/调用/UI；⚠️ lifecycle 去重 | 当前提交 `7ea8100e` 构建的 0.60.0 `CodePilot.app` 深度签名通过。CodePilot session `d14f966d847de5a16c7f7714d824ac96`：1 child、5 次 `x_search`、DB requested/effective 均为 `xai-oauth/grok-4.5`；Codex Account session `2818c311bea4e0cd5f54c5a2760a95fe`：1 次 managed child、DB requested `xai-oauth/grok-4.5`、effective `xai-oauth/Grok 4.5`。真实 Electron renderer 中两会话各 1 个 completed Grok 胶囊，详情路由/Runtime 正确；Codex proxy 命名 `x_search` 由 session `7ef47943f864e9c58728a2b863cd8ffb` 独立证明。首次 GUI 启动曾出现 47823 TCP 已监听但 HTTP 无响应；干净退出重启后 `/api/health` 与 renderer 验证均通过，暂记一次性未复现观察。重复增量事件与 child 详情匿名 item 记 tech-debt #58。 |
| 2026-08-13 | unit / contract / build | xAI API + Grok Build OAuth | grok-4.6 / grok-4.5 legacy | isolated/mock | 4.6 目录、动态 loopback/scopes/host gate 与公共 API Key 隔离 | ❌ Review failed；Tests 108/108 targeted、5195/0/1 full、build ✅ | XHigh 被真实 SDK 发网前拒绝；proxy version/authenticate-response/client-mode headers 缺失。原测试结果保留为事实，但不计 Review passed 或 Smoke passed |
| 2026-08-14 | electron-dev / codepilot_runtime | Grok Build OAuth | grok-4.6 / High | 用户真实 browser OAuth | 登录后 one-turn 文本推理 | ❌ HTTP 426 | 上游原文：`Your Grok CLI version (none) is outdated. Please update to version 0.1.202 or later`；日志确认当前请求未发 `x-grok-client-version`。OAuth 登录成功不等于推理合同通过，且本次尚未到达 model-override/effort 裁决阶段 |
| 2026-08-14 | wire-contract / unit / build | Grok Build OAuth | grok-4.6 / High | isolated token fixture | 426 修复：完整客户端 headers、exact route、实际模型覆盖、真实 AI SDK Responses 序列化 | ✅ Tests pass；Smoke pending | 定向 222/222；全量 5197 pass / 0 fail / 1 skipped；`npm run build` 通过并保留既有 NFT warning。未使用真实凭据，不覆盖上一行失败；等待用户在重启后的 Electron dev 复验 |
| 2026-08-14 | media wire / unit / build | Grok Build OAuth | Grok Imagine Image 2.0 / Video 1.5 | isolated token/media fixtures | image generate/edit、video submit/poll/download、401 refresh、header/host/path 负例、Gallery provenance | ✅ Tests + build pass；Smoke pending | 全量 5207 pass / 0 fail / 1 skipped；production build 通过并保留既有 NFT warning；未使用真实凭据、未产生上游费用；真实 image/edit/video entitlement、输出资产与套餐计量待测 |
| 2026-08-14 | electron-dev / codepilot_runtime | Grok Build OAuth | Grok Imagine Image 2.0 | 用户既有 browser OAuth 会话（未发新请求） | Native 媒体工具装配 + 历史本地图片回放 | ✅ UI replay Smoke passed；fresh generation pending | 会话 `dd697228ecee5bb65a83de64baee7664`；修复后 dev/production `/api/chat` 编译产物均静态包含 image/video/import，历史 PNG 经 `/api/media/serve` 以 2496×1664 加载，renderer console 0 error。定向 65/65、全量 5215 pass / 0 fail / 1 skipped、production build 通过；未替代新一轮真实生成、编辑、视频与套餐计量 smoke |
| 2026-08-15 | unit / contract | xAI API + Grok Build OAuth | grok-4.6 / Imagine | isolated fixtures | Claude 三轮审查 remediation：真实 SDK effort 矩阵、redirect 等值、媒体路由/失败、实际挂载提示、四入口 AbortSignal 与取消资产边界 | ✅ Review passed（附条件）；修复面 Tests pass；Smoke pending | 新增相关定向组 117/117；全量曾 5244/0/1，也在第三轮复审观测 5242/2/1，后者两个失败均属 tech-debt #86 的 telemetry flake。production build 因 live `.next/dev/lock` 安全跳过；未使用真实凭据，不覆盖 426 或 fresh generation 待测记录 |
| 2026-08-15 | unit / contract | Grok Build OAuth | Grok Imagine Video 1.5 | isolated abort/download fixtures | 取消后轮询冻结、不落库、listener 清理；下载字节已完成时保留可能已计费资产 | ✅ Tests pass；Smoke pending | 定向相关组 117/117；标准全量 1218 suites / 5247 tests（5246 pass / 0 fail / 1 skipped），exit 0。已知 telemetry flake 仍由 tech-debt #86 跟踪，不因本次绿色关闭 |
| 2026-08-15 | production build / Playwright | Grok/GLM shared runtime surface | catalog + Codex capability route | 本机 ChatGPT.app bundle；无外部 provider 请求 | v0.67.0 build + production `@smoke`，含 Codex auto-review/version gate | ✅ Build + Smoke passed；真实凭据 pending | 首轮 21/22 捕获 `Codex Desktop/0.147.0-alpha.6.5 (...)` 被误拒；修复后版本门定向 78/78、全量 5246/0/1、production build 136 pages、`@smoke` 22/22。未调用 xAI/GLM 外部服务，不覆盖 entitlement 待测行 |
| _待测_ | claude_code | Qwen Token Plan Personal | qwen3.8-max-preview | `sk-sp-` personal | two-turn + tool + effort | ⏳ | |
| _待测_ | codepilot_runtime | Qwen Token Plan Team | qwen3.8-max-preview | `sk-sp-` seat | two-turn + tool + usage gate | ⏳ | |
| _待测_ | claude_code | Qwen Token Plan Team | deepseek-v3.2 / kimi-k2.7-code / MiniMax-M2.5 | `sk-sp-` seat | Anthropic wire one-turn/model | ⏳ | |
| _待测_ | codex_runtime | Bailian Coding Plan | qwen3.7-plus | `sk-sp-` coding plan | two-turn + provider binding | ⏳ | |
| _待测_ | codepilot_runtime | xAI API | grok-4.6 | `XAI_API_KEY` | Responses two-turn + client function tool + Low/Medium/High | ⏳ | 不代表 X Search |
| _待测_ | codex_runtime | xAI API | grok-4.6 | `XAI_API_KEY` | proxy two-turn + client function tool + Low/Medium/High | ⏳ | 不代表 X Search |
| _待测_ | codepilot_runtime | Grok Build OAuth | grok-4.6 | browser/device | login + full proxy headers + refresh + two-turn + tool + logout | ⏳ | 不代表 X Search |
| _待测_ | codex_runtime | Grok Build OAuth | grok-4.6 | browser/device | proxy headers + two-turn + client function tool + refresh | ⏳ | 不代表 X Search |
| _待测_ | codepilot_runtime | xAI API | grok-4.6 | `XAI_API_KEY` | `x_search` + X citations | ⏳ | Phase 7；需真实 server-side tool event |
| 2026-07-27 | codepilot_runtime | xAI OAuth | grok-4.5 | SuperGrok browser OAuth | `x_search` + X citations + persistence | ✅ 用户 smoke + DB 复核 | 会话 `e034a05b12615c632393018afbb3449b`：21 个成功 `x_search`；最终纠错轮 54 个唯一 `x.com` 来源、全部 `trust=external`。发现 citations 在同轮 tool result 间重复存储，已在决策日志留账 |
| _待测_ | codex_runtime | xAI API | grok-4.6 | `XAI_API_KEY` | proxy `x_search` + X citations | ⏳ | Phase 7；独立于 CodePilot Runtime |
| 2026-07-27 | packaged codex_runtime | xAI OAuth | grok-4.5 | SuperGrok browser OAuth | proxy `x_search` + X citations + entitlement | ✅ Provider/tool；⚠️ source fan-out | direct session `7ef47943f864e9c58728a2b863cd8ffb`：packaged proxy SSE 明确收到 8 次命名 `x_search` tool-use 与外部 `x.com` sources，最终返回可核验 X 链接；持久化 assistant transcript 含 7 个命名 `x_search` block 与 112 个 `trust=external` source 实例。结合 managed child session `2818c311bea4e0cd5f54c5a2760a95fe` 的 exact route/terminal 事实，关闭 OAuth × Codex 组合；API Key 仍独立待测。渐进 tool-result/source 重复沿用既有 citation fan-out P3。 |
| _待测_ | background-negative | Qwen Token Plan personal/team | configured default | `sk-sp-` | scheduled + heartbeat + auto-memory → 0 upstream requests | ⏳ | |
