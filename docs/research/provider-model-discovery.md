# Provider 模型发现 — 调研 + 落地

> **范围**：状态管理 + 模型发现这条主线，不涉及订阅额度 / 计费。
> **目标**：Provider 详情页「刷新模型」按钮 + Settings > Models 独立管理页。
> **当前写入策略（Phase B 起）**：probe 仍 read-only，apply 层在 `manual_enabled` / `manual_hidden` 守卫下做**保守自动应用**。**Add Service 成功后自动发现 + 单服务商刷新 + 刷新全部**都默认走自动 apply；只有**按推荐整理**和高级 diff 对话框走预览-then-apply。
>
> 关键不变量：`applyDiscoveryDiff` 永远不会翻动 `enable_source IN ('manual_enabled','manual_hidden')` 或 `user_edited=1` 的行——只 `upstream_model_id` 和 `last_refreshed_at` 会推进。这一层数据保护是"静默 apply 也安全"的根基。

## 演进历史

这份文档经历了四个语义状态，记录下来避免后续 agent 把当前的自动 apply 误判成回归：

1. **Phase 1 初版（已淘汰）**：纯只读 spike — `POST /discover-models` 返回探测结果，不动 DB
2. **Phase 1 第二版（已淘汰）**：成功时**无差别 upsert** 全部模型到 `provider_models`，dialog 显示「已写入 N 个模型」。问题：再次刷新会回滚用户改名 / 隐藏，违反用户预期。
3. **Phase A：preview-only**：refresh 路由返回 **diff**，用户在 dialog 看完点 **Apply** 才单独 POST `/discover-models/apply`。"任何写入都要预览"作为强护栏存在。问题：日常刷新 + 新增服务商场景下，dialog 步骤过重，把"看一眼模型列表更新了没"变成了 5 次点击。
4. **Phase B 当前版（自动 apply + manual_* 守卫）**：probe 仍只读；apply 加了 5 态 `enable_source` 列（`recommended` / `manual_enabled` / `manual_hidden` / `discovered` / `catalog`）。`applyDiscoveryDiff` 在写入时**强制忽略** `manual_enabled` / `manual_hidden` 行的 `enabled` / `enable_source` 翻动；仅 system-managed (`recommended` / `discovered` / `catalog`) 行允许按当次 catalog 重新评估。

为什么从 Phase A 回到自动 apply 是安全的：差别在于"是否信任数据层守卫"。Phase A 把保护放在 UI 步骤里（必须看预览才能 apply），但用户其实并不在乎大多数刷新的内容（一个新模型多一个旧模型少一个）。Phase B 把保护下沉到 `applyDiscoveryDiff` 自身——只要存在 manual_* 标记就跳过翻动，即使前端"忘了" preview 用户选择也不会被回滚。这让保守自动应用既安全又轻量。

**仍需要 preview 的场景**（保留 dialog）：
- **按推荐整理（`alignEnabledWithCatalog`）**：会主动启用 / 隐藏 / 删除多行，影响范围大，必须显示 dryRun 计数后再写入。
- **高级 diff 对话框（`ProviderManager.handleDiscoverModels`）**：保留为 orphan 复盘 / 强制重置入口，普通用户用不到。

## 代码出口

| 模块 | 路径 |
|---|---|
| 探针 + 分类（read-only） | `src/lib/model-discovery.ts` |
| 刷新（返回 diff，不写库） | `POST /api/providers/[id]/discover-models` |
| 静态分类（不联网） | `GET /api/providers/[id]/discover-models` |
| 应用 diff（写库，manual_* 受保护） | `POST /api/providers/[id]/discover-models/apply` |
| Diff 应用核心（含 5 态 enable_source 守卫） | `applyDiscoveryDiff()` in `src/lib/db.ts` |
| Recommendation 判定（catalog + Claude alias） | `isRecommendedModel()` in `src/lib/catalog-recommend.ts` |
| 自动 apply 共享 helper | `src/lib/auto-discover-models.ts` (`runAutoDiscoverForProvider` + `probeAndApplyProvider`) |
| Add Service 成功 → 自动发现 | `ProviderManager.handlePresetAdd` |
| Models 页单服务商刷新 | `ModelsSection` section header `刷新` 按钮 |
| Models 页批量刷新 | `ModelsSection` 顶部 `刷新全部 (N)` 按钮 |
| 高级 diff 对话框（preview-first，保留为 orphan 复盘） | `ProviderManager.handleDiscoverModels` |
| 按推荐整理（preview-first，主动重置） | `ModelsSection` `按推荐整理` → `alignEnabledWithCatalog()` |

