# Provider Management — 护栏

> 2026-09-18：`google-ai-studio` 是独立的 Google 文本 API preset，位于官方 API 分组，使用 AI Studio key 与 `generativelanguage.googleapis.com/v1beta`。它不复用 `gemini-image` 或 Vertex；连接测试必须走 Google generateContent，不能落入 Anthropic messages。模型、思考档位与上下文窗口由 catalog 提供。回归：`gemini-native.test.ts`、`gemini-native.spec.ts`。

Settings > Providers 是 CodePilot 的"服务资产中心"，所有 provider 的连接 / 编辑 / 删除 / 默认设定都从这里出。这块不变量被破坏时，用户的体验是：刚连接的 provider 不出现、点删除连带把别的 session 搞坏、添加流程把生产 endpoint 写错、或者全局默认模型被悄悄改成另一个 provider 的。每条都很难复现，且都是真实发生过的回归。

## 1. 词汇表

| 名称 | 定义 | 来源 |
|---|---|---|
| Provider | DB `api_providers` 表的一行 + `provider_models` / `provider_options` 表的相关行 | `src/lib/db.ts` |
| Preset | catalog 内置的服务商模板（`anthropic-official` / `openrouter` / `glm-cn` 等） | `src/lib/provider-catalog.ts` `VENDOR_PRESETS` |
| Preset identity | DB `api_providers.preset_key` 中持久化的稳定套餐身份；同 URL 多套餐不能靠数组顺序推断 | `src/lib/provider-catalog.ts:resolveProviderPresetIdentity()` |
| OAuth virtual provider | 通过 OAuth 登录、DB `api_providers` 里**没有**对应行的服务商；当前包括 OpenAI OAuth 与 xAI OAuth | `openai-oauth-manager.ts` / `xai-oauth-manager.ts` + resolver/routes |
| Env provider | DB 里**没有**对应行，credentials 来自 `process.env` / `~/.claude/settings.json` / 旧 DB setting；`provider_id='env'` | resolver `provider-resolver.ts:buildResolution` |
| Provider secret | DB provider 的 API Key；数据库只保存 AES-GCM 密文，数据密钥由 Electron `safeStorage` 包装。密文不可读与“未配置 Key”是两种状态，但都不得回退到别的 Provider/OAuth | `electron/provider-secret-key.ts` + `src/lib/provider-secret-crypto.ts` + `src/lib/db.ts` |
| Active image provider | 多个图片 provider 时哪个被 `/api/media/generate` 优先选中 | `setting active_image_provider_id` |

## 2. Settings > Providers 信息架构契约

### 2.1 默认页只显示已连接

不变量：进 Settings > Providers 默认页**只**展示用户已连接的服务，**不**展示"未添加但可添加"。后者由 Add Service 全屏对话框承载。

为什么：早期版本曾把所有 preset 平铺当快捷入口，新用户分不清"哪些我已经连了"。已连接 vs 未添加是两件事。

落点：`ProviderManager.tsx` `Section 1`。判定：DB providers + OAuth authenticated。env provider 单独显示（`已连接服务` 段标 `Claude Code` / `Source: 环境变量`）。

### 2.2 已连接服务必须按五类分组渲染

| 分组 | 来源 | 触发条件 |
|---|---|---|
| 授权登录 | OAuth virtual providers | OpenAI/xAI OAuth 已登录或 Codex Account 已登录 |
| 官方 API | 第一方直连 API | identity 命中 `OFFICIAL_DIRECT_API_KEYS` |
| Code Plan | Coding Plan / Token Plan 等套餐 | identity 命中 `CODING_PLAN_KEYS` |
| 第三方接入 | `claude_code_experimental` (anthropic-thirdparty wildcard / 不匹配预设) | `!matched \|\| matched.key.includes('thirdparty')` |
| 图片服务商 | `gemini-image` / `openai-image` provider_type | `provider_type === 'gemini-image' \|\| 'openai-image'` |

不变量：分组判定**必须**走共享 preset identity resolver + `provider_type`，不要用 `provider.name` 或自行做 URL first-match。用户重命名 provider 不能破坏分组；显式 identity 与 endpoint/protocol 不一致时必须报 invalid，不能降级成另一个品牌。

### 2.3 Add Service 5 类分类

不变量：Add Service 对话框分五类入口，与已连接服务分组**对齐**：
1. 授权登录（OAuth）
2. 官方 API
3. Code Plan / Token Plan
4. 第三方接入
5. 图片服务商

