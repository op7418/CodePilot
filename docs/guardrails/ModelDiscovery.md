# Model Discovery — 护栏

> 2026-09-18 Google：使用配置的 base URL，key 仅放 `x-goog-api-key` header；禁跟随重定向，不回显原始错误体。读取全部分页、去重、去掉 `models/` 前缀，只纳入支持 `generateContent` 的条目。分页失败/重复游标必须整体失败，不把部分结果用于 diff；不能破坏既有用户启用/隐藏守卫。回归：`gemini-native.test.ts`。

模型发现 (`/api/providers/[id]/discover-models`) 是 Provider Management 和 Composer 之间的桥梁：从上游拉模型列表，让用户决定哪些进 picker。

**当前 (Phase B) 写入模型**：probe 路由 read-only，apply 路由保守自动写入并由 `enable_source` 守卫保护用户选择：

- **Add Service 成功 / 单服务商刷新 / 刷新全部**：自动 probe + apply，无 dialog；保护层是 `applyDiscoveryDiff` 拒绝翻动 `enable_source IN ('manual_enabled','manual_hidden')` 或 `user_edited=1` 的行
- **按推荐整理 (`alignEnabledWithCatalog`) / 高级 diff 对话框**：preview-first，dryRun 显示影响范围后才写入；保留给会主动翻动多行或做删除的"扫荡"操作
- **套餐目录升级 (`mergeCatalogManagedModels`)**：Settings > Models 读取 catalog-only plan 时，更新 pristine catalog 行并补当前 catalog id；已知历史错误只允许按 catalog 的完整 `legacyFingerprints`（旧 upstream/display/capabilities）compare-and-swap，且必须没有用户所有权信号。历史 `source` 可能被 backfill 污染，不能单独作为判据。补行以 upstream wire 占用为冲突事实，任何歧义均不写库；不 disable/prune，因此不等同于全量 align

**演进路径**：第一版纯只读 spike → 第二版无差别 upsert（已淘汰，会回滚用户编辑）→ Phase A "diff-first 必须人确认"（保护放在 UI 步骤，但日常刷新太重）→ **Phase B 当前版**（保护下沉到数据层，UI 可以静默 apply）。详见 `docs/research/provider-model-discovery.md` §"演进历史"。

任何想去掉 `enable_source` / `user_edited` 守卫"简化逻辑"的改动会回到原 P0 教训：用户改名 / 隐藏被刷新覆盖。守卫不变，UI 可以变。

## 1. 词汇表

| 名称 | 定义 | 来源 |
|---|---|---|
| Probe | 一次对上游 `/v1/models` / `/api/tags` 等端点的请求 | `model-discovery.ts:discoverModels()` |
| Classification | 静态分类：`api` (可探) / `experimental` (能探但不稳) / `unsupported` (无端点) | `classifyProvider()` |
| Diff | 上游探测结果 vs DB `provider_models` 的 per-row 比较 | `/api/providers/[id]/discover-models` 返回的 `diff: DiffEntry[]` |
| DiffEntryStatus | `new` / `will-update` / `preserve-edited` / `hidden-but-upstream` / `unchanged` / `orphan` | 同上 |
| Apply | 把用户确认的 diff 写进 `provider_models`（保留 user_edited） | `/api/providers/[id]/discover-models/apply` + `db.applyDiscoveryDiff()` |
| Align with catalog | 与 catalog 推荐列表对齐：保留推荐为 enabled，其余隐藏 | `/api/providers/[id]/models/align-enabled` + `db.alignModelsWithCatalog()` |
| Source | `provider_models.source`：`api` / `catalog` / `manual` / `role_mapping` / `sdk_default` | DB schema |
| user_edited | `provider_models.user_edited` 1=用户改过显示名/启用/能力，0=纯净 | DB schema |

## 2. Apply 契约（核心）

### 2.1 两条 apply 路径，按场景选

**Path A — Conservative auto-apply（默认，多数刷新走这条）**

```
1. Probe   — POST /api/providers/[id]/discover-models       （read-only，永不写库）
2. Filter  — 客户端把 diff 过滤到 writeable bucket
3. Apply   — POST /api/providers/[id]/discover-models/apply  （写库；manual_* 受保护）
4. Toast   — 单 toast 报告 enabled / hidden 计数（无 dialog）
```

