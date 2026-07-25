# 千问 Token Plan 与 Grok 4.5 接入

> 创建时间：2026-07-21
> 最后更新：2026-07-22
> 状态：🟡 Phase 0–5 代码与文档及 review gate 修复已完成；0.59.0 在另一台开启 HTTP system proxy 的 packaged macOS 上暴露浏览器成功、server token exchange 直连失败，0.59.1 已完成局部 env-proxy fetch、Claude release-gate 复审、自动化回归、本地安装包验证与正式双平台 CI，并发布稳定 GitHub Release。设备码、refresh/tool/effort、其他 Qwen 套餐和 0.59.1 packaged 双平台真实登录仍待验证，因此计划保持 active。
> 事实基线：[千问 Token Plan 与 Grok OAuth 接入调研](../../research/qwen-token-plan-grok-oauth-2026-07-21.md)

## 用户问题与争议

用户观察到阿里云百炼 Codeplan 的文档入口变成千问 Token Plan，并希望按新产品迭代；同时希望参考 OpenCode 截图，通过 Grok/SuperGrok OAuth 使用账号内的 Grok 4.5 额度。

调研后的取舍不是“把百炼改个名字，再复制一份 OpenCode OAuth”：

- 千问侧当前有 **Coding Plan、Token Plan 个人版、Token Plan 团队版** 三个独立产品。个人版和团队版共用 URL，但模型目录、配额和数据条款不同；现有 URL matcher 无法可靠区分。
- Grok 侧，OpenCode 已经用公开 Grok CLI client id 做通 SuperGrok 浏览器/设备 OAuth。CodePilot 按用户裁决直接参考这条实现，同时把非自有 client 的上游可撤销风险写进产品文案、错误分类和发布 smoke。
- Grok 同时提供两条互不阻塞的渠道：官方 API Key + Responses，以及参考 OpenCode、复用公开 Grok CLI client 的 SuperGrok 浏览器/设备 OAuth。后者接受上游可能收紧的兼容风险，以 API Key 作为稳定兜底。

## 状态

| Phase | 内容 | 状态 | 用户能看到什么 |
|---|---|---|---|
| Research | 千问三产品与 OpenCode/xAI OAuth 事实核验 | ✅ 已完成 | 有可追溯的产品边界、精确模型白名单和 OAuth 风险结论 |
| Phase 0 | Provider preset 身份持久化与迁移 | ✅ 已完成 | 同一 Base URL 的个人版/团队版不会再被静默选错；不确定的旧配置会要求确认 |
| Phase 1 | 千问三套餐 preset、目录与使用策略 | ✅ 已完成 | 添加服务时可明确选 Coding Plan / Token Plan 个人版 / 团队版，并看到真实模型和条款 |
| Phase 2 | 千问三 Runtime 对齐与套餐场景 gate | ✅ 已完成（合同测试） | 前台交互可用；不允许的后台自动调用会被结构化拦截 |
| Phase 3 | xAI API Key + Grok 4.5 Responses | ✅ 已完成（mock/request-shape） | 可用 xAI API Key 在 CodePilot/Codex Runtime 选择 Grok 4.5 |
| Phase 4 | OpenCode-compatible SuperGrok OAuth 核心 | ✅ 已完成（协议/mock + browser text smoke） | 浏览器 OAuth 已在 CodePilot/Codex Runtime 真实回复；设备码、refresh/tool 仍待 smoke |
| Phase 5 | xAI 双渠道 UI、生命周期与 packaged hardening | ✅ 代码完成（含 0.59.1 HTTP(S) system-proxy bridge） | API Key/OAuth 并列可选；浏览器与 server xAI 请求不再因 Node fetch 默认直连而分流，packaged 双平台真实复验仍待验收 |
| Phase 6 | Tier 2 回归、真实凭据 smoke 与发布说明 | 🟡 0.59.1 已发布，外部验收部分通过 | proxy 定向 44/44、unit 4537/4537、Web smoke 19/19、build/electron:build、本地 macOS arm64 package 与正式 macOS arm64/x64、Windows x64 CI 全通过；其余外部项保留待测 |