实施：`ProviderManager.tsx` Add Service Modal 用 `category !== 'media' && !isThirdpartyPreset(p)` / `category !== 'media' && isThirdpartyPreset(p)` / `category === 'media'` 划分；OAuth 单独走 `oauthEntries` 数组。

OAuth 已登录的 entry 必须显示**置灰** + "已登录"标签，**不能**隐藏（隐藏会让用户找不到入口，以为还没登录过）。xAI API Key 与 xAI OAuth 是两条独立渠道：API Key 是 DB provider，OAuth 是 virtual provider；两者可以同时存在，不能相互覆盖或冒充。

## 3. Preset 匹配契约

### 3.1 共享 identity resolver 策略

`provider-catalog.ts:resolveProviderPresetIdentity(record)` 是 renderer、API、resolver、doctor、connection test 和 runtime compat 的共同事实源，策略（优先级递减）为：

1. **显式 `preset_key`**：先找到 preset，再验证其 protocol/base URL 合同；不一致返回 `invalid`。
2. **legacy 唯一匹配**：仅在 `preset_key === ''` 时尝试 exact/fuzzy/type fallback；只有唯一候选才可 `resolved`。
3. **歧义或未知**：同 URL 多 preset 返回 `ambiguous`，未知返回 `unmatched`；调用方必须要求用户确认或诚实降级。

不变量：所有生产调用必须显式传 `preset_key`（legacy 行传空字符串）；禁止在 renderer/server 各写一套匹配逻辑，也禁止从多个候选中取数组第一项。通用 third-party fallback 仍保留，但只能处理真正未品牌化的自定义网关，不能吞掉 `invalid` 或 `ambiguous` 的品牌 identity。

### 3.2 同 URL 套餐与迁移

Qwen Token Plan 个人版与团队版共享 endpoint，稳定身份分别是 `qwen-token-plan-personal-cn` 与 `bailian-token-plan-cn`。创建时必须写 key；显式切套餐才允许改 key。身份采纳与目录整理是两个意图：普通 legacy 编辑可以补写稳定 key，但只有套餐选择器明确发送 `reconcile_catalog: true` 时才 reconcile catalog-managed、非 user-edited/model rows；UI 必须预先说明目录会更新。

旧行回填必须保守：Coding URL 可唯一回填 `bailian`；共享 Token Plan URL 只有精确满足旧团队 fingerprint 才回填团队版，其余保持空并让 UI 要求选择。manual/user-edited 行既不能用作套餐证明，也不能被迁移覆盖。

### 3.3 模型能力与 wire 能力必须分轴

`CatalogModel.capabilities` 是模型/UI 能力；`VendorPreset.wireCapabilities` 是“这个 provider 的这个 endpoint 对这个模型已验证接受哪些 wire 字段”。两者不能互相推导：同一模型经 ClinePass/OpenCode Go 等聚合渠道出现，不代表网关实现了第一方 DeepSeek 的 Responses 或 `output_config.effort`。

不变量：

- runtime transport 必须由 `getVerifiedProviderWireCapabilities(record, modelId)` 解析，经过 preset identity + exact model 双门；禁止只看 hostname、display name 或模型字符串。
- 未声明 wire capability 时 fail closed，保留原协议或省略 effort；不能因为模型 catalog 显示 `supportsEffort` 就假定任意网关接受该字段。
- `wireCapabilities.codexResponses` 只给有供应商合同与请求形状回归的精确模型。DeepSeek 当前为 `deepseek-v4-flash` 与稳定 API ID `deepseek-v4-pro`；Claude Code 专用的 `deepseek-v4-pro[1m]` suffix 不得顺带放开。
- AI SDK 对第三方 Responses 模型的内置 capability 判断不可信时，只有 preset-verified transport 才能设置 `forceReasoning`；供应商没声明的附加字段（如 DeepSeek 的 `reasoning.summary`）必须在 fetch 边界移除。

### 3.4 preset 默认 env 是可升级的分层配置

`defaultEnvOverrides` 不是只在“添加服务”那一刻复制一次的快照。`provider-resolver.ts:buildResolution()` 必须按 `preset defaults < stored env_overrides` 合并，让已有 provider 获得后续兼容默认值，同时保留用户显式 override。

所有新增的 managed env key 必须同时加入 `toClaudeCodeEnv()` 的清理集合；否则从一个 provider 切到另一个时会残留跨服务配置。DeepSeek 的 `CLAUDE_CODE_SUBAGENT_MODEL` 是当前回归钉。