入口：Add Service 成功后自动触发、Models 页 section "刷新" 按钮、Models 页顶部 "刷新全部 (N)"。共享 helper 在 `src/lib/auto-discover-models.ts` (`runAutoDiscoverForProvider` / `probeAndApplyProvider`)。

**Path B — Preview-then-apply（保留给"扫荡"操作）**

```
1. Probe       — POST /discover-models（read-only）
2. Diff dryRun — 计数 + 每行类型显示给用户
3. User Confirm — 用户在 dialog 看完点 Apply
4. Apply       — POST /discover-models/apply
```

入口：Models 页 "按推荐整理"（`alignEnabledWithCatalog` dryRun → confirm → apply）、ProviderManager.handleDiscoverModels 的高级 diff 对话框（保留给 orphan 复盘 / 强制重置）。

### 2.2 不变量

- **`POST /discover-models` 永不写库** — read-only，仅返回 diff。`POST /discover-models/apply` 是唯一写入入口。
- **`applyDiscoveryDiff` 拒绝翻动用户管理行** — 满足以下任一即"用户管理"，永远不被改：
  - `enable_source IN ('manual_enabled', 'manual_hidden')`（Phase B 标准信号）
  - `user_edited = 1`（legacy 信号，保护 Phase B 之前的行）
- **新行的 enabled 由 caller 注入的 `isRecommended()` 决定** — 不在数据层硬编码白名单。
- **orphan 行不动** — 上游临时下线 ≠ 用户想删，永远人工确认。

### 2.3 为什么从 Phase A "必须 preview" 回到自动 apply 安全

差别在保护放哪一层。Phase A 把保护放在 UI 步骤里（必须看预览才能 apply），但用户其实并不在乎大多数刷新的具体内容（一个新模型多 / 一个旧模型少）。Phase B 把保护下沉到 `applyDiscoveryDiff` 自身——只要存在 manual_* / user_edited 标记就跳过翻动，**即使前端"忘了" preview 用户选择也不会被回滚**。这让保守自动应用既安全又轻量。

### 2.4 Apply 写库行为（按 `enable_source` 分支）

`db.applyDiscoveryDiff(providerId, upstreamModels, isRecommended)` 对每个上游 model：

| DB 现状 | 上游本次返回 | 写库行为 |
|---|---|---|
| 不存在 | 出现 | INSERT；source='api'，user_edited=0，enabled=isRecommended()，enable_source='recommended' 或 'discovered' |
| system-managed (`enable_source IN ('recommended','discovered','catalog')` AND `user_edited=0`) | 出现 | `updatePristineStmt`：按 isRecommended 重新评估 enabled + enable_source；同步 upstream_model_id / source='api' / last_refreshed_at / display_name |
| user-managed (`enable_source IN ('manual_enabled','manual_hidden')` OR `user_edited=1`) | 出现 | `updatePreservedStmt`：仅 UPDATE upstream_model_id + last_refreshed_at + source；**enabled / enable_source / display_name / capabilities / sort_order 全部不动** |
| 任何 | 不出现（orphan） | **不动**；UI 在 Models 页提示用户决定是否删除 |

**不变量**：apply 流程**绝对不能**重置 user-managed 行的 enabled / enable_source。这是 P0 教训。两条信号（manual_* 和 user_edited=1）任一即触发保护，是为了让 Phase B 之前的 legacy 行也受保护。

### 2.5 UI filter — apply 只发会写的桶

`ProviderManager.tsx` 的 `handleApplyDiff` 和 `auto-discover-models.ts` 的 `probeAndApplyProvider` 都 filter：

```ts
const applicable = diff.filter(e =>
  e.status === 'new' ||
  e.status === 'will-update' ||
  e.status === 'preserve-edited' ||
  e.status === 'hidden-but-upstream'
);
```

注意 `unchanged` 现在也会发到 apply（让 `last_refreshed_at` 推进，"上次同步"才会刷新），但走 `updatePreservedStmt` 不改 enabled。`orphan` 永不发。`probeAndApplyProvider` 见 `apply-discovery-diff.test.ts` 的 up-to-date case。

## 3. Classification 分类规则

