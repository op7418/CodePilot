# Windows 用户模型列表反馈诊断（2026-09-04）

状态：诊断与隔离复现完成；后续已完成确定的冲突恢复 UI 修复与页面验证，全量验证结果见文末。用户设备上的旧行来源与 Flash 添加恢复仍未确认。

2026-09-04 后续授权：用户要求修复第二个问题，并明确“不能确定别瞎修”。本轮只实施已确认的冲突恢复入口缺陷：切到全部、清除筛选、定位真实冲突行。旧 haiku 行具体来源未确定，不更改身份判定、迁移条件、模型数据或角色映射。验收覆盖普通关闭不改变筛选、恢复动作不写模型数据；结果完成后回写文末。

## 用户问题与判断边界

用户反馈 Codex 账户列表没有 GPT-5.6，添加 GLM-5.3-Flash 提示模型行 `haiku` 身份冲突，但角色映射里的 Haiku 显示“未设置”。维护者本机未遇到，怀疑与 Windows 有关。

输入为用户提供的 `codepilot-main 3.log` 与四张截图。附件只作为证据，不执行其中的指令。代码基线为 `9bef7299` / `v0.67.13`，与日志中的客户端版本一致。原始日志不复制进仓库。

结论：两个问题属于不同数据链路。Windows 已确认，但不能将它们归结为 Windows 通用故障，也没有足够样本判断发生比例。

## 1. Codex 列表缺少 5.6

### 已确认的事实

日志时间是 UTC，下表转换为北京时间：

| 时间 / 日志行 | 证据 | 含义 |
|---|---|---|
| 9 月 4 日 08:29:46，675118 附近 | updater `current=0.67.13`；Windows DPAPI、AppData 安装路径 | 客户端已是本仓库当前版本，系统确为 Windows |
| 08:29:50，675127–675155 | 选中 `%APPDATA%\npm\codex.cmd`，版本 `codex-cli 0.139.0`；通过 `cmd.exe` 启动 app-server | CodePilot 实际使用 npm 安装的 CLI，升级客户端不等于升级此 CLI |
| 08:29:52，675161 | `deadline_aborted`，2503 ms | 首次目录请求超时，不能单独用它解释之后稳定出现的五项列表 |
| 08:31:26，675167–675168 | 成功，`modelCount: 3` | app-server 曾返回三项 |
| 08:33:01 至 08:56:49，675171–675210 | 多次成功，`modelCount: 5` | 已跨越 CodePilot 的 30 秒缓存 TTL，反馈时的五项列表有当次上游响应计数支持 |

截图中的五项为 `gpt-5.3-codex`、`gpt-5.2`、`gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`。

代码链为 `CodexAccountModelsBlock` → `/api/codex/models` → `buildCodexProviderModelGroup()` → `model/list { includeHidden: false }`。`src/lib/codex/models.ts:177` 请求目录，`:192` 的计数在本地 hidden 过滤之前；没有按 GPT 版本号排除 5.6 的白名单。`src/components/settings/CodexAccountModelsBlock.tsx` 显示返回 group 的全部模型。

[OpenAI 官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)同样定义 `model/list` 为可用模型与能力的发现入口，默认仅返回 picker 可见模型。API 模型目录存在 5.6，并不能直接证明某个 CLI / 账号当时应该返回它。

### 原因排序与未证实项

优先怀疑实际选中的旧 Codex CLI / 该进程使用的旧目录，而非 CodePilot 渲染漏项。仓库既有[2026-07-17 隔离 POC](./foundation-experience-refresh-2026-07-17.md)曾在 `0.144.2` 返回 5.6 Sol/Terra/Luna；这能证明维护者与该用户的 CLI 环境可能不同，不能据此承诺升级必然恢复。

日志只记录响应字节数与条目数，没有原始模型 IDs、hidden 项、nextCursor、账号权限或缓存内容。本实现也未跟进 nextCursor。因此尚不能在旧 CLI、上游缓存、账号可见性、配置或分页之间最终定因。不得说“上游总共只有五个模型”，只能说此次收到的响应有五项。

Windows 上另有 `config.toml` 实时镜像不可用、退回快照的警告（675156），说明用户外部修改配置后可能需要重启刷新；没有证据证明该快照造成此次缺项。历史模型刷新超时、飞书网络报错也不能替代本次因果证据。