### 3.5 显式 Provider 凭据必须 fail closed

会话最终解析到 DB Provider 时，这个 Provider 拥有整组认证变量；不仅包括显式 `session.provider_id`，也包括 legacy 空 pin 经 default/active 得到的最终 Provider。若 `api_key` 为空，或者存量 `api_key_ciphertext` 因 Safe Storage / 数据密钥不可用而解密失败，Resolver 必须在任何消息写入和 Provider 请求前返回 typed invalid reason；Claude SDK 与 Native Runtime 都必须拒绝构造 transport。

不变量：

- 选中 DB Provider 但凭据缺失/不可读时，禁止继承 `process.env.ANTHROPIC_*`、`~/.claude` OAuth 或另一个 Provider 的凭据；这会把用户明确选择的 GLM/Kimi 等请求静默发送给 Claude。
- 密文不可读只暴露低基数错误码，不向 API/UI 返回密文、wrapped DEK 或原始异常。原密文保持不动；UI 必须说明 API Key 本身可能仍有效，并引导用户到 Settings > Providers 删除原服务商、使用同一个 Key 重新添加，不能把本机解密失败说成服务商鉴权失败。删除会移除该服务商的自定义模型设置，恢复文案必须提前披露。
- Chat route 返回 typed 409，现有会话与新会话都显示本地化说明和 `/settings/providers` 恢复动作；被拒绝的消息不得落库或留下错误 assistant bubble。
- `hasCodePilotProvider()` 是全局粗检查，不能抢在 session-aware credential gate 前把“唯一 Provider 凭据不可读”误报成“未配置服务商”。

## 4. provider_models 表关系

### 4.1 三层 model 来源

每个 provider 的 model 列表由三层合并：
1. **DB `provider_models` 行**：用户启用 / 隐藏 / 重命名 / 手动添加的状态
2. **Catalog `defaultModels`**：preset 自带的默认模型（如 GLM 自带 sonnet/opus/haiku alias）
3. **Discovery API 拉取**：`/api/providers/[id]/discover-models` 探到的上游模型

合并顺序在 `provider-resolver.ts:buildResolution`：
```
let availableModels = catalog
if (DB has rows) {
  hiddenIds = DB rows where enabled=0
  enabledRows = DB rows where enabled=1
  availableModels = [...enabledRows, ...catalog.filter(c => !dbIds.has(c.id) && !hiddenIds.has(c.id))]
}
```

不变量：DB 行**优先**于 catalog；hidden DB 行**必须**抑制 catalog tail 中的同 id（否则用户隐藏一个 catalog 模型，下次刷新它又冒出来）。

catalog-only plan 有一个更窄的持久升级例外：Settings > Models 的 per-provider GET 会调用 `mergeCatalogManagedModels()`，把未编辑的 `source='catalog'` 行更新到当前 display/upstream/capabilities/order，并补缺失 catalog id。对于已知历史版本错误种下的行，还可以按 catalog 明示的 `legacyFingerprints` 做 compare-and-swap 升级：必须同时精确匹配旧 upstream id、display name、capabilities，且没有 `user_edited` / `manual_*` 所有权信号。历史 backfill 可能把系统行标成 `manual`，所以 `source` 不能单独决定所有权。任何字段不吻合都按用户行或歧义处理，不自动改写。该流程不得 disable 或 prune 非当前目录行；会删/隐藏行的完整 align 仍必须 preview-first。补缺失行的占用判据以 upstream wire id 为核心，stable id 只用于定位当前行；条件 INSERT 必须容忍另一个进程抢先写入。

Add Model 对话框不能再用 `alreadyAdded:boolean` 压平身份状态。服务端必须区分 `current_enabled`、`current_hidden`、`legacy_upgrade_available`、`identity_conflict`、`missing`；隐藏项返回真实 `existingModelId` 并提供 PATCH 重新启用，legacy 只在上述精确指纹成立时升级。同一 current wire 同时有 hidden canonical 与唯一 enabled direct row 时，enabled row 是真实可用 identity，不得被 hidden canonical 整体拖成 hidden/conflict；多个 enabled current 或其他歧义仍 fail closed。冲突项不静默覆盖目标行，必须返回 typed 409 + 真实 conflict model ids，并提供进入 Models 的恢复动作；Renderer 必须本地化 typed code，且 2xx/409 后都重拉候选与父模型列表（merge 可能已补其它目录行），不能显示英文 route fallback 或乐观翻成本地成功。catalog-only plan 的精确目录候选若重新添加，由 POST 服务端使用 catalog 真源恢复 capabilities/source/order；renderer 只传身份，不能把目录模型降级为 manual 空能力行。