`model-discovery.ts:classifyProvider()` 按 `protocol + presetKey` 决定能否探：

### 3.1 Class A — `api`（可探，绑定 key）

| 预设 key | 协议 | 端点 |
|---|---|---|
| `openrouter` | openrouter | `${baseUrl}/v1/models` |
| `ollama` | anthropic（实跑 ollama） | `${baseUrl}/api/tags`（无需 auth） |
| `litellm` | anthropic（实跑 OpenAI-compat） | `${baseUrl}/v1/models` |
| `google` | gemini | `https://generativelanguage.googleapis.com/v1beta/models?key=…` |
| 任意 `protocol: 'openai-compatible'` | openai-compatible | `${baseUrl}/v1/models` |

### 3.2 Class B — `experimental`（能探但不稳）

| 预设 key | 协议 | 不确定性 |
|---|---|---|
| `anthropic-official` | anthropic | api.anthropic.com /v1/models 分页 + 与 org billing scope 绑定 |
| `anthropic-thirdparty` | anthropic | wildcard，是否暴露 /v1/models 看 vendor |
| `glm-cn/glm-global/kimi/moonshot/minimax-*/volcengine/xiaomi-mimo*/bailian` | anthropic（brand Code Plan） | anthropic-compat 域名是否同时挂 OpenAI-compat /v1/models 看 vendor |
| `bedrock` / `vertex` | bedrock / vertex | 需要 SigV4 / GCP ADC，不能用普通 fetch |
| `gemini-image-thirdparty` / `openai-image-thirdparty` | (image) | 第三方网关协议不一致 |

### 3.3 Class C — `unsupported`（不能探）

| 来源 | 原因 | Fallback |
|---|---|---|
| OpenAI OAuth | 浏览器 web session，不暴露 OAuth 端点 | SDK 内置 default |
| xAI OAuth | 上游已有 authenticated Build proxy `/v1/models`，但 CodePilot 当前尚未接入所需 session headers、parser/cache 与 entitlement 失败语义 | 当前仍以 `grok-4.6` + `grok-4.5` legacy 静态 catalog fail-closed；它不是账号完整目录。接入后走 virtual-provider 专用刷新，不复用 DB provider 通用 probe |
| Claude Code env | 环境变量驱动，模型由 SDK 内置定义 | SDK / catalog 内置 default |
| `bailian` / `qwen-token-plan-personal-cn` / `bailian-token-plan-cn` | 套餐白名单来自官方产品页；共享 endpoint 不能用于识别个人/团队套餐 | 各自精确 catalog，`modelDiscoveryMode='catalog_only'` |
| `xai` API Key | 只暴露经过真实 Responses SDK wire 验证的内置模型/effort，不把 `/models` 返回的全部 SKU 自动暴露 | 内置 `grok-4.6` + `grok-4.5` legacy catalog；`@ai-sdk/xai@4.0.18` 尚不接受 `xhigh`，修复前不得对用户承诺该档 |
| `gemini-image` / `openai-image` | 上游 /v1/models 返回全部模型（含 text/audio/embedding），无法 filter 出图片 | catalog 内置图片列表 |
| 没匹配上预设、用户自填 base_url 的 custom 行 | 没有协议线索 | catalog + 手动 `provider_models` 表 |

**不变量**：Class C 的入口**不展示** "刷新模型" 按钮（图片 provider 已在 `ProviderManager.tsx:744` 注释明确不渲染 onRefreshModels）。

套餐型 provider 的 `preset_key` 是目录选择的事实源。Qwen Token Plan 个人版/团队版共享 `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`；缺失 identity 的旧行必须显示“请选择套餐类型”，不能用 URL 命中第一个 catalog。2026-07-21 主动核对的精确白名单记录在 `docs/research/qwen-token-plan-grok-oauth-2026-07-21.md` 与 `docs/research/provider-model-discovery.md`。

## 4. 安全约束