## 安全约束

- 服务端读取 `provider.api_key`，**不接受**请求体里的 key、**不在响应里回显** key
- 所有 fetch 用 `AbortSignal.timeout`（默认 8 s）
- Gemini probe 在响应里把 `?key=***` 用占位符代替，避免日志泄漏
- 任何不确定的 endpoint 一律标 `experimental` 而非 `api`，不强行宣称能力

## 写入语义（apply）

`applyDiscoveryDiff(providerId, upstreamModels, isRecommended)` 在 `provider_models` 上执行。`isRecommended` 是 caller 注入的 `(modelId) => boolean` 谓词（由 `isRecommendedModel` 基于 catalog + provider compat 计算），用来判定新行 / 待重新评估行的目标 enabled 状态。

| DB 当前状态 | 上游本次返回 | 行为 |
|---|---|---|
| 不存在 | 出现 | INSERT，`source='api'`、`user_edited=0`、`enabled=isRecommended()`、`enable_source='recommended'` 或 `'discovered'`、display_name = model_id |
| 存在 + system-managed (`enable_source IN ('recommended','discovered','catalog')` 且 `user_edited=0`) | 出现 | 走 `updatePristineStmt`：按当次 `isRecommended` 重新评估 enabled + enable_source；同步 upstream_model_id / source='api' / last_refreshed_at / display_name = upstream id |
| 存在 + user-managed (`enable_source IN ('manual_enabled','manual_hidden')` 或 `user_edited=1`) | 出现 | 走 `updatePreservedStmt`：仅 UPDATE `upstream_model_id` + `last_refreshed_at` + source；**`enabled` / `enable_source` / `display_name` / `capabilities` / `sort_order` 全部不动** |
| 存在 | 不出现（orphan） | 不动；UI 在 Models 页提示用户决定是否删除 |

返回 stats：`{ inserted, refreshedPristine, refreshedPreserved, recommendedEnabled, discoveredHidden }`。`recommendedEnabled` / `discoveredHidden` 目前只在 INSERT 路径递增（pristine flip 不计入；见 `tech-debt-tracker.md` 行 11）。

**两路用户标记机制**（任意一个就能保护行）：
- `user_edited=1`：任何 PATCH 行编辑（重命名 / 改 capabilities）触发，legacy 信号
- `enable_source IN ('manual_enabled','manual_hidden')`：用户在 Models 页切 enabled 开关时由 `updateProviderModelUserFields` 自动写入，Phase B 标准信号

`updateProviderModelUserFields` 触发后既写 `user_edited=1` 也根据本次 toggle 写 `enable_source`，所以 Phase A 之前的 legacy 行（`user_edited=1` 但 `enable_source='recommended'`）和 Phase B 之后的新行（双重打标）都受保护。

## 三类划分（静态）

按 catalog `protocol` + 预设 `key` 分类，不依赖网络可达性。

### 类别 A — 可 API 获取（probe = `api`）

| 预设 key | 协议 | 探测端点 |
|---|---|---|
| `openrouter` | openrouter | `${baseUrl}/v1/models` |
| `ollama` | anthropic（实际跑 ollama）| `${baseUrl}/api/tags`（无需鉴权）|
| `litellm` | anthropic（实际跑 OpenAI-compat）| `${baseUrl}/v1/models` |
| `gemini-image` | gemini-image | `https://generativelanguage.googleapis.com/v1beta/models?key=…` |
| `openai-image` | openai-image | `${baseUrl}/v1/models` |
| 任何 `protocol: 'openai-compatible'` 的预设 | openai-compatible | `${baseUrl}/v1/models` |

### 类别 B — 实验性 / 需特殊条件（probe = `experimental`）

| 预设 key | 协议 | 不确定性 |
|---|---|---|
| `anthropic-official` | anthropic | api.anthropic.com /v1/models 分页 + 与 org billing scope 绑定 |
| `anthropic-thirdparty` | anthropic | 多数兼容网关同时暴露 /v1/models，但不保证 |
| `kimi` / `moonshot` / `xiaomi-mimo` / `deepseek` | anthropic（按量付费品牌）| anthropic-compat 域名是否同时挂 OpenAI-compat /v1/models 看 vendor 各自实现；按量付费时整张目录就是其真实可用集合，所以保留 probe |
| `bedrock` / `vertex` | bedrock / vertex | 需要 SigV4 / GCP ADC，不能用普通 fetch |
| `gemini-image-thirdparty` / `openai-image-thirdparty` | (image) | 第三方网关协议不一致 |