冲突恢复入口必须真正显示对应模型记录：切到“全部”、清空模型搜索与渠道筛选，并滚动/聚焦服务端返回的真实冲突行。不能只关闭 Add Model 弹窗；普通关闭则保留原筛选。恢复查看本身不得调用模型写接口、启用、覆盖或删除行，文案应区分模型行身份与 `role_models_json` 角色映射。用户记录的具体来源未知时，不得靠扩大迁移范围来消除提示。

### 4.2 user_edited 守护

`provider_models.user_edited` 标记用户改过的行。`applyDiscoveryDiff()` (`db.ts:1986`) 必须保留这些行的 `display_name` / `capabilities_json` / `enabled` / `sort_order`，仅刷新 `upstream_model_id` / `last_refreshed_at` / `source`。

不变量：refresh apply 流程**绝对不能**重置 user_edited=1 行的 enabled 状态。这是 v0.x release 的 P0 教训（"用户改名后下次刷新被改回来"）。

### 4.3 Source 字段语义

| `source` | 含义 |
|---|---|
| `api` | 由 discovery probe 拉到的上游 model |
| `catalog` | 由 catalog seed / align-with-catalog 写入 |
| `manual` | 用户手动添加 |
| `role_mapping` | 从 `role_models_json` 推断（不再用） |
| `sdk_default` | SDK 内置 default（不再用） |

UI 展示在 Models 页 row 上的 source badge。删除按钮**仅**对 `source='manual'` 行可用（防误删 catalog seed）。

对 catalog-only plan，“删除”和“隐藏”语义不同：当前 catalog SKU 被物理删除后会在下一次 Models GET 重新物化；不想在 picker 使用必须隐藏。已经存在的 user-owned stable/wire 双行不允许 read merge 自动删除、改 ID 或禁用，因为这会破坏 session pin 与用户所有权；需要单独 preview-first 整理。

## 5. 删除 / 编辑安全

### 5.1 删除 provider 不能孤立 session

不变量：删 provider 时，引用它的 chat session 应当：
- session.provider_id 仍然指向已删除的 ID（不强制 NULL）
- 下次打开会话时由 `useProviderModels.providerWasFilteredOut=true` 触发 PATCH 同步到 fallback group

为什么不在 DELETE 时直接清 session.provider_id：用户可能误删，恢复 provider 后 session 应该自动接回。

实施：`/api/providers/[id]` DELETE 仅删 `api_providers` + `provider_models` + `provider_options` 行；不动 `chat_sessions`。

### 5.2 Active image provider 自动切换

如果删除的是当前 `active_image_provider_id`，必须把 `active_image_provider_id` 设回 ''，否则 `/api/media/generate` 会拿到 stale ID 失败。

实施：DELETE 路由检查 + `setActiveImageProvider('')` 自动清。

### 5.3 编辑 base_url 不要改 provider_type

不变量：`/api/providers/[id]` PUT 不允许改 `provider_type`。改了 type 等于换 provider 引擎，应当走 "删除 + 重新添加" 流程。

为什么：provider_type 决定 protocol / SDK 路径 / wire format。从 `'anthropic'` 改成 `'openrouter'` 等于换协议，role_models / extra_env 全都失效。

## 6. 关键文件 + 责任