| 约束 | 位置 | 理由 |
|---|---|---|
| 服务端读取 `provider.api_key`，**不接受** body 里的 key | route handler 不读 body 里的 `apiKey` | 防止前端误传 / 中间人篡改 |
| 响应里**不回显** key | `model-discovery.ts:probeGemini` 把 `?key=***` 占位符替换 endpoint 字段 | 防日志泄漏 |
| 所有 fetch 用 `AbortSignal.timeout(8000)` | `model-discovery.ts:fetchAndParse` | 防慢上游 hang 住请求 |
| 任何不确定 endpoint 标 `experimental` 而非 `api` | `classifyProvider` | 不强行宣称能力 |
| catalog-only provider 不发 discovery probe | `isCatalogOnlyDiscoveryProvider()` + routes/UI | 避免套餐目录被通用 `/models` 污染或把不属于套餐的 SKU 暴露给用户 |
| 共享 URL 必须先解析稳定 identity | `resolveProviderPresetIdentity()` | 防止个人/团队目录串线 |

`SAMPLE_CAP = 500` (`model-discovery.ts:86`)：覆盖目前所有真实 provider；超出截断。OpenRouter ~200，Aiberm ~131，最大见过 ~131。如未来某 provider 返回 1000+，加该常数（不要去掉）。

## 5. dbHiddenIds × catalog tail 互动

`/api/providers/models` route 的 catalog fallback 必须**显式**抑制 hidden ids：

```ts
const catalogRaw = catalogModels
  .filter(m => !dbHiddenIds.has(m.modelId))
  .map(m => ({ ... }));
```

不变量：用户隐藏的 catalog seed model 必须**被抑制**，否则下次 catalog seed 重新出现的会让 hidden 失效。

同样的守卫在 `provider-resolver.ts:buildResolution` 里：
```ts
availableModels = [
  ...dbCatalog,
  ...availableModels.filter(m => !dbIds.has(m.modelId) && !dbHiddenIds.has(m.modelId)),
];
```

详细见 `Runtime.md` §3 关键文件表。

## 6. 关键文件 + 责任

| 模块 | 文件 | 不变量 |
|---|---|---|
| Probe + classification | `src/lib/model-discovery.ts` | classifyProvider 三类分明；probe 永远不写库；超时 8s；key 不回显 |
| Discover route | `src/app/api/providers/[id]/discover-models/route.ts` POST | 仅返 diff，不写库；Gemini key 替换占位 |
| Apply route | `src/app/api/providers/[id]/discover-models/apply/route.ts` | 唯一写入入口；保留 user_edited；orphan 不动 |
| Diff apply DB op | `src/lib/db.ts` `applyDiscoveryDiff()` | 五种 case 分明；user_edited / hidden 守护 |
| Align with catalog | `/api/providers/[id]/models/align-enabled` + `db.alignModelsWithCatalog()` | preview-first；apply 保留 user_edited；不删 manual |
| Catalog-only plan read merge | `/api/providers/[id]/models` GET + `db.mergeCatalogManagedModels()` | pristine catalog 行可刷新；legacy 仅按完整 fingerprint compare-and-swap；upstream 占用/歧义 fail-closed；不 disable/prune，并发 INSERT 输家采用已有行 |
| Catalog model identity | `src/lib/catalog-model-identity.ts` | 搜索候选区分 current enabled/hidden、legacy upgrade、identity conflict、missing 五态 |
| Refresh diff Dialog | `ProviderManager.tsx` `handleApplyDiff` | 仅发 actionable diff（new/update/preserve/hidden-up），跳 unchanged/orphan |
| Models page row badges | `ModelsSection.tsx` source badge | source 5 态 tone 锁定 |
| Catalog | `provider-catalog.ts:VENDOR_PRESETS` `defaultModels` | seed 模型来源 |

## 7. 改 / 加新功能必须检查

- 新增 probe protocol（如 cohere / mistral 自家 endpoint）：
  - 加 `DiscoveryProtocol` type
  - 加 `classifyProvider` 分支决定 api / experimental
  - 加 `probeXxx` 函数；要求 `apiKey` + `timeoutMs` + 不回显 key
  - 在 `discoverModels` switch 接入
- 新增 source 字段（如 `discovered_capability`）：
  - 加 `ProviderModelSource` type
  - 加 `SOURCE_LABEL_*` / `SOURCE_TONE` map (ModelsSection.tsx)
  - **DB 迁移**保留旧数据 (`feedback_db_migration_safety` — 不 DELETE)