## 范围与非目标

本计划负责：

- 三个千问订阅产品的稳定身份、文本模型目录、角色映射、运行时与交互式使用限制。
- xAI 官方 API Key 的 Grok 4.5 Responses 接入。
- 参考 OpenCode 实现 SuperGrok 浏览器 PKCE、device-code OAuth、token refresh 和 xAI API 请求注入。

本计划不负责：

- 不把千问图片/视频模型塞进聊天 picker；多模态生成和 Harness 工具另立计划。
- 不把 OpenCode Zen 当成 xAI/SuperGrok，不接 `grok-build-0.1` 网关 SKU。
- 不读取或复制 `~/.grok`、OpenCode `auth.json` 等其他客户端凭据。
- 不把复用公开 Grok CLI client 描述成 xAI 与 CodePilot 的官方合作；申请自有 client 是后续升级，不是当前前置。
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

## Phase 3：xAI API Key + Grok 4.5 Responses

### 用户会看到什么

Settings → 添加服务中出现 xAI；用户粘贴 `XAI_API_KEY` 后，可以在 CodePilot Runtime 与 Codex Runtime 选择 `Grok 4.5`。Provider 卡和模型菜单明确标注“xAI API Key”，不把它写成 SuperGrok 订阅登录。

### 本阶段不做什么

- 不等 OAuth 决策才开始。
- 不把 xAI 归类成普通 OpenAI-compatible Chat Completions preset。
- 不向 Claude Code Runtime 暴露 Grok 4.5。
- 不加入未经 xAI API 文档/真实账号证实的 `grok-build` 别名或 OpenCode Zen SKU。

### 执行清单

- [x] 引入 `@ai-sdk/xai`；新增显式 `xai` protocol/sdk type，并更新 catalog、resolver、adapter、compat 和 form。
- [x] branded preset 固定官方 `https://api.x.ai/v1`、API Key auth，首版只承诺 `grok-4.5`。
- [x] CodePilot 使用 `xai.responses('grok-4.5')`，补 Responses request/stream/tool-choice fixtures。
- [x] Codex proxy 使用 `xai` provider-options namespace、映射 `reasoningEffort`；显式发送 `store:false`（CodePilot 不复用 previous response），不继承 OpenAI namespace。
- [x] connection test 使用有 timeout 的非生成 `GET /models/grok-4.5`，且 official endpoint 校验先于 bearer fetch。
- [x] 未经真实 smoke 的能力不标 verified；Phase 6 按 context/vision/tool/effort 分项记录。
- [x] API key 存储明确继承 tech-debt #40，不宣称安全存储。

### 验收标准

- CodePilot Runtime 与 Codex Runtime 各完成两轮同 session 对话，wire model 为 `grok-4.5`。
- 至少一个真实工具调用通过；不支持能力返回诚实错误，不降级成纯文本伪成功。
- Claude Code Runtime picker 不出现 xAI provider。

## Phase 4：OpenCode-compatible SuperGrok OAuth 核心

### 用户会看到什么

Settings → 添加服务 → 授权登录中出现两种 xAI 登录方式：浏览器登录（SuperGrok Subscription）与设备码登录（Headless / Remote / VPS）。登录成功后，用户可在 CodePilot Runtime 与 Codex Runtime 选择 `grok-4.5`，请求使用该 xAI 账号的 OAuth 订阅渠道。

### 本阶段不做什么

- 不宣称这是 CodePilot 自有/官方合作 OAuth client。
- 不读取 Grok Build/OpenCode 的凭据文件。
- 不把 OAuth 与 API Key 合并成一个模糊状态或共用注销动作。
- 不把 Grok Build ACP 混进本轮模型 Provider；ACP 是未来完整 coding-agent Runtime 方向。

### OpenCode 参考合同