### 类别 C — 不可获取，需手动维护（probe = `unsupported`）

| 来源 | 原因 | Fallback |
|---|---|---|
| OpenAI OAuth | 浏览器 web session，不暴露 OAuth 端点的模型列表 | SDK 内置默认 |
| xAI OAuth | 订阅 virtual provider；没有可证明订阅可用范围的 model-list 合同 | catalog 内置 `grok-4.5` |
| Claude Code env | 环境变量驱动，模型由 SDK 内置定义 | SDK / catalog 内置默认 |
| xAI API Key（首版） | `/models` 全量不等于 CodePilot 已验证的 Responses 产品范围 | catalog 内置 `grok-4.5` |
| 没匹配上预设、用户自填 base_url 的 custom 行 | 没有协议线索 | catalog + 手动 `provider_models` 表 |
| Coding Plan / Token Plan 套餐型（见下表） | 套餐白名单 ≠ 上游全量推理目录 | catalog 内置白名单 + 「添加自定义模型」补 SKU |

### 类别 D — Coding Plan / Token Plan 套餐型（probe = `unsupported`）

判定条件：`preset.sdkProxyOnly && preset.meta.billingModel ∈ {coding_plan, token_plan}`。代码出口在 `src/lib/model-discovery.ts:classifyProvider` — gate 在 OAuth 检查之后、`switch (protocol)` 之前。

| 预设 key | 协议 | 套餐类型 | 套餐白名单（catalog 已内置） |
|---|---|---|---|
| `volcengine` | anthropic | coding_plan | doubao-seed-2.0-{code,pro,lite} / doubao-seed-code / minimax-m2.5 / glm-4.7 / deepseek-v3.2 / kimi-k2.5 / ark-code-latest（控制台管理 / Auto） |
| `bailian` | anthropic | coding_plan | `qwen3.7-plus` / `qwen3.6-plus` / `qwen3.5-plus` / `qwen3-max-2026-01-23` / `qwen3-coder-next` / `qwen3-coder-plus` / `kimi-k2.5` / `glm-5` / `glm-4.7` / `MiniMax-M2.5`（10 个；2026-07-21 核对） |
| `qwen-token-plan-personal-cn` | anthropic | token_plan 个人版 | `qwen3.8-max-preview` / `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-flash` / `glm-5.2` / `deepseek-v4-pro`（6 个；2026-07-21 核对） |
| `bailian-token-plan-cn` | anthropic | token_plan 团队版 | `qwen3.8-max-preview` / `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-plus` / `qwen3.6-flash` / `deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v3.2` / `kimi-k2.7-code` / `kimi-k2.6` / `kimi-k2.5` / `glm-5.2` / `glm-5.1` / `glm-5` / `MiniMax-M2.5`（15 个；2026-07-21 核对） |
| `glm-cn` / `glm-global` | anthropic | coding_plan | catalog 内置 |
| `minimax-cn` / `minimax-global` | anthropic | token_plan | MiniMax-M2.7 |
| `xiaomi-mimo-token-plan` | anthropic | token_plan | MiMo-V2-Pro |

**为什么这些 vendor 不能 probe-and-write？**

- **套餐白名单 ≠ 上游全量目录**：火山官方文档明确区分 "Coding Plan Model Name"（写进 ANTHROPIC_MODEL）与 Ark 在线推理 Model ID（同 host `/v1/models` 返回的 100+ 模型空间，含 image/embedding/audio/被废弃的旧版本）。百炼 FAQ 也说"非支持列表模型会报错"。
- **probe 出来的模型用不了**：用户选了套餐外的 SKU 调用即返回 4xx + 可能产生额外计费。
- **vendor 自己也在改名**：Bailian 当前目录与独立 provider 目录不是同一事实源。catalog 必须按各套餐官方页逐字符维护，不能因另一个 provider 升级就替换套餐白名单。
- **同 URL 也不能证明套餐身份**：Token Plan 个人版/团队版共享 `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`。目录选择必须使用持久化 `preset_key`；legacy 缺失 key 返回 ambiguous 并要求用户确认。