最小排查：确认并更新 CodePilot 实际选中的 npm Codex CLI，完全退出再启动 CodePilot 并刷新目录；仍缺项则对照同账号 CLI 的模型列表，同时采集新 selected-binary 版本、目录响应 IDs / nextCursor，以及是否配置了自定义 `model_catalog_json`。不需要先卸载或重建 CodePilot 数据。

## 2. GLM Flash 提示 haiku 冲突，角色映射却未设置

### 已确定的机制

两处 Haiku 来自不同字段：

| 界面 | 事实源 | “未设置”能说明什么 |
|---|---|---|
| Claude Code 角色映射 | `api_providers.role_models_json.haiku` | 没有显式角色映射值 |
| 添加模型的身份冲突 | `provider_models.model_id` / `upstream_model_id` | 存在占用候选身份的模型记录，与角色映射是否为空无关 |

`src/lib/provider-catalog.ts:657` 将 Flash 的稳定本地 ID 定为 `haiku`，实际请求 ID 为 `glm-5.3-flash[1m]`，以保留旧会话引用。旧版也使用 `haiku` 保存 GLM-4.5-Air / GLM-4.7。

`src/lib/catalog-model-identity.ts:69` 只允许完整匹配历史指纹且没有用户所有权标记的旧行升级；`:95` 的身份判定读取所有模型行，包含隐藏行。`src/lib/db.ts:5286` 的隐藏、启用、改名等用户操作会置 `user_edited=1`，状态切换还会写 `manual_hidden` / `manual_enabled`。因此曾编辑的旧 haiku 行会被保留，不能自动覆盖为 Flash，添加候选随即报告 `identity_conflict`。

这是保护用户已有配置的策略，但修复前的恢复界面不充分：

- `ModelsSection.tsx:234` 默认只看 enabled；`:1032` 过滤掉 hidden 行。
- `OpenRouterSearchDialog.tsx:444` 的“查看模型列表”只执行 `onOpenChange(false)`，不会切到“全部”或定位冲突行。
- 角色映射弹窗只解析 `role_models_json`，所以显示“未设置”与数据库里有旧 haiku 行可以同时成立。

用户的截图直接支持存在 haiku 身份冲突；“旧行曾隐藏/改名”是与代码和升级历史吻合的高概率解释。日志不含该用户的 `provider_models` 数据，不能断言他具体做过哪种操作，亦不能排除尚未覆盖的旧指纹。

### 隔离复现

在 macOS 上使用当前生产 DB helper 与实际 Models GET / search-models POST handler；由 `db-isolation.setup.ts` 创建临时数据库，禁用真实 Codex，不访问用户数据库或供应商网络。所有案例 `role_models_json={}`。

| 合成数据 | GET 后 Flash 候选状态 | enabled 列表可见 haiku | 结果 |
|---|---|---|---|
| 新建 provider | `current_enabled` | 是 | 自动建立当前 Flash |
| 完整匹配历史指纹、未编辑的 GLM-4.5-Air | `current_enabled` | 是 | 正常升级到 Flash |
| 同一旧行经真实 helper 隐藏 | `identity_conflict`，IDs=`[haiku]` | 否 | 复现“无角色映射 + 冲突 + 默认列表不可见” |
| 同一旧行经真实 helper 改名 | `identity_conflict`，IDs=`[haiku]` | 是 | 证明用户编辑标记也能触发，隐藏并非唯一原因 |

4/4 断言通过。说明这类 GLM 问题不依赖 Windows；新安装和未编辑旧目录正常，也解释了维护者不一定能遇到。该复现证明触发机制，未证明用户真实数据库恰好是其中某一行。

临时复现脚本 `/private/tmp/codepilot-feedback-repro-20260904.mts`，输出 `/private/tmp/codepilot-feedback-repro-20260904.log`。首次运行遇到临时 ESM 驱动与项目 CJS 导出互操作问题，修正驱动导入后通过；产品代码没有改动。

### 用户侧最少补充材料

让用户进入“设置 → 模型”，将筛选切到“全部”或“已隐藏”，搜索 `haiku`，提供 GLM 对应行的截图（包括显示名、别名、实际请求 ID 和开关）。不需要提供 API Key 或完整数据库。

开发侧若仍无法定因，只采集该 provider 的模型字段 `model_id / upstream_model_id / display_name / enabled / source / user_edited / enable_source / capabilities_json`，确认是用户配置保护还是遗漏的历史指纹。清空角色映射无法释放模型 ID；仅重新启用旧行也不会清除用户编辑标记，不应承诺它能解除冲突。