- [x] 使用公开 Grok CLI client id `b1a00492-073a-47ea-816f-4c329264a828`；代码保留来源与兼容风险注释。
- [x] endpoints 固定为 xAI authorize/token/device 官方地址。
- [x] scope 精确为 `openid profile email offline_access grok-cli:access api:access`；authorize 带 PKCE S256、state、nonce、`plan=generic`。
- [x] callback 固定 `http://127.0.0.1:56121/callback`、只监听 loopback，`referrer=codepilot`；真实上游接受度留待 ledger。

### 浏览器与设备码

- [x] xAI browser state/nonce/token parser 与 OpenAI 状态隔离。
- [x] callback 校验 code/state/nonce，处理 provider error、HTML escape、取消、5 分钟超时、supersede 与固定端口占用指引。
- [x] CORS 仅允许 xAI auth origins，并处理 OPTIONS/Private Network preflight。
- [x] device flow 展示 verification URI + user code，处理 interval/pending/slow_down/denied/expired/deadline/cancel。
- [x] browser/device 汇入同一 `xai-oauth` credential identity。

### Token lifecycle 与 API 注入

- [x] 新增 `xai-oauth` virtual provider；与 API-key provider 复用 xAI Responses factory，credential resolution 分离。
- [x] fetch override 每次取 fresh token、替换 dummy bearer；精确 official-origin gate 在 refresh 前，拒绝 custom gateway 且不改 caller headers。
- [x] access token 在 2 分钟 buffer 内刷新；stored expiry 与 JWT `exp` 取更早边界。
- [x] token bundle 作为一个 JSON setting 原子更新，避免 rotation 半状态。
- [x] refresh 使用进程级 single-flight，支持 refresh-token rotation。
- [x] `invalid_grant` 清 bundle；network/429/5xx 保留；持久化失败 fail closed。
- [x] API Key 与 OAuth 显式分离，header 不跨渠道泄漏。
- [x] 新增 39 个 OAuth 协议/manager 行为测试，覆盖 OpenCode 26 项合同及本计划的端口、并发、nonce、header、持久化、browser/device 取消竞态与 logout 加固项。

### 验收标准

- browser/device 两种登录在真实 SuperGrok 账号完成，`grok-4.5` 两轮文本 + 工具调用通过。
- xAI Usage 页面能看到对应账号消耗；如果无法证明额度归属，不标完成。
- OAuth 登录失败不影响 API Key provider；API Key 删除也不注销 OAuth。
- allowlist/redirect/referrer 变化能分类成上游 OAuth 兼容错误，而不是泛化为“网络失败”。

## Phase 5：xAI 双渠道 UI、生命周期与 packaged hardening

### 用户会看到什么

Settings 中同时存在“xAI API Key”和“xAI Grok OAuth”入口。OAuth 桌面环境默认浏览器登录，另提供设备码登录；已登录时仍显示入口但置灰并标注状态。Provider 卡可注销、重连，模型选择器显示 `Grok 4.5`，不显示伪造剩余额度。

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
- [ ] packaged macOS/Windows 验证系统浏览器、固定端口、device flow、应用重启与深色/中文 UI；Linux 按当前发行支持范围验证。
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
- [ ] Tier 2：通用 Web smoke 已通过 19/19；xAI OAuth browser 与 Qwen Personal 已在 CodePilot/Codex Runtime 真实连接并回复。Settings 编辑/切换/注销、同 session resume、device/refresh/tool/effort 与 packaged UX 仍需对应凭据/产物。
- [ ] Windows/macOS 验证 loopback、系统浏览器、端口占用、device flow 与 app restart。
- [x] CI 同配置 macOS arm64 打包：`CSC_IDENTITY_AUTO_DISCOVERY=false`，0.59.1 DMG 内 `.app` 通过 `codesign --verify --deep --strict`，`CFBundleShortVersionString=0.59.1`，Electron ABI 143 与 packaged server health 通过；这不替代 packaged 真实登录或 Windows/x64 验收。
- [x] 2026-07-21 发布前复核官方 Qwen Coding/Token Plan exact allowlist 与 xAI `grok-4.5` slug；未据此提升未经真实调用验证的 capability。
- [x] identity 四路径 parity 覆盖 explicit/legacy/fuzzy/ambiguous，派生谓词消费同一 resolver。
- [x] 20 个 `callScene` 有封闭枚举与正反例；自动场景在模型构造/fetch 前 fail closed，用户交互场景放行。
- [ ] 团队版真实 Anthropic wire spot-check 至少覆盖 `deepseek-v3.2`、`kimi-k2.7-code`、`MiniMax-M2.5`，按单模型记录响应，不能用一个成功推广到 15 个模型。