按量付费的 anthropic-compat 品牌（`kimi` / `moonshot` / `xiaomi-mimo` / `deepseek`）不在 gate 范围内 — 整张推理目录就是它们真实可用的集合，probe 是合理的。

## 实测（本机 dev DB 已配置的 10 家）

经过 diff → apply 闭环验证（2026-05-06 版本，类别 D gate 已生效后）：

| Provider | 分类 | 探测结果 | 应用后行为 |
|---|---|---|---|
| Google Gemini (Image) | api | 200 OK，50 个模型 | 全部 INSERT（首次）/ refresh（再次刷新） |
| Volcengine Ark | unsupported (类别 D) | 不发起 probe | 走 catalog 套餐白名单（9 个 SKU）|
| GLM (CN) | unsupported (类别 D) | 不发起 probe | 走 catalog |
| Kimi Coding Plan | — | 注：Kimi 当前预设 `kimi` 是 pay_as_you_go，仍走 experimental probe | — |
| PipeLLM | experimental | 200 OK，5 个模型 | 同上 |
| Aiberm | experimental | 200 OK，131 个模型 | 同上 |
| Xiaomi MiMo Token Plan | unsupported (类别 D) | 不发起 probe | 走 catalog（MiMo-V2-Pro）|
| MiniMax (Global) | unsupported (类别 D) | 不发起 probe | 走 catalog（MiniMax-M2.7）|
| OpenAI (Image) | api | 401（key 无效） | 不写库 |
| DeepSeek | experimental | （pay_as_you_go，仍 probe；catalog 已升级到 v4 系列）| 同上 |

**结论**：类别 D gate 让 Coding/Token Plan 走 catalog 而非 probe → 不再把上游 100+ 推理目录误写到 Models 页。剩下的 anthropic-compat 按量付费（`kimi` / `moonshot` / `xiaomi-mimo` / `deepseek`）保留 probe，因为整张目录就是其真实可用集合。

## 全 preset 拉取可靠性审计（Phase 1 Step 2 收敛，2026-05-06）

> Codex「Models / Providers 体验收敛」要求"如果服务商本身不支持可靠拉取模型，就不要显示「刷新模型」按钮"。这张表是单一事实基线：每个 preset 当前 `classifyProvider` 的归类 + Codex 4-category 框架下的位置 + 是否应显示「刷新模型」+ 用户添加路径。
>
> **结论（2026-05-06 数量为历史快照）**：可靠性判断不能从 preset 总数推断；后续新增的 Qwen 两套餐与 xAI 同样显式走 catalog-only。UI 只在 `reliable=true` 时展示刷新按钮。

