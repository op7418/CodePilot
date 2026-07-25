# Provider Management — 护栏

Settings > Providers 是 CodePilot 的"服务资产中心"，所有 provider 的连接 / 编辑 / 删除 / 默认设定都从这里出。这块不变量被破坏时，用户的体验是：刚连接的 provider 不出现、点删除连带把别的 session 搞坏、添加流程把生产 endpoint 写错、或者全局默认模型被悄悄改成另一个 provider 的。每条都很难复现，且都是真实发生过的回归。

## 1. 词汇表

| 名称 | 定义 | 来源 |
|---|---|---|
| Provider | DB `api_providers` 表的一行 + `provider_models` / `provider_options` 表的相关行 | `src/lib/db.ts` |
| Preset | catalog 内置的服务商模板（`anthropic-official` / `openrouter` / `glm-cn` 等） | `src/lib/provider-catalog.ts` `VENDOR_PRESETS` |
| Preset identity | DB `api_providers.preset_key` 中持久化的稳定套餐身份；同 URL 多套餐不能靠数组顺序推断 | `src/lib/provider-catalog.ts:resolveProviderPresetIdentity()` |
| OAuth virtual provider | 通过 OAuth 登录、DB `api_providers` 里**没有**对应行的服务商；当前包括 OpenAI OAuth 与 xAI OAuth | `openai-oauth-manager.ts` / `xai-oauth-manager.ts` + resolver/routes |
| Env provider | DB 里**没有**对应行，credentials 来自 `process.env` / `~/.claude/settings.json` / 旧 DB setting；`provider_id='env'` | resolver `provider-resolver.ts:buildResolution` |
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
| Provider DB ops | `src/lib/db.ts` `createProvider/updateProvider/deleteProvider` | 删除联动 active_image_provider；不允许改 provider_type |
| Provider models DB ops | `src/lib/db.ts` `upsertProviderModel/applyDiscoveryDiff/updateProviderModelUserFields` | 保留 user_edited 行的用户字段；catalog seed 走 `seedCatalogModels` |
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

## 9. 测试覆盖

| 测试文件 | 覆盖 |
|---|---|
| `src/__tests__/unit/provider-preset.test.ts` | preset 字段完整性 + protocol 一致性 |
| `src/__tests__/unit/provider-preset-identity-migration.test.ts` | `preset_key` 迁移、歧义、保守 backfill |
| `src/__tests__/unit/provider-preset-switch-route.test.ts` | 显式切套餐、catalog reconcile、非法 endpoint 拒绝 |
| `src/__tests__/unit/provider-resolver.test.ts` | catalog merge / DB 优先 / hidden 抑制 / role models 拉取 |
| `src/__tests__/unit/qwen-token-plan-catalog.test.ts` | Qwen 三套餐白名单、默认角色、usage policy |
| `src/__tests__/unit/xai-provider.test.ts` | xAI API Key preset、Responses、官方 endpoint 边界 |
| `src/__tests__/unit/xai-oauth-manager.test.ts` | xAI virtual provider、token 生命周期、header/host 防泄漏 |
| `src/__tests__/unit/provider-key-lifecycle.test.ts` | api_key 写入 / 读取一致 |
| `src/__tests__/unit/provider-presence.test.ts` | hasCodePilotProvider 各分支 |
| `src/__tests__/unit/stale-default-provider.test.ts` | 默认 provider 引用已删 ID 时 auto-heal |
| `src/__tests__/unit/media-provider-routes.test.ts` | active-image 路由 + stale 处理 |

加新 provider 字段 / 新 preset 时至少跑 provider-preset.test.ts + provider-resolver.test.ts。

## 10. 设计决策日志

- **2026-04-25** 已连接服务默认页**不**展示未添加 — 解决"用户分不清自己连了哪些"。Add Service 单独入口
- **2026-04-25** Add Service / 已连接服务建立对齐分组；**2026-07-21** 随独立 OAuth/Code Plan 信息架构更新为 **5 段分组**。
- **2026-04-26** 拆 verified vs experimental tier — 见 `Runtime.md` §7
- **2026-04-26** brand preset 必须排在 anthropic-thirdparty 之前 — 否则 wildcard 吞匹配
- **2026-04-26** OAuth 已登录 entry 在 Add Service 仍显示（置灰 + "已登录"） — 用户能复习 OAuth 入口存在
- **2026-04-26** 删 provider 不动 chat_sessions — 误删可恢复，session 自动接回
- **2026-07-21** `preset_key` 升为 DB 稳定身份，所有 matcher 收口到共享 resolver；同 URL 多套餐返回 ambiguous，不再顺序 first-match。
- **2026-07-21** xAI API Key 与 xAI OAuth 作为独立渠道并列；OAuth virtual provider 不伪造 DB 行、额度或套餐名称。