## 关键文件（供实施定位，不是限制性清单）

| 范围 | 文件 |
|---|---|
| Provider schema/CRUD | `src/lib/db.ts`、`src/types/index.ts`、`src/app/api/providers/*` |
| Catalog/matcher | `src/lib/provider-catalog.ts`、`src/components/settings/provider-presets.tsx` |
| Provider UI | `src/components/settings/ProviderManager.tsx`、`ProviderForm.tsx`、`ProviderCard.tsx` |
| Runtime/model gate | `src/lib/runtime-compat.ts`、`src/lib/provider-resolver.ts`、`src/app/api/providers/models/route.ts` |
| CodePilot model factory | `src/lib/ai-provider.ts`、`src/lib/agent-loop.ts` |
| Codex translator | `src/lib/codex/provider-proxy.ts`、`src/lib/codex/proxy/*` |
| Usage-policy choke points | `src/lib/provider-resolver.ts`、`src/lib/claude-client.ts`、`src/lib/text-generator.ts`、`src/lib/agent-task-runner.ts`、`src/lib/context-compressor.ts`、`src/lib/title-generation.ts` |
| 自动/辅助调用清单 | `src/lib/memory-extractor.ts`、`src/lib/memory-search-mcp.ts`、`src/lib/onboarding-processor.ts`、`src/lib/checkin-processor.ts`、`src/lib/task-scheduler.ts`、`src/app/api/workspace/quick-actions/route.ts`、`src/app/api/dashboard/refresh/route.ts`、`src/app/api/cli-tools/[id]/describe/route.ts`、`src/app/api/skills/search/route.ts`、`src/app/api/media/jobs/plan/route.ts`、`src/app/api/chat/structured/route.ts` |
| OAuth precedent | `src/lib/openai-oauth.ts`、`src/lib/openai-oauth-manager.ts`、`src/app/api/openai-oauth/*` |
| Guardrails | `docs/guardrails/ProviderManagement.md`、`Runtime.md`、`DatabaseSchema.md`、`Onboarding.md`、`ElectronMain.md` |

## 依赖与相邻计划