| Preset key | classifyProvider | Codex 类别 | 拉取可靠？ | 刷新按钮 | 用户添加路径 |
|---|---|---|---|---|---|
| `anthropic-official` | experimental (anthropic) | 不可发现 | ❌ /v1/models 分页且绑定 org billing；catalog 是 truth | ❌ 不显示 | catalog（sonnet/opus/haiku 三联）+ 手动 |
| `anthropic-thirdparty` | experimental (openai-compatible) | 普通可发现 | ⚠️ 多数支持 /v1/models 但覆盖不均 | ✅ 仅在用户首次配 Key/URL 时尝试一次 | 拉到列表则搜索；拉不到则手动 |
| `openrouter` | unsupported (search-and-add) | 大目录聚合 | ❌ 300+ 全量物化是反 UX；走独立 `/search-models` | ❌ 不显示「刷新」（有独立「校验」入口） | 「添加模型」→ 远程搜索 |
| `glm-cn` / `glm-global` | unsupported (类别 D 套餐) | 套餐型 / CodePlan | ❌ 套餐白名单 ≠ 上游 `/v1/models` 全量 | ❌ 不显示 | 「添加模型」补 SKU（catalog 三别名 + 手动） |
| `kimi` | experimental (anthropic-compat) | Codex 框架: 套餐型 / 实测: PAYG 启动种子 | ❌ catalog 仅 1 alias，/v1/models 行为未实测 | ❌ 不显示（按 Codex 类别归套餐型） | 「添加模型」补 SKU |
| `moonshot` | experimental | 同 Kimi | ❌ 同 Kimi | ❌ 不显示 | 同 Kimi |
| `minimax-cn` / `minimax-global` | unsupported (类别 D 套餐 token_plan) | 套餐型 / CodePlan | ❌ token plan 白名单 ≠ 上游全量 | ❌ 不显示 | 「添加模型」补 SKU |
| `volcengine` | unsupported (类别 D 套餐 coding_plan) | 套餐型 / CodePlan | ❌ Ark `/v1/models` 含 100+ 文本/音频/embedding，套餐外调用 4xx | ❌ 不显示 | 「添加模型」补 SKU（9 个套餐 SKU） |
| `xiaomi-mimo` | experimental (PAYG) | Codex: 套餐型 / 实测: PAYG | ❌ 同 Kimi | ❌ 不显示 | 「添加模型」补 SKU |
| `xiaomi-mimo-token-plan` | unsupported (类别 D token_plan) | 套餐型 / CodePlan | ❌ 套餐白名单 | ❌ 不显示 | 「添加模型」补 SKU |
| `bailian` | unsupported (类别 D 套餐 coding_plan) | 套餐型 / CodePlan | ❌ 同 Volcengine 逻辑 | ❌ 不显示 | 「添加模型」补 SKU |
| `qwen-token-plan-personal-cn` / `bailian-token-plan-cn` | unsupported (类别 D 套餐 token_plan) | 套餐型 / Token Plan | ❌ 套餐白名单 ≠ 上游全量；两版共享 URL，必须用 identity 区分 | ❌ 不显示 | 各自 catalog + 「添加模型」补 SKU |
| `xai` / `xai-oauth` | unsupported (catalog-only) | 官方 API / OAuth virtual provider | ❌ 首版只承诺已验证的 `grok-4.5` Responses | ❌ 不显示 | catalog 单模型；不从全量目录扩张 |
| `deepseek` | experimental (PAYG, fixedCatalog) | 不可发现（catalog 是官方阵容） | ❌ catalog v4 family 即官方阵容；/v1/models 会暴露 v3.x 旧 SKU | ❌ 不显示 | catalog 三 SKU + 手动 |
| `bedrock` | experimental | 不可发现（SDK only） | ❌ SigV4 签名 + AWS SDK；不能从渲染端 HTTP probe | ❌ 不显示 | catalog（Bedrock 区域阵容）+ 手动 |
| `vertex` | experimental | 不可发现（SDK only） | ❌ ADC + project/region；同样需 SDK | ❌ 不显示 | catalog + 手动 |
| `ollama` | api (本地) | 普通可发现 | ✅ /api/tags 公开免认证 | ✅ 显示 | 拉取可搜索列表 |
| `litellm` | api (openai-compatible) | 普通可发现 | ✅ 多数 LiteLLM 部署 /v1/models 可用 | ✅ 显示 | 拉取可搜索列表 |
| `gemini-image` / `gemini-image-thirdparty` | unsupported (image catalog) | 不可发现 | ❌ 上游模型表混 text/embedding/audio，过滤脆弱 | ❌ 不显示 | catalog（4 个 image SKU）chips |
| `openai-image` / `openai-image-thirdparty` | unsupported (image catalog) | 不可发现 | ❌ 同 gemini-image | ❌ 不显示 | catalog chips |
| `openai-oauth` | unsupported (OAuth) | 不可发现 | ❌ Web session，没有 model list endpoint | ❌ 不显示 | SDK 内置默认 + 不允许添加 |

### 政策助手

`canReliablyFetchModels(record): { reliable: boolean; reason: string }`（位于 `src/lib/provider-catalog.ts`）封装上述决策，是 ProviderManager / ModelsSection / 任何展示「刷新模型」按钮的 UI 调用点的**单一**真相源。Phase 1 Step 2 收敛后所有 UI gate 走这个 helper，不再各自判断。

### 套餐型 / 白名单型服务商 — 来源指针清单（Qwen/Bailian 于 2026-07-21 主动复核）

> 2026-07-21 的 `qwen-token-plan-and-grok-access` 计划已主动复核阿里云百炼 Coding Plan、Qwen Token Plan 个人版/团队版；来源与产品边界见 `docs/research/qwen-token-plan-grok-oauth-2026-07-21.md`。下表其他 provider 仍只是来源指针，不能据此声称当日核准。
>
> 工程现状：除上述三个 Qwen/Bailian preset 外，其余阵容的最近核验状态仍按原记录和 tech-debt #16 管理。
>
> 仅靠 docsUrl 指针不能等同于主动复核；表中只有明确标注“2026-07-21 核对”的三行可作当前 Qwen/Bailian 白名单事实源。