- 改 apply 写库逻辑：
  - 新行为对所有五个 DiffEntryStatus 写 case 表
  - 单测 `applyDiscoveryDiff` 五种场景
  - **不要**让 enabled=0 行被自动 enabled=1
- 加 / 改 catalog `defaultModels`：
  - `seedCatalogModels` 路径会种这些 ID（仅当 provider 无任何 row 时）
  - catalog-only plan 已 seed 过的 provider 会在 Models 页读取时通过 `mergeCatalogManagedModels` 补当前 catalog id，并刷新 pristine catalog metadata；其它 provider 仍不自动扩写
  - Add Model 候选必须区分 `current_enabled / current_hidden / legacy_upgrade_available / identity_conflict / missing`。隐藏候选提供“重新启用”动作并 PATCH 真实 existing local id；legacy 仅在完整 fingerprint 成立时迁移；冲突项禁止覆盖目标行，并返回 typed 409 + conflict model ids + Models 恢复入口；Renderer 本地化 typed code，2xx/409 后都重拉候选与父模型列表，不乐观标成功
  - catalog-only plan 的精确 catalog 候选重新添加时，POST 服务端必须从当前 catalog 重建 display/upstream/capabilities/source/order；不得让 renderer 把它写成 `source='manual' + capabilities='{}'`
  - 删除不是“退出 catalog”的语义：catalog-only plan 的当前目录项若被物理删除，下一次 Models GET 会重新物化。用户只想不在 picker 使用时必须选择“隐藏”
  - 自动 read merge 绝不能复用完整 `alignEnabledWithCatalog`：后者会 disable/prune，必须继续 preview-first
  - 套餐/白名单型 provider 必须记录官方来源、核对日期与精确大小写；不得从普通 `/models` 猜套餐可用性
  - 同 endpoint 多 preset 必须补 identity/ambiguous 测试

## 8. 常见坑

1. **POST /discover-models 写库** — probe 路由必须 read-only。写入只能从 `/apply` 走。
2. **apply 翻动 manual_* / user_edited 行** — 用户隐藏的模型刷新后被启用。`applyDiscoveryDiff` 三个分支必须严格按 `enable_source` + `user_edited` 守卫，user-managed 行只动 `upstream_model_id` / `last_refreshed_at`。
3. **新加的 caller "为简化"绕过 isRecommended 谓词** — 如果直接 `enabled=1` 硬编码而不走 caller 注入的判定，新行会全部默认开启，违反"保守自动 apply"原则。
4. **orphan 自动删** — 上游临时下线（地区切换 / 维护）会 false-positive，用户的 manual 加的同名行被误删。orphan 必须**人工确认**。
5. **probe 不超时** — 慢上游让请求 hang，front-end 转圈一直转。`AbortSignal.timeout(8000)` 必须保留。
6. **响应回显 key** — Gemini probe 把 `?key=` 写进 endpoint 字段返给前端 → log 泄漏。`probeGemini` 用占位符替换。
7. **`fullModelIds` vs `sampleModels` 用错** — 大 catalog provider 超过 SAMPLE_CAP=500 时，apply / diff / seen 集合**必须**用 `fullModelIds`；`sampleModels` 是 UI 截断版本，混用会让 500 名以后的真实模型变成 orphan。
8. **catalog seed 不抑制 hidden** — 用户隐藏的 catalog 模型 catalog tail 又加回，picker 又显示。必须 `filter(m => !dbHiddenIds.has(m.modelId))`。
9. **Apply 没过 filter** — 把 orphan 也发到 apply route 可能误删；`unchanged` 现在 OK 发（让 `last_refreshed_at` 推进），但 `orphan` 永远不发。
10. **OAuth provider 误展示 refresh 按钮** — OAuth 没 DB row，refresh 无意义且会 404。`ProviderCard` 仅当 `onRefreshModels` 传入才渲染按钮，OAuth 路径不传。
11. **批量驱动忘了 try/catch/finally** — `刷新全部` 必须 try/finally 保护 `setRefreshingAll(false)`，否则单个 throw 让按钮永久卡 loading。`auto-discover-models.ts` 的 `probeAndApplyProvider` 是纯结果版本，专门给批量驱动用以便外层独占 toast。
12. **用共享 URL 猜 Token Plan 套餐** — 个人/团队命中同 endpoint；URL first-match 会静默换目录。必须使用持久化 `preset_key`，legacy ambiguous 要用户确认。
13. **把 xAI OAuth 静态目录冒充账号目录** — 上游 Build proxy 已有 authenticated `/v1/models`，但它需要 session header 合同和独立 virtual-provider 接线。未实现前只能把静态值标为 fallback；实现后也不能复用要求 DB row 的通用 `/discover-models` route。
14. **stable id 命中就覆盖 legacy 行** — stable id 只定位本地槽位，不能证明旧行仍归 catalog；插入冲突由 upstream wire 占用决定。只有完整 `legacyFingerprints` 与 ownership guard 同时成立才允许迁移，否则返回 `identity_conflict`。
15. **只给主模型写 legacy 指纹** — 一个套餐的历史目录通常同时换过 sonnet/opus/haiku 槽位。替换 SKU 时必须从已发布 git 历史逐槽列出 upstream/display/capabilities；不得造一个“看起来合理”但从未发布的 wire。fixture 必须用当时完整目录行数，不能只造目标单行。
16. **一条旧 duplicate 把已可用 current SKU 整体降为 conflict** — canonical current 行存在时，它是可用性真源；额外旧行需要在 Models 中可见/可整理，但不能让 Add dialog 只剩无动作徽章。真正 CAS 冲突必须服务端重读后返回 model ids，UI 消费并给出恢复入口。