| 模块 | 文件 | 不变量 |
|---|---|---|
| Provider list 主组件 | `src/components/settings/ProviderManager.tsx` | 5 段分组 + Add Service 5 类入口；分组判定走共享 identity resolver |
| Provider 卡片 | `src/components/settings/ProviderCard.tsx` | 头部 2 行：name+actions / 2 个 pill；compat pill `whitespace-nowrap` |
| Renderer 预设适配 | `src/components/settings/provider-presets.tsx` | 只适配共享 identity resolver 的结果，不复制匹配规则 |
| Catalog + identity | `src/lib/provider-catalog.ts` | `VENDOR_PRESETS`、identity 合同、歧义/非法状态；`meta.claudeCodeVerified` 仅给实测稳定的 |
| Catalog model identity | `src/lib/catalog-model-identity.ts` | 五态 presence classifier；legacy fingerprint 必须全字段精确匹配，冲突 fail-closed |
| Verified wire resolver | `src/lib/provider-catalog.ts:getVerifiedProviderWireCapabilities()` | preset identity + exact model；第一方能力不外溢到聚合渠道 |
| Runtime transport config | `src/lib/provider-resolver.ts:toAiSdkConfig()` | 只消费 verified wire；runtime/model 不匹配时保留默认协议 |
| Provider credential gate | `src/lib/provider-resolver.ts:resolveProviderForSession()` + `sdk-subprocess-env.ts` + `ai-provider.ts` | 显式 DB Provider 无可用凭据时，Chat/Claude SDK/Native 三层均 fail closed，禁止 ambient OAuth 串线 |
| Provider DB ops | `src/lib/db.ts` `createProvider/updateProvider/deleteProvider` | 删除联动 active_image_provider；不允许改 provider_type |
| Provider models DB ops | `src/lib/db.ts` `upsertProviderModel/applyDiscoveryDiff/updateProviderModelUserFields/mergeCatalogManagedModels` | 保留 user_edited 行的用户字段；catalog seed 与 plan 目录非破坏升级分开 |
| API: providers CRUD | `src/app/api/providers/route.ts` + `[id]/route.ts` | DELETE 不动 chat_sessions；PUT 拒绝 provider_type 变更 |
| Add Service Modal | `ProviderManager.tsx` | 5 类入口对齐已连接分组；OAuth 已登录置灰不隐藏；xAI 两渠道分离 |
| Provider Doctor | `src/components/settings/ProviderDoctorDialog.tsx` + `src/lib/provider-doctor.ts` | 测试连接走 `provider-resolver.resolveProvider()` 同一链路（B-013 教训） |

## 7. 改 / 加新功能必须检查

- 新增 preset：
  - 加进 `VENDOR_PRESETS`，定义稳定 key、protocol/base URL identity 合同
  - 决定 `meta.claudeCodeVerified`（实测过端到端才标 true）
  - 决定 `sdkProxyOnly`（必须走 SDK 子进程才标 true）
  - 决定 `iconKey` 并加图标到 `getProviderIcon`
  - 若 endpoint 与现有 preset 相同，补 ambiguous/explicit-switch/migration 测试，不能依赖数组顺序
  - 若声明 `wireCapabilities`，必须分别回答 exact model、Runtime、endpoint、effort 档位、unsupported fallback，并补第一方正例 + 聚合/近似模型反例 + 真实凭据 smoke
  - 若替换历史 catalog SKU，必须列出可追溯的 `legacyFingerprints`；只接受完整旧 upstream/display/capabilities 指纹，不能仅按 stable id 或 `source` 猜迁移
- 新增 provider 字段（如新 endpoint 信息）：
  - 加 DB 列（用 `PRAGMA table_info` 检测 + ALTER TABLE 模式）
  - 更新 `ApiProvider` type
  - 更新 `createProvider` / `updateProvider`
  - **不要** 在 PUT 路由让 `provider_type` 可变
- 新增 Add Service 入口类别（如 "本地模型"）：
  - 在 ProviderManager Add Service Modal 加分组
  - 在已连接服务 Section 1 加对应分组
  - 两边逻辑必须**对齐**（同一判定函数）

## 8. 常见坑