| Provider | preset key | 官方入口（preset.meta） | 当前内置 `defaultModels` | UI 徽章范围 | 自定义添加 |
|---|---|---|---|---|---|
| 火山方舟 Coding Plan | `volcengine` | docsUrl: docs.bigmodel.cn 体系 / apiKeyUrl: volcengine.com 控制台 | `doubao-seed-2.0-{code,pro,lite}` / `doubao-seed-code` / `minimax-m2.5` / `glm-4.7` / `deepseek-v3.2` / `kimi-k2.5` + `ark-code-latest`（控制台管理 / Auto） | ✓ 套餐型 → `shouldShowLegacyCatalogBadge` 命中 | ✓ Models 页 "添加模型" → 套餐型 dialog |
| 阿里云百炼 Coding Plan | `bailian` | `https://help.aliyun.com/zh/model-studio/coding-plan`；2026-07-21 核对 | 10 个：`qwen3.7-plus` / `qwen3.6-plus` / `qwen3.5-plus` / `qwen3-max-2026-01-23` / `qwen3-coder-next` / `qwen3-coder-plus` / `kimi-k2.5` / `glm-5` / `glm-4.7` / `MiniMax-M2.5` | ✓ 套餐型 | ✓ |
| 千问 Token Plan 个人版 | `qwen-token-plan-personal-cn` | `https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-overview`；2026-07-21 核对 | 6 个：`qwen3.8-max-preview` / `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-flash` / `glm-5.2` / `deepseek-v4-pro` | ✓ 套餐型 | ✓ |
| 千问 Token Plan 团队版 | `bailian-token-plan-cn` | `https://platform.qianwenai.com/docs/token-plan/team/token-plan-team-overview`；2026-07-21 核对 | 15 个：`qwen3.8-max-preview` / `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-plus` / `qwen3.6-flash` / `deepseek-v4-pro` / `deepseek-v4-flash` / `deepseek-v3.2` / `kimi-k2.7-code` / `kimi-k2.6` / `kimi-k2.5` / `glm-5.2` / `glm-5.1` / `glm-5` / `MiniMax-M2.5` | ✓ 套餐型 | ✓ |
| 智谱 GLM Coding Plan（CN） | `glm-cn` | docs.bigmodel.cn/cn/coding-plan/tool/claude / bigmodel.cn API Keys | 3 alias：sonnet→GLM-5-Turbo, opus→GLM-5.1, haiku→GLM-4.5-Air | ✓ 套餐型 | ✓ |
| 智谱 GLM Coding Plan（Global） | `glm-global` | docs.z.ai/devpack/tool/claude / z.ai apikey | 同 GLM CN | ✓ 套餐型 | ✓ |
| MiniMax Coding（CN） | `minimax-cn` | platform.minimaxi.com / agent.minimaxi.com | 1 SKU：`MiniMax-M2.7` | ✓ 套餐型 | ✓ |
| MiniMax Coding（Global） | `minimax-global` | minimax.io | 1 SKU：`MiniMax-M2.7` | ✓ 套餐型 | ✓ |
| 小米 MiMo Token Plan | `xiaomi-mimo-token-plan` | xiaomimimo.com / token-plan-cn 文档 | 1 SKU：`MiMo-V2-Pro` | ✓ 套餐型 | ✓ |
| DeepSeek（按量，固定阵容） | `deepseek` | api.deepseek.com/anthropic + api-docs.deepseek.com | 3 SKU：`deepseek-v4-pro[1m]` / `deepseek-v4-pro` / `deepseek-v4-flash` | ✓ `meta.fixedCatalog: true` opt-in（catalog 即官方阵容，旧 v3.x 显示徽章） | ✓ |
| Kimi Coding Plan | `kimi` | kimi.com/code/console / kimi.com/code/docs | 1 alias：`sonnet`→Kimi K2.5（其余 SKU 走 probe） | ✗ 启动型 catalog，徽章不应在用户手动加 SKU 时误报 | ✓ |
| Moonshot | `moonshot` | platform.moonshot.cn | 1 alias：`sonnet`→Kimi K2.5 | ✗ 启动型 catalog | ✓ |
| 小米 MiMo（按量） | `xiaomi-mimo` | xiaomimimo.com | 1 alias：`sonnet`→MiMo-V2-Pro | ✗ 启动型 catalog | ✓ |