- [模型目录与推理强度统一适配](./model-capability-reasoning-refresh.md)：拥有模型级 effort/capability 统一合同；本计划拥有 provider/product identity 与 SKU 白名单。
- [MiMo UltraSpeed + OpenAI-compatible 三方 API](./mimo-ultraspeed-openai-compatible-provider.md)：拥有通用 OpenAI-compatible 基础；xAI 因 Responses + native SDK 建议使用 branded protocol，不复用 Chat Completions 假兼容。
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
- 2026-07-22（本地打包诊断）：默认 `npm run electron:pack:mac` 自动发现本机 Developer ID 后，生成的最终 bundle 签名失效；正式 CI 显式设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，同配置重打的 ad-hoc bundle 与 DMG 均深度校验通过。公开发版不受该本机路径阻断，自动发现证书路径的静默失效另记 tech-debt #57。
- 2026-07-22（0.59.0 packaged 用户反馈）：另一台 macOS 在 `127.0.0.1:10987` HTTP system proxy 下，xAI 浏览器授权与 loopback 已完成，但 `auth.x.ai/oauth2/token` 报 transport-level `fetch failed`（无 HTTP status/OAuth code）。根因是 browser 使用系统代理，而 packaged Next/Node 全局 fetch 只收到 proxy env、没有显式 dispatcher，token exchange 仍直连。
- 2026-07-22（0.59.1 修复）：新增 opt-in env proxy fetch，覆盖 xAI browser/device/refresh/bearer 全生命周期；HTTP(S) proxy 使用 Undici `ProxyAgent`，遵循 `NO_PROXY`，不设置 global dispatcher，SOCKS/PAC 保持既有 direct/TUN 行为。底层错误只追加稳定 code，不记录代理地址/凭据；定向 44/44，含真实本地 CONNECT tunnel 反例。
- 2026-07-22（0.59.1 Claude release gate）：独立复验未发现 P0/P1/P2；P3 文案与注释当场收口，并记录 undici 大版本维护钉子。既有 `NO_PROXY` matcher 对裸 IPv6 `::1` 的端口剥离缺陷不影响本次 xAI 域名链路，留作后续 matcher 债务，不在 release gate 临时扩行为。
- 2026-07-22（0.59.1 发布提交）：修复提交 `a61faa4`；pre-commit 再次通过 4537/4537，发版标签只在本条回写、工作区清洁与远端 main 推送成功后创建。
- 2026-07-22（0.59.1 正式发布）：`v0.59.1` 指向计划回写提交 `51e2edb`；GitHub Actions run `29895409535` 的 verify-source、macOS arm64/x64、Windows x64、release jobs 全绿。稳定 Release 已上传两套 DMG/ZIP、Windows EXE 与 `SHA256SUMS.txt`；同一故障电脑的 HTTP proxy 真实复测继续保留 ⏳。

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
| 2026-07-22 | local-package | macOS arm64 | CodePilot 0.59.0 | auto-discovered Developer ID | 默认 `npm run electron:pack:mac` 后签名复核 | ❌ 签名失效 | builder 内 afterSign 曾通过，但最终 `.app`/DMG `codesign --verify --deep --strict` 失败；正式 CI 不走此配置，见 tech-debt #57 |
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
| _待测_ | packaged-macos | xAI OAuth 0.59.1 | browser code exchange | SuperGrok + HTTP system proxy | 同一故障电脑登录、回复、refresh | ⏳ | 发布后用户复验；不得用 local CONNECT mock 代替 |
| _待测_ | claude_code | Qwen Token Plan Personal | qwen3.8-max-preview | `sk-sp-` personal | two-turn + tool + effort | ⏳ | |
| _待测_ | codepilot_runtime | Qwen Token Plan Team | qwen3.8-max-preview | `sk-sp-` seat | two-turn + tool + usage gate | ⏳ | |
| _待测_ | claude_code | Qwen Token Plan Team | deepseek-v3.2 / kimi-k2.7-code / MiniMax-M2.5 | `sk-sp-` seat | Anthropic wire one-turn/model | ⏳ | |
| _待测_ | codex_runtime | Bailian Coding Plan | qwen3.7-plus | `sk-sp-` coding plan | two-turn + provider binding | ⏳ | |
| _待测_ | codepilot_runtime | xAI API | grok-4.5 | `XAI_API_KEY` | Responses two-turn + tool | ⏳ | |
| _待测_ | codex_runtime | xAI API | grok-4.5 | `XAI_API_KEY` | proxy two-turn + tool | ⏳ | |
| _待测_ | codepilot_runtime | xAI OAuth | grok-4.5 | SuperGrok browser/device | login + refresh + two-turn + logout | ⏳ | |
| _待测_ | codex_runtime | xAI OAuth | grok-4.5 | SuperGrok browser/device | proxy two-turn + tool + refresh | ⏳ | |
| _待测_ | background-negative | Qwen Token Plan personal/team | configured default | `sk-sp-` | scheduled + heartbeat + auto-memory → 0 upstream requests | ⏳ | |