1. **Add Service 隐藏已登录的 OAuth** — 用户找不到 OAuth 入口以为没登录过。必须显示置灰 + "已登录"标签
2. **删 provider 时清 chat_sessions.provider_id** — 用户误删恢复后 session 接不回。让 hook 的 `providerWasFilteredOut` 机制处理
3. **改 provider_type** — role_models / extra_env / protocol 全失效。强制走删除+新建
4. **同 URL preset 取数组第一项** — 个人版/团队版静默串线。必须返回 ambiguous 或使用已验证的 `preset_key`
5. **Apply diff 重置 user_edited 行的 enabled** — 用户隐藏的模型下次刷新又出现
6. **OAuth provider 走 DB lookup** — OAuth 没 DB 行，OpenAI/xAI 都必须走各自 virtual resolution
7. **media provider 进 chat picker** — `MEDIA_PROTOCOLS` set 必须在 `/api/providers/models` route 生效，否则图片 provider 出现在聊天模型选择器
8. **改 sort_order 不持久** — `getAllModelsForProvider` ORDER BY sort_order ASC，PATCH 必须更新该字段；前端用 swap 邻居 sort_order 实现 reorder
9. **active image provider stale 不显示警告** — 删除当前 active 后必须 set 回 ''；前端有 `activeImageProviderStale` flag 兜底但显示不显眼
10. **用文本会话 provider 覆盖图片服务商** — chat 选择 xAI/GLM 只决定文本模型，不能改变图片确认文案、计费渠道或 reference 限制。图片路由只按“工具显式 provider → 图片模型 family → Settings active image provider”决策；Grok reference 校验仅在最终 family 为 xAI 时执行。
11. **OAuth 媒体工具目录与实际授权状态脱节** — 图片工具可由现有图片 provider 提供；Grok 视频只在 `isXaiOAuthUsable()` 为真时挂载。提示词、Native、Claude MCP、Codex bridge 必须使用同一可用性语义，不能展示或宣称不存在的工具。
12. **compiler 从静态 descriptor 宣称未挂载工具** — descriptor 只定义潜在能力，不能单独成为当前请求的提示真源。编译给模型的 tool hints 必须取“catalog descriptor ∩ 当前 bridge 实际 `toolNames`”；logged-out、权限 gate 或 Runtime 不支持导致未挂载时，不得提示模型调用该工具。golden/fixture 必须显式写清 OAuth/可用性状态，禁止继承开发机登录态。
13. **把模型能力当成网关 wire 能力** — 同名模型经聚合渠道可能拒绝或忽略 effort/Responses；必须用 preset `wireCapabilities` 独立声明
14. **preset 新 env 只对新连接生效** — resolver 必须层叠 catalog 默认；新增 key 也必须进入 managed 清理集合，避免旧用户缺能力、切 provider 后又串值
15. **把 presence 压成“已添加”** — hidden、可安全升级、身份冲突都被吞掉，会原样复活“已添加但没有选项”的语义 bug。必须返回五态与真实 local id
16. **目录候选复用 manual POST 默认值** — `source='manual' / user_edited=1 / capabilities='{}'` 会永久退出 catalog 升级并丢 effort/context。精确 plan 候选必须由服务端 catalog 重建
17. **只按 stable id 或 `source` 迁移 legacy** — stable id 只能定位，真正阻止插入/证明 SKU 的是 upstream wire 占用；历史 backfill 的 `source='manual'` 也可能是系统行。必须使用全字段 legacy fingerprint + ownership guard，歧义时不写库
18. **目录只记录部分历史槽位** — 替换套餐 SKU 时必须从已发布历史逐槽记录 upstream/display/capabilities，fixture 使用完整旧目录；不能只造当前反馈的 sonnet 一行，也不能保留 git 历史无来源的猜测指纹
19. **Conflict 只有徽章没有恢复路径** — current canonical 存在时仍按 current 可用；真正 CAS conflict 必须在写后重读并返回冲突 model ids，前端展示解释和进入 Models 的动作，不能乐观改本地状态或让用户卡死
20. **Provider 密钥不可读时继续启动 SDK** — `provider` 仍存在不等于凭据可用；若让 `provider && !hasCredentials` 进入 Claude SDK，ambient Claude OAuth 会接管请求，把所有同 Provider 模型伪装成供应商故障。必须 session-aware 阻断并引导重新填写 Key

## 9. 测试覆盖