## 9. 测试覆盖

| 测试文件 | 覆盖 |
|---|---|
| `catalog-only-discovery.test.ts` / `coding-plan-discovery-gate.test.ts` | 套餐型/xAI catalog-only gate，不发通用 discovery |
| 待补 `apply-discovery-diff.test.ts` | 五种 DiffEntryStatus 写库行为；user_edited / hidden 保留 |
| `provider-resolver.test.ts` 内 `buildResolution` 系列 | catalog merge / DB 优先 / hidden 抑制 |
| `foundation-refresh-user-path-contract.test.ts` U3 | 真实三行 GLM 旧目录中 sonnet/haiku 历史指纹原位升级到 5.3/Flash、非目标 opus 保留；Add Model 五态与 conflict ids/动作；stable/wire id 分离；隐藏候选可恢复；目录重加保留能力；重复 GET 零写；非 plan gate 反例 |
| `catalog-capabilities-roundtrip.test.ts` | catalog metadata round-trip、read merge 用户保护；upstream 去重、单旗标保护、capabilities COALESCE、排序避让与 INSERT 冲突赢家 |
| `qwen-token-plan-catalog.test.ts` | 三种 Qwen 套餐精确目录与默认角色 |
| `provider-preset-identity-migration.test.ts` | 共享 URL identity、legacy ambiguous 与保守迁移 |

加新 probe protocol / 改 apply 行为时，至少补对应单测；目前缺 model-discovery 的端到端 test，用真实 fetch mock 库（`undici` mock 或 `nock`）做。

## 10. 设计决策日志