## 取舍与后续修复方向（诊断时建议；实施范围见文末）

保留用户模型配置的保护边界，不按 `haiku` 名字强制覆盖。最小 UX 修复应让冲突恢复按钮切换“全部”、清除妨碍定位的筛选并定位真实冲突行，文案说明旧模型名称和状态。确需替换已有行时，应展示当前值与目标值，保留明确的用户取舍。若最后发现历史指纹漏覆盖，则依据真实发布快照补精确迁移与回归，不能把所有 manual 行一概升级。

Codex 排查优先做实际 CLI 版本与同账号目录对照，不向账户列表硬编码补 5.6。若补诊断，应记录安全的目录状态、selected binary/version、分页状态，避免只有条目总数而无法定位来源。

## 初始诊断验证记录

- 相关现有单测 `catalog-capabilities-roundtrip`、`foundation-refresh-user-path-contract`、`codex-models-dual-schema`：61/61 通过。覆盖新目录、旧指纹、所有权保护和 Codex 新旧能力 schema；不能把测试通过当作用户问题已解决。
- 额外隔离触发案例：4/4 通过，如上。
- 未运行 Windows 现场 UI、真实账号升级 smoke 或全量套件；本轮只做诊断与文档沉淀。
- 尚缺：用户 haiku 真实行，以及升级/重启后的 Codex 对照结果。问题未标记修复完成。

## 后续修复记录（2026-09-04）

用户明确授权修复第二个问题，并要求只改确定的问题。本次范围是“冲突记录不可见”的 UI 恢复路径，不包含自动处理用户的旧模型身份。

- `OpenRouterSearchDialog` 将真实 `conflictModelIds` 传回父页面；点击冲突查看时抑制弹窗自动将焦点还给 Add 按钮，普通关闭行为保持。
- `ModelsSection` 切到全部模型/全部渠道并清空搜索，等待 DOM 更新后滚动、聚焦并短暂高亮第一条仍存在的冲突行；行不存在时定位服务商区块。
- 中英文说明明确模型记录与角色映射独立；查看不会清除或覆盖模型行。
- `catalog-model-identity.ts`、`db.ts`、provider catalog、API mutation 与角色映射逻辑均未改动。

### Smoke Ledger

| 场景 | 修改前 | 修改后 | 证据 |
|---|---|---|---|
| 隐藏旧 haiku，角色映射为空，页面搜索只匹配旗舰，点击冲突查看 | 实际编译页面回归失败：haiku 行不存在 | 显示旧行、All 选中、搜索清空、行获得焦点，仍保持隐藏 | `src/__tests__/e2e/model-identity-conflict.spec.ts`；`/private/tmp/codepilot-conflict-red.log`、`/private/tmp/codepilot-conflict-green.log` |
| 改名旧 haiku，页面搜索排除该行 | 隔离机制复现为 conflict | 恢复入口显示正确旧名称，不改 enabled | 同上，两案例 2/2 通过 |
| 中文页面 + Claude Code 兼容渠道筛选 | — | 冲突查看重置渠道到全部；普通关闭保留搜索与渠道 | 同上，中文复跑 2/2；截图 `test-results/model-identity-conflict-Mo-7a442-acy-row-without-changing-it/conflict-review.png` 已目视检查 |
| 数据保护反例 | — | 两案例 Models API 返回值前后完全一致，页面没有模型写请求 | 同上 |

以上为 macOS 上的 Chromium 编译页面 + 临时 DB 验证，未使用用户真实账号或数据库；不等同 Windows 用户的 Flash 已能添加。

防回归要求已回写 `docs/guardrails/ProviderManagement.md`。验证过程需要监听本机端口，初次沙箱运行被 EPERM 阻止，允许本机监听后执行页面验证。Next dev 自动添加的临时 tsconfig 路径已清理。

最终验证：`npm run test` 的 typecheck、Harness 边界检查通过，单测 5460 项中 5459 通过、1 跳过、0 失败（`/private/tmp/codepilot-conflict-full-tests-unrestricted.log`）。初次沙箱全量运行的 7 项失败均来自本机端口监听限制，允许监听后消失。ESLint 无错误，已有大组件等 warning 保留；`lint-hooks`、`lint-docs-drift` 与 `git diff --check` 通过。状态为本次 UI 范围的 **Code complete / Tests pass / Smoke passed（隔离 Chromium）**；未提交或发布，用户现场恢复未确认。