| 测试文件 | 覆盖 |
|---|---|
| `src/__tests__/unit/provider-preset.test.ts` | preset 字段完整性 + protocol 一致性 |
| `src/__tests__/unit/provider-preset-identity-migration.test.ts` | `preset_key` 迁移、歧义、保守 backfill |
| `src/__tests__/unit/provider-preset-switch-route.test.ts` | 显式切套餐、catalog reconcile、非法 endpoint 拒绝 |
| `src/__tests__/unit/provider-resolver.test.ts` | catalog merge / DB 优先 / hidden 抑制 / role models 拉取 |
| `src/__tests__/unit/foundation-refresh-user-path-contract.test.ts` | Models GET 的真实三行存量套餐升级、Add Model stable/upstream identity 与五态/conflict recovery、hidden 恢复、catalog 重加能力保真、零写幂等与非 plan 反例 |
| `src/__tests__/unit/catalog-capabilities-roundtrip.test.ts` | catalog metadata round-trip、read merge 用户保护、upstream 去重、冲突安全与排序避让 |
| `src/__tests__/e2e/model-identity-conflict.spec.ts` | 真实临时 DB + 编译页面：隐藏/改名旧 haiku、空角色映射，冲突查看清筛选并定位；普通关闭保留筛选；模型数据前后相同，无模型写请求 |
| `src/__tests__/unit/deepseek-v4-flash-adaptation.test.ts` | Flash 0731 + Pro 0813 exact preset/model wire 门、legacy env 默认层叠、DeepSeek Anthropic effort + Codex Responses 请求形状、Claude suffix/聚合渠道反例 |
| `src/__tests__/unit/qwen-token-plan-catalog.test.ts` | Qwen 三套餐白名单、默认角色、usage policy |
| `src/__tests__/unit/xai-provider.test.ts` | xAI API Key preset、Responses、官方 endpoint 边界 |
| `src/__tests__/unit/xai-oauth-manager.test.ts` | xAI virtual provider、token 生命周期、header/host 防泄漏 |
| `src/__tests__/unit/provider-key-lifecycle.test.ts` | api_key 写入 / 读取一致 |
| `src/__tests__/unit/provider-presence.test.ts` | hasCodePilotProvider 各分支 |
| `src/__tests__/unit/session-runtime-immunity.test.ts` | 不可读 provider 密文的 session-aware fail-closed、typed route/UI 恢复接线 |
| `src/__tests__/unit/sdk-subprocess-env.test.ts` | Claude SDK 与 Native Runtime 拒绝无凭据 DB Provider，不继承 ambient OAuth |
| `src/__tests__/unit/glm-5-3-codeplan-adaptation.test.ts` | GLM-5.3 / GLM-5.3-Flash 当前目录，逐模型 auth/base URL/upstream env、1M/vision/effort 与 Claude/Codex wire 边界 |
| `src/__tests__/unit/stale-default-provider.test.ts` | 默认 provider 引用已删 ID 时 auto-heal |
| `src/__tests__/unit/media-provider-routes.test.ts` | active-image 路由 + stale 处理 |

加新 provider 字段 / 新 preset 时至少跑 provider-preset.test.ts + provider-resolver.test.ts。

## 10. 设计决策日志

- **2026-09-04** Windows 用户反馈经 macOS 隔离复现后，只修确定的冲突恢复 UI 缺口：原按钮只关闭弹窗，hidden 行仍被默认 enabled 筛选挡住。新增清筛选、滚动、聚焦与短暂高亮，双语文案说明角色映射与模型记录独立；用户真实旧行来源待确认，身份判定与数据迁移保护保持原合同。

- **2026-04-25** 已连接服务默认页**不**展示未添加 — 解决"用户分不清自己连了哪些"。Add Service 单独入口
- **2026-04-25** Add Service / 已连接服务建立对齐分组；**2026-07-21** 随独立 OAuth/Code Plan 信息架构更新为 **5 段分组**。
- **2026-04-26** 拆 verified vs experimental tier — 见 `Runtime.md` §7
- **2026-04-26** brand preset 必须排在 anthropic-thirdparty 之前 — 否则 wildcard 吞匹配
- **2026-04-26** OAuth 已登录 entry 在 Add Service 仍显示（置灰 + "已登录"） — 用户能复习 OAuth 入口存在
- **2026-04-26** 删 provider 不动 chat_sessions — 误删可恢复，session 自动接回
- **2026-07-21** `preset_key` 升为 DB 稳定身份，所有 matcher 收口到共享 resolver；同 URL 多套餐返回 ambiguous，不再顺序 first-match。
- **2026-07-21** xAI API Key 与 xAI OAuth 作为独立渠道并列；OAuth virtual provider 不伪造 DB 行、额度或套餐名称。
- **2026-08-02** 模型/UI capability 与 provider wire capability 正式分轴。DeepSeek V4 Flash 只有在第一方 preset + exact model + Codex Runtime 时切原生 Responses；Anthropic effort 也只对 preset 声明的模型放行。ClinePass/OpenCode Go 的同名模型保持 tool-use-only，直到各自网关 smoke。preset env 同时改为可升级分层配置，老 provider 行不必删除重加。
- **2026-08-15** catalog-only plan 的旧 catalog 快照改为 Models GET 非破坏升级：只同步 pristine catalog 行并补当前 id，不覆盖用户选择、不做 disable/prune。套餐搜索候选把稳定 DB id 与 upstream wire id 分列，避免 GLM-5.3 因旧 `sonnet` alias 显示“已添加”但管理页仍停在 5.2，或手动添加后产生重复行。
- **2026-08-16** v0.67.1 条件审查收口：catalog merge 增加 stable/upstream 双查重、跨进程冲突安全与用户排序避让；Add dialog 显式区分 hidden 并可恢复；plan catalog 重加由服务端恢复完整能力和 catalog ownership。存量 user-owned 双行不做静默迁移，后续整理必须 preview-first。
- **2026-08-23** GLM legacy 修复改为显式身份迁移：`legacyFingerprints` 全字段 compare-and-swap，upstream wire 占用才是插入冲突事实；Add Model 暴露五态，`identity_conflict` fail-closed，不再让 stable alias 或不可靠的历史 `source` 替用户做决定。
- **2026-08-24** implementation review 收口后按已发布 git 历史补齐 sonnet→`sonnet` 的 gen-0 `GLM-4.7`、`GLM-5-Turbo`/`GLM-5.2` 与 haiku→`haiku` 的 `GLM-4.5-Air` 指纹，删除 upstream=`glm-5-turbo` 的无来源猜测；gen-0 与后续三行完整目录 fixture 都验证目标槽原位升级、非目标 opus 保留。mutation 后 UI 重拉服务端真源；canonical current 不被额外旧行拖成死路，真正 conflict 有行为断言并显示具体恢复动作。
- **2026-08-24** presence 进一步明确 enabled-first：hidden canonical 与唯一 enabled direct current wire 并存时返回 `current_enabled` 并指向 enabled row；只有没有 enabled current 时 hidden canonical 才代表 `current_hidden`。
- **2026-08-26** GLM Coding Plan 当前目录收敛为 GLM-5.3 + GLM-5.3-Flash；旗舰 stable `sonnet` 与默认角色保持 5.3，快速 stable `haiku` 升级 Flash。Models GET 仍为非破坏 merge：迁移已知 pristine haiku 指纹、补当前缺失行，但不删除或停用历史 Turbo/4.7 行；当前目录事实与存量数据清理由不同动作负责。