**UI 徽章范围更正（Phase 1 Step 2 review 修订）**：徽章 gate 由 `shouldShowLegacyCatalogBadge(record, modelId)` 控制，仅在两类 provider 上生效——(1) 套餐型 (`isCatalogOnlyPlanProviderRecord`)；(2) `meta.fixedCatalog: true` opt-in（目前只 DeepSeek）。Kimi / Moonshot / Xiaomi MiMo PAYG / 自定义 anthropic-thirdparty 网关 / OpenRouter 都明确**不**触发徽章 — 它们的 `defaultModels` 是启动型种子而非"truth-of-record"，用户手动加 SKU 是正常使用，不是 drift。

### 未做、待跟踪

1. **其余 catalog 主动核准**：Qwen/Bailian 三项已于 2026-07-21 收口；volcengine / GLM / MiniMax / Xiaomi / DeepSeek 等仍需逐 provider 对照官方页面。触发条件与证据要求见 tech-debt #16。
2. **Kimi / Moonshot / Xiaomi MiMo PAYG 的 catalog 启动种子是否调整为更宽**：目前 1 alias 偏窄，是否要改成更友好的"先发现一次"启动 UX，留给 Step 4「授权登录与自定义模型入口」一起评估。

## OpenRouter — search-and-add（已实现，2026-05-06）

`openrouter` 不再走类别 A 的 probe + 全量物化路径。现在是独立路由 + 独立 UI：

- **`POST /api/providers/[id]/search-models`** — 列出上游全量候选（5 分钟服务端缓存），不写库；前端 dialog 内打字客户端过滤。
- **`POST /api/providers/[id]/validate-models`** — 强制 refetch 上游 `/v1/models`、与本地 `provider_models` 对比、只更新 `last_refreshed_at`；不写新行、不动 enable_source/source/enabled/display_name。
- **`POST /api/providers/[id]/discover-models`** 对 OpenRouter 直接返回 `classification: 'unsupported'`，没有非常规 shape；`/discover-models/apply` 对 OpenRouter 返回 400（防御纵深）。
- **Add Service**：POST /api/providers 创建 OpenRouter provider 后立即 `seedCatalogModelsIfEmpty(...)`，DB 出现确切 3 条 catalog seed（sonnet/opus/haiku 别名），再不调用 auto-discover。
- **历史 300+ 行**：OpenRouter section header 出现「整理早期导入的目录」入口，`POST /api/providers/[id]/openrouter-legacy-cleanup` 预览 + 确认隐藏 `enable_source='recommended' AND user_edited=0` 的旧行；manual_* / 已编辑行被 WHERE 子句直接排除。

判定走 `isOpenRouterProviderRecord({provider_type, base_url})`（与 `isCatalogOnlyPlanProviderRecord` 同源），所有调用点用同一 helper 避免 protocol 字段缺失漏判。

为什么不复用类别 D gate（套餐型）：OpenRouter 不是套餐型（pay_as_you_go），全量目录里每个模型都"理论可用"，只是数量级失控。"套餐白名单 ≠ 上游目录"的语义不适用 — gate 条件不同，共用同一开关以后维护会出错。

详见 `docs/exec-plans/active/openrouter-search-and-add.md`。

## API 形状

```ts
// POST /api/providers/[id]/discover-models  →  无写入
{
  providerId, providerName, presetKey,
  classification: 'api' | 'experimental' | 'unsupported',
  protocol: 'openai-compatible' | 'anthropic' | 'gemini' | 'ollama' | …,
  endpoint?, ok?, modelCount?, sampleModels?, error?, notes?, suggestedFallback?, durationMs?,
  diff: Array<{
    modelId: string,
    upstreamModelId: string,
    status: 'new' | 'will-update' | 'preserve-edited' | 'hidden-but-upstream' | 'unchanged' | 'orphan',
    current?: { display_name, enabled, user_edited, source },  // 缺则代表 DB 里没这条
  }>,
}

// POST /api/providers/[id]/discover-models/apply  →  写库
// body: { upstreamModels: [{ modelId, upstreamModelId }, …] }
// 200: { providerId, inserted, refreshedPristine, refreshedPreserved }
```

UI 应当只挑用户实际想动的 `diff` 条目（默认 `new + will-update + preserve-edited + hidden-but-upstream`，跳过 `unchanged` 和 `orphan`）作为 apply body。

## Settings > Models 页面