- **初版（已淘汰）** — 纯只读 spike，POST 返回探测结果，不动 DB。简单但不解决"用户怎么应用"
- **第二版（已淘汰）** — 成功时**自动 upsert** 全部模型。Dialog 显示"已写入 N 个模型"。**违反用户改名 / 隐藏预期**，再次刷新回滚用户编辑
- **当前版（diff-first）** — refresh 返回 diff，UI 显示 diff 计数 + 用户点 Apply 才走单独的 `/apply` 写入。三阶段：probe → confirm → apply
- **首次刷新对旧自动写入数据**：第二版自动写入留下的行 source='manual'，第一次走新 flow 会被识别为 user_edited=0 + 'will-update'，apply 后变 'unchanged'。**这是一次性现象**，不是 bug
- **Capability 自动识别 V1 不做** — 现在 `capabilities_json` 始终 `{}`，UI 不展示也不让编辑；下一阶段补
- **图片 provider 不支持 refresh** — 上游 /v1/models 混合返回 text/audio/embedding，无法机器筛出图片模型；catalog 内置列表是事实来源
- **2026-07-21 Qwen/xAI catalog-only** — Qwen Coding/Token Plan 用官方套餐白名单，xAI 首版只暴露已验证的 `grok-4.5` Responses；通用 model-list 不能证明套餐/产品可用性。
- **2026-07-21 preset identity** — 同 URL 多套餐由 `api_providers.preset_key` 决定目录；legacy 歧义不再 first-match。
- **2026-08-14 Grok 4.6 review blocker** — `grok-4.6`/`grok-4.5` 继续使用内置 catalog，不改为通用 discovery；能力暴露必须同时通过生产 builder 与锁定 SDK 的真实 wire 测试。当前 `@ai-sdk/xai@4.0.18` 会在发网前拒绝 `xhigh`，因此 XHigh 不得仅凭模型文档或 helper 测试进入可选目录。
- **2026-08-14 xAI OAuth 专用 model-list** — Grok Build 上游源码确认 session auth 会请求 proxy authenticated `/v1/models`。CodePilot 当前行为仍归 Class C，因为 virtual provider 无 DB row 且尚未实现专用 parser/cache/UI；后续应增加 virtual-provider refresh，而不是把 bearer 塞进通用 discovery。
- **2026-08-15 GLM-5.3 存量目录热修** — v0.67.0 的 Runtime read-through 能把 pristine `sonnet/GLM-5.2` 临时解释为 5.3，但 Models GET 仍展示原始 DB，Add Model 又按稳定 alias 判成“已添加”。catalog-only plan 的 Models GET 现执行非破坏 merge：更新 pristine catalog metadata、补缺失 id，永不 disable/prune；搜索候选同时拆分 stable local id 与 upstream wire id，避免点击添加制造重复行。
- **2026-08-16 v0.67.1 review 收口** — 条件审查发现并发 INSERT、同 upstream 双行、hidden 候选死路、catalog 重加降级 manual 四类缺口。merge 改为 stable/upstream 双查重 + 条件 `INSERT OR IGNORE` + 用户排序避让；候选暴露 hidden/local-id 三态并可 PATCH 恢复；精确 plan catalog POST 由服务端目录重建完整 metadata。历史上已经存在的 user-owned 双行不自动删改，避免破坏 session pin/用户所有权；后续如需清理必须 preview-first。
- **2026-08-23 GLM legacy identity** — 存量迁移从 stable/source 猜测改为 catalog 明示的全字段旧指纹；搜索协议升级为五态。安全匹配可原子升级，upstream 被占用或任一字段歧义时只报告冲突，不替用户改写。
- **2026-08-24 implementation review remediation** — git 历史核实旧目录不止单个 sonnet 版本：补入 sonnet→`sonnet` 的 gen-0 `GLM-4.7`、`GLM-5-Turbo`/`GLM-5.2` 与 haiku→`haiku` 的 `GLM-4.5-Air`，删除从未作为 sonnet 槽位 upstream 发布的 `glm-5-turbo` 猜测。current canonical 行存在时不因额外旧 duplicate 整体降级；真正 CAS conflict 由服务端重读返回 model ids，Dialog 展示解释与 Models 恢复动作，并由行为测试锁住 fail-closed 分支。
- **2026-08-26 GLM-5.3-Flash** — catalog-only 搜索只展示当前 5.3 / Flash 两项，haiku 的已发布 4.5-Air 与 4.7 全字段快照作为 legacy fingerprint 原位升级；已经独立持久化的 Turbo 等退役行不因 GET 被 prune。目录更新与历史数据清理保持分离，避免读取页面制造不可逆变化。


## TokenDance 实测回归（2026-09-05）

- TokenDance 以实时 `supported_protocols` 筛选聊天模型，只默认启用六个精选精确 ID（`TOKENDANCE_FEATURED_MODEL_IDS`）；其余隐藏。不能因 defaultModels 为空而全部隐藏，也不能默认全部启用。
- 修复存量只通过保守刷新恢复系统管理行，manual_hidden/manual_enabled/user_edited 保持保护。同一 TokenDance 连接按模型协议快照计算 Runtime 能力；Kimi K3 当前不可用于 Claude Code，其他五个精选模型支持三个 Runtime。
- 语义验收必须覆盖 probe → apply → model feed → picker，不能以“授权成功 / 创建 provider / 空目录 mock”代替。回归见 tokendance.test.ts 与 tokendance-integration.spec.ts。