## TokenDance 接入合同（2026-09-05）

- 2026-09-18 用户指定：添加服务菜单的 TokenDance 卡片位于“授权登录”，不再在“第三方 / 中转兼容”重复展示；仍打开原来的授权码/手动 Key 双入口对话框。此调整只涉及添加入口，保存后仍是普通 DB Provider，不能伪装为 OAuth 虚拟订阅或据此改写已连接服务分类。

- 添加菜单只显示 `tokendance`；同一连接 Native/Codex 使用 Chat Completions，Claude Code 使用 Messages relay。保留旧 `tokendance-anthropic` 编辑/重授权；不改已有 protocol、ID、Key 和聊天。模型能力由 exact-host + 官方协议快照限定，不能把 Kimi K3 等未声明 Messages 的模型标成 Claude 可用；实时目录必须按 `supported_protocols` 筛选，不以名称推测协议。只排除未声明聊天协议的模型；声明 Chat Completions 的 TTS 可以进入发现列表，但默认隐藏，不宣称适合聊天。公开目录不证明 Key 有效，连接测试必须执行真实协议小请求。
- OAuth 创建的是普通 API Key，沿用加密 provider 存储与原连接 ID；不得变成虚拟订阅或以重建聊天完成重授权。取消/超时/替换 flow 后迟到兑换不得落库，完整 Key/code/verifier 不得进入状态 API、UI 或日志。
- App URL 固定 `https://www.codepilot.sh/`，同时写授权参数与所有模型请求 `X-App-URL`。精确 origin/path gate 与 `redirect:error` 先于上游网络请求。
- `TokenDance-Recovery-Action` 只在失败时处理已知值；充值、重新授权、周期额度分别指引，未知值保留原协议错误。Claude 子进程使用 AUTH_TOKEN，通过固定 Messages relay 保留恢复事实；未映射的角色与 small helper 回退到本轮已选模型，不能请求内置 Claude ID，也不覆盖显式角色映射；不得把余额问题折叠成通用鉴权失败或自动删除 Key。
- 证据：`tokendance.test.ts`（真实 SDK/代理 wire、PKCE、加密与取消竞态）与 `tokendance-integration.spec.ts`（隔离 Dev UI）。真实账号/计费/打包 smoke 另行记录，不能以 mock 代替。

- TokenDance 的 Provider badge 必须说明多协议/按模型支持，不能描述为通用 Anthropic 模板或暗示实测。Models 筛选使用同一模型级 tier，Codex parity 按该连接的实际协议分类；不可用 reason 经 typed dictionary 按 locale 返回。