新增独立页（`Brain` 图标，sidebar 第三项）。不在这里探针上游，单纯展示 `provider_models` + 暴露用户控制：

- **搜索**（model_id + display_name 全局搜）
- **Runtime 过滤**：全部 / Claude Code 可用 / Claude Code 实验 / CodePilot Runtime 可用 / 媒体 / 需验证
- **启用/隐藏** Switch（per row，写入时强制 `user_edited=1`）
- **重命名** display_name（同上）
- **排序**（上下箭头交换 sort_order）
- **手动添加** 模型（source='manual'，user_edited=1）
- **删除** 仅限 `source='manual'` 的行
- **来源徽章**：`api / catalog / manual / role_mapping / sdk_default`
- **Runtime 徽章**：`Claude Code` / `Claude Code 实验` / `CodePilot Runtime` / `媒体` / `需验证`
- **`已编辑` 徽章**：`user_edited=1` 的行
- **last_refreshed_at**：相对时间显示

## Runtime Compatibility 语义

模型发现只回答"上游有没有这些模型",不能单独回答"这些模型能不能用于 Claude Code"。兼容性需要由 catalog / preset / 手动验证共同决定。

### Provider 层

| 状态 | 含义 | 典型来源 |
|---|---|---|
| `claude_code_ready` | 可通过 Claude Code SDK / Anthropic-compatible env 稳定使用 | Anthropic 官方、已验证 Claude Code 兼容服务 |
| `claude_code_experimental` | 理论兼容,但 tool calling / thinking / model alias / timeout 可能不完整 | Anthropic-compatible relay、部分 Coding Plan |
| `codepilot_only` | 可由 CodePilot Runtime 管理,不应进入 Claude Code 路径 | OpenAI-compatible、Gemini、部分 OpenRouter / Relay、本地 Ollama |
| `media_only` | 图片、视频、embedding 等非聊天模型服务 | image/video provider |
| `unknown` | 自定义 base URL 或未验证网关 | manual provider |

### Model 层

| 标记 | 含义 |
|---|---|
| `chat` | 可以作为聊天 / coding model |
| `tool_capable` | 已知可用于工具调用 |
| `thinking_capable` | 已知可用于 thinking / reasoning |
| `claude_code_compatible` | 当前 runtime 为 Claude Code 时可展示 |
| `codepilot_runtime_compatible` | 当前 runtime 为 CodePilot Runtime 时可展示 |
| `media` | 只进入媒体功能,不进入聊天模型选择器 |

### 过滤优先级

1. `enabled=0` 的 hidden 模型优先级最高,必须压过 catalog fallback、role default、env default、SDK default。
2. 当前 runtime 过滤优先级高于来源过滤:Claude Code Runtime 下不展示 `codepilot_only` / `media` / `unknown` 模型。
3. `unknown` 不等于不支持;UI 文案用"需验证",不要写死"不可用"。
4. 连接测试 / 模型刷新只能提升 `verified_at` / `compatibility_source`,不能在没有明确证据时自动把 provider 标为 Claude Code ready。

## Schema 变更

`provider_models` 增加三列（迁移走 `PRAGMA table_info` 检测，已存在的库 `ALTER TABLE` 添加）：

```sql
source TEXT NOT NULL DEFAULT 'manual'
last_refreshed_at TEXT
user_edited INTEGER NOT NULL DEFAULT 0
```

旧数据默认 `source='manual'`、`user_edited=0`，第一次刷新 apply 会被识别为 pristine 然后 refresh 成 `source='api'`。

## 已知边界

- **Sample cap = 500**（`model-discovery.ts:SAMPLE_CAP`）：覆盖目前所有真实 provider 的模型数；超出会截断
- **Bedrock / Vertex 没真探**：分类标 `experimental` 但 `discoverModels` 走默认分支，需要 SDK 才能 `ListFoundationModels` / GCP ADC 列模型
- **Orphan 不自动清理**：上游下线一个模型时只在 diff 里标 `orphan`，由用户决定是否删除
- **首次刷新对旧自动写入数据**：第二版自动写入留下的行 source='manual'，第一次走新 flow 会被误识别为 user_edited=0 + 'will-update'，apply 后变 'unchanged'。**这是一次性现象**，不是 bug
- **Capability 自动识别 V1 不做**：现在 `capabilities_json` 始终 `{}`，UI 不展示也不让编辑；下一阶段补
