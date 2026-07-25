# 千问 Token Plan 与 Grok OAuth 接入调研

> 调研日期：2026-07-21
> 触发信号：千问 AI 平台上线 Token Plan 个人版；用户提供 OpenCode xAI 登录截图，希望评估 SuperGrok OAuth 与 Grok 4.5 接入。
> 对应执行计划：[千问 Token Plan 与 Grok 4.5 接入](../exec-plans/active/qwen-token-plan-and-grok-access.md)

## 结论

1. **Coding Plan 没有简单改名为 Token Plan。** 截至 2026-07-21，官方仍维护阿里云百炼 Coding Plan、千问 Token Plan 个人版、千问 Token Plan 团队版三个独立产品，但供给状态不对等：Coding Plan Lite 仅存量，Pro 限量可购；Token Plan 是当前主推产品。三者的套餐语义、模型白名单和部分数据条款不同；Coding Plan 使用独立 host，个人版与团队版虽共用 Token Plan host，却不能因此被当成同一 preset。
2. **CodePilot 当前确实需要迭代。** 现有 `bailian` 少了 Coding Plan 新增的 `qwen3.7-plus`；`bailian-token-plan-cn` 仍是旧团队版三模型目录；仓库没有个人版 preset。更关键的是，个人版和团队版的 Anthropic Base URL 完全相同，当前只靠 `base_url + protocol` 匹配 preset，会把两套模型目录串在一起。
3. **截图展示的是 OpenCode 的 xAI Provider OAuth，不是 OpenCode 继承了 Grok Build 的登录态。** OpenCode 直接向 `auth.x.ai` 发起浏览器 PKCE 或 device-code 登录，再把 OAuth Bearer token 发给 `https://api.x.ai/v1`。
4. **OpenCode 的实现可以作为 CodePilot 的直接参考实现，但要接受上游兼容风险。** OpenCode 源码明确写明：xAI 会拒绝未 allowlist 的 loopback client，所以它复用了官方 Grok CLI 的公开 OAuth `client_id` 和固定回调端口。这不是拿走用户或 OpenCode 的凭据；风险在于 CodePilot 不是该 client 的注册主体，xAI 未来收紧 allowlist/redirect/referrer 时可能让登录突然失效。
5. **产品决定同时交付两条 xAI 渠道。** 一条是 xAI API Key + Grok 4.5 Responses API；另一条参考 OpenCode，使用公开 Grok CLI client 实现 SuperGrok 浏览器 PKCE 与 device-code OAuth。API Key 是稳定兜底，OAuth 作为兼容接入如实说明上游依赖；申请 CodePilot 自有 OAuth client 变成后续升级项，不再作为实施前置。

## 一、千问产品事实

### 1.1 三种套餐不是同一个产品

| 产品 | 建议稳定身份 | Anthropic Base URL | Key | 文本目录 | 备注 |
|---|---|---|---|---|---|
| 阿里云百炼 Coding Plan | 保留 `bailian` | `https://coding.dashscope.aliyuncs.com/apps/anthropic` | `sk-sp-` | 10 个精确 ID | Lite 已停新购/续费、仅存量；Pro 限量可购；按模型调用次数计量 |
| 千问 Token Plan 个人版 | 新增 `qwen-token-plan-personal-cn` | `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic` | `sk-sp-` | 6 个精确 ID | Credits；个人数据使用授权；5 小时 + 7 天窗口 |
| 千问 Token Plan 团队版 | 保留现有 `bailian-token-plan-cn` key 作为稳定兼容身份 | 同上 | `sk-sp-` | 15 个文本精确 ID | Credits；席位制；官方承诺不使用对话数据训练 |

结论：key 前缀不足以识别套餐；个人版与团队版连 host 也相同。只有用户显式选择并持久化的套餐身份，才能决定模型目录、说明文案和后续行为。个人版同一实名认证主体限购一份；个人/团队套餐 Key 都只在创建或重置时完整显示一次，这两项应成为配置 UI 的防丢提示。

### 1.2 精确文本模型白名单

Coding Plan（10 个）：

- `qwen3.7-plus`
- `qwen3.6-plus`
- `qwen3.5-plus`
- `qwen3-max-2026-01-23`
- `qwen3-coder-next`
- `qwen3-coder-plus`
- `kimi-k2.5`
- `glm-5`
- `glm-4.7`
- `MiniMax-M2.5`

Token Plan 个人版（6 个文本模型）：

- `qwen3.8-max-preview`
- `qwen3.7-max`
- `qwen3.7-plus`
- `qwen3.6-flash`
- `glm-5.2`
- `deepseek-v4-pro`

Token Plan 团队版（15 个文本模型）：

- `qwen3.8-max-preview`
- `qwen3.7-max`
- `qwen3.7-plus`
- `qwen3.6-plus`
- `qwen3.6-flash`
- `deepseek-v4-pro`
- `deepseek-v4-flash`
- `deepseek-v3.2`
- `kimi-k2.7-code`
- `kimi-k2.6`
- `kimi-k2.5`
- `glm-5.2`
- `glm-5.1`
- `glm-5`
- `MiniMax-M2.5`

官方页面同时列出的图片/视频模型不应直接塞进聊天模型选择器；它们使用独立接口，应继续归入媒体/Skill 能力的后续范围。

### 1.3 Claude Code 官方默认映射

个人版与团队版当前示例相同：

| 角色 | 官方值 |
|---|---|
| 主模型 / Sonnet / Opus | `qwen3.8-max-preview` |
| Haiku | `qwen3.6-flash` |
| Subagent | `qwen3.7-max` |
| 最大上下文 | `983616` |

`qwen3.8-max-preview` 的官方说明是 thinking 始终开启，`reasoning_effort` 支持 `low/high/xhigh`，默认 `xhigh`；thinking 模式 `temperature` 默认 `0.6`，传入小于 `0.6` 时上游自动钳制到 `0.6`。这类能力必须沿用仓库现有模型级 capability 合同，不能把目录存在误写成所有模型都支持同一档位，也不能向用户假装低于 `0.6` 的值被原样执行。

团队版页面给出 15 个套餐 ID，并在套餐级声明兼容 OpenAI/Anthropic 标准，但未逐模型保证每个 ID 的 Anthropic wire。目录可以按白名单入库；`deepseek-v3.2`、`kimi-k2.7-code`、`MiniMax-M2.5` 等逐模型“已验证”状态仍必须来自真实请求，而不是从套餐级文案推导。

### 1.4 使用范围约束

三种订阅页都禁止自动化脚本、应用后端和非交互式批量调用，但允许范围的原始措辞并不完全一样：Token Plan 明写编程工具和智能体工具，Coding Plan 写编程工具。产品卡应分别保留官方措辞。对 CodePilot 而言，前台用户发起的聊天/Agent run 可以按工具集成路径设计；自动标题、定时任务、heartbeat、后台媒体规划等不能默认继承这些套餐 provider。

这不是只写一条提示就够了：如果 UI 允许用户把套餐设为后台任务 provider，产品行为会直接违背页面承诺。执行计划因此要求新增机器可读的 `interactive_only` 使用策略，并在后台入口 fail closed。

## 二、Grok Build、SuperGrok OAuth 与 OpenCode 的真实关系

### 2.1 官方 Grok Build 能力

xAI 官方文档确认：

- Grok Build 是官方 coding agent，可运行 TUI、headless，并通过 ACP 嵌入其他应用。
- 官方登录方式包括浏览器 OIDC、`grok login --device-auth`、外部认证提供方和 API Key。
- 浏览器/设备登录走 `auth.x.ai`，第一方 session 推理主要走 `cli-chat-proxy.grok.com`；API Key 直连走 `api.x.ai`。
- `grok-4.5` 同时作为官方 API 模型提供，示例 endpoint 是 `POST https://api.x.ai/v1/responses`。
- 2026 年 6 月起，SuperGrok 付费用户以一份周额度在 Chat、Imagine、Voice、Build 等产品间共享；官方 Usage 页面还会分产品展示 API/Build 等消耗。

这些事实证明“SuperGrok 订阅可支撑官方 Grok Build 使用”，但没有自动证明任意第三方桌面客户端都能冒用 Grok CLI 的 OAuth client。

### 2.2 OpenCode 当前怎么做

OpenCode v1.15.7 合并了 xAI OAuth：

- 浏览器流：PKCE S256 + state + nonce，固定回调 `http://127.0.0.1:56121/callback`。
- 设备流：请求 `https://auth.x.ai/oauth2/device/code`，按 RFC 8628 处理 `authorization_pending`、`slow_down`、拒绝和过期。
- Scope：`openid profile email offline_access grok-cli:access api:access`。
- 请求路径：由 `@ai-sdk/xai` 默认发送到 `https://api.x.ai/v1`，fetch override 注入 OAuth Bearer token。
- 生命周期：提前刷新、单航班 refresh、处理 refresh token rotation，并回写新 token pair。
- 验证证据：当前 `xai.test.ts` 有 26 个显式 `test()` 用例、5 个 `describe`；合并 PR 的 Bun runner 记录为 `51 pass / 144 expectations`，并记录真实 SuperGrok 两种登录 smoke。两种计数口径不能混写成“51 个测试用例”。

最重要的实现注释是：

- xAI 会拒绝非 allowlist 客户端的 loopback OAuth。
- OpenCode 因此复用了公开 Grok CLI OAuth client id。
- 固定 host/port 是该 client 已注册 redirect URI 的一部分。
- `referrer=opencode` 只是 best-effort attribution，不能把借用的 client 变成 OpenCode 自己注册的 client。

所以，截图能证明 OpenCode 已经把这条非标准集成做通，不能证明 CodePilot 可以无条件复制同一客户端身份。

### 2.3 三条容易混淆的 Grok 渠道

| 渠道 | 鉴权 | 额度/计费 | CodePilot 判断 |
|---|---|---|---|
| xAI API | `XAI_API_KEY` | xAI API 按量/账户计费 | 官方、稳定，可优先实现 |
| Grok Build 官方客户端 | 浏览器/设备 OIDC 或 API Key | SuperGrok/企业 session 或 API Key | 可研究 ACP 委托，不读取其 token 文件 |
| OpenCode xAI Provider | SuperGrok OAuth 或 API Key | OpenCode 文档称可使用包含 API access 的 Grok/X 订阅 | 直接参考实现；CodePilot 接受同类兼容风险，并保留 API Key 兜底 |

OpenCode Zen 的 `grok-4.5` / `grok-build-0.1` 是另一条付费网关，不是截图里的 SuperGrok OAuth，也不应混进本计划。

## 三、CodePilot 现状与缺口

### 3.1 千问 preset 身份会串线

- `src/lib/provider-catalog.ts` 现有 `bailian` 是 9 模型旧目录；缺 `qwen3.7-plus`。
- `bailian-token-plan-cn` 仍只有 `qwen3.6-plus / glm-5 / MiniMax-M2.5`，与当前团队版 15 个文本模型不符。
- renderer `findMatchingPreset()` 与 server `findMatchingPresetForRecord()` 都优先按 `base_url + protocol` 推断；运行时还大量调用 `findPresetForLegacy()`（包括 hostname fuzzy first-match），legacy protocol 又有独立的 `inferProtocolFromLegacy()` host 白名单。只改前两个 matcher 会让 Settings 正确、实际 wire 仍串线。
- 个人版和团队版共用同一 URL/protocol；如果只新增一个 personal preset，数组顺序就会决定用户被识别成个人还是团队，属于静默 cross-wire。
- `provider-doctor.ts` 已留下相同事实注释：没有持久化的 `preset_key` 就不能区分同 URL 的套餐。

### 3.2 xAI 没有产品级接入

- 仓库没有 xAI/Grok provider、OAuth virtual provider 或 `@ai-sdk/xai` 依赖。
- 当前通用 `openai-compatible` 默认走 Chat Completions；xAI 对 Grok 4.5 的官方 coding 示例走 Responses API，不能只换一个 base URL 就宣称完整兼容。
- OpenAI OAuth 已有本地 callback、refresh 和 virtual provider 先例，但 token 存在 SQLite `settings` 明文；API key 也仍有 tech-debt #40。用户已裁决本轮可沿用该安全边界，但实现不能复制其生命周期缺陷：现有 manager 没有 refresh single-flight，token pair 是多次 `setSetting` 非原子写，且任何 refresh 错误都会清空凭据。
- CodePilot 有前台聊天、Codex provider proxy、后台定时任务、heartbeat、Bridge 和后台生成等多种调用面；套餐型凭据必须有使用场景 gate，不能只在 provider card 上加一行。

### 3.3 后台/辅助调用面比原计划更大

代码复核发现，原计划已列的 title、compact、scheduled/heartbeat、media 之外，还漏了 17 个 LLM 调用位点：memory extractor 1、memory search rerank 1、onboarding 4、check-in 3、quick actions 1、dashboard CLI/file refresh 2、CLI describe 1、skill search raw fetch 1、task-scheduler 默认 provider fallback 1、connection test 1。`skills/search` 还绕过统一 generation 层，自行按 URL 子串猜鉴权。

因此 gate 必须落在 `resolveProvider` / `resolveAuxiliaryModel` / generation/headless 收口点，由必填 `callScene` 驱动。执行计划采用以下边界：当前用户回合为继续对话触发的 compact 可用当前 session 套餐 provider；隐藏的自动标题、自动记忆抽取、快捷建议和 scheduled/heartbeat 拦截或走确定性 fallback；onboarding/check-in、手动 dashboard refresh、CLI describe 等只有用户明确触发才放行。`resolveAuxiliaryModel` 枚举其他 provider 时必须排除 `interactive_only`，避免另一会话借用套餐额度。

## 四、推荐方案

### A. 千问：进入实现

- 在 `api_providers` 增加显式 `preset_key`，四条身份推断路径及派生谓词都先认该字段；同 URL 的 ambiguous preset 禁止 first-match。
- 保留 `bailian` 和 `bailian-token-plan-cn` 稳定 key，新增个人版 key；不要用一次重命名破坏存量 provider。
- 按官方精确白名单更新三套 catalog、角色映射、文档链接、数据条款提示和 `interactive_only` policy。
- 迁移只 backfill 可证明的旧 preset fingerprint；不确定行要求用户在编辑页确认套餐，不能猜个人/团队。
- media/Harness 另立后续，不污染 chat picker。

### B. Grok 4.5 API Key：可独立实施

- 新增 branded xAI provider，优先采用 `@ai-sdk/xai` + `xai.responses('grok-4.5')`，不要把它伪装成普通 Chat Completions gateway。
- 首版仅承诺 CodePilot Runtime 与 Codex Runtime；Claude Code Runtime 没有同协议直连路径，不显示伪兼容。
- API key 路径不依赖 SuperGrok OAuth 的授权结论，可先完成并真实 smoke。

### C. SuperGrok OAuth：参考 OpenCode 直接实施

- 使用 OpenCode 已验证的公开 Grok CLI OAuth client、`auth.x.ai` endpoints、scope、固定 loopback redirect 与 `plan=generic` 参数。
- 同时实现浏览器 PKCE 与 RFC 8628 device-code；桌面默认浏览器，远程/端口受限环境可选设备码。
- 通过 `@ai-sdk/xai` 的 fetch override 把 OAuth Bearer token 发到 `https://api.x.ai/v1`，与 API Key provider 复用同一 Grok 4.5 Responses 模型目录。
- 真实 SuperGrok smoke 必须核对请求成功且消耗进入正确账号；API Key 与 OAuth 状态、文案和注销互不串线。
- UI 如实说明这是兼容 OAuth 接入，可能受 xAI 上游策略调整影响；保留 API Key 入口作为稳定兜底。
- 后续若取得 CodePilot 自有 public client，替换 client/redirect 而不改变用户侧 provider identity。
- Grok Build ACP 保留为未来“接入完整 Grok coding agent”的独立 Runtime 方向，不再阻塞本轮模型 Provider OAuth。

### D. OAuth 安全与兼容要求

- 首版按项目现有 OpenAI OAuth 的 SQLite settings 安全边界落地并显式继承 tech-debt #40；不得把当前存储宣传为 OS keyring 安全存储。统一迁移到 Electron `safeStorage` 仍由独立凭据仓计划处理，不阻塞本轮 xAI OAuth。
- xAI token bundle 使用单个 JSON setting 一次写入；refresh single-flight 是新实现，不把现有 OpenAI manager 当作已满足先例。`invalid_grant`/明确撤销或过期才清凭据；网络、timeout、429、5xx 保留 bundle 并重试。
- callback 只监听 loopback，校验 PKCE/state/nonce，限制 origin，处理取消/超时。固定 `56121` 被占用时浏览器流报错并引导 device flow，不能随机换端口。
- device flow 遵守 server interval、`slow_down` 和 deadline。
- API/日志/诊断中不得回显 access token、refresh token、auth code 或 device code。
- logout 清除所有本地凭据。截至 2026-07-21，xAI 公开 Management API 文档化的是 API-key delete/rotate，未文档化 OAuth revoke endpoint；首版提供 `accounts.x.ai` 手动撤销入口，未来出现官方 revoke endpoint 再接入。

## 五、决策闸门

| 问题 | 通过条件 | 不通过时 |
|---|---|---|
| Qwen personal/team identity 能否稳定保存？ | DB/API/renderer/server/resolver/doctor 都以 `preset_key` 为真源，ambiguous URL 不 first-match | 不增加个人版 preset |
| xAI API key 是否真实可用？ | `grok-4.5` Responses 两轮聊天 + 工具调用在 CodePilot/Codex Runtime 通过 | provider 保持实验，不标 verified |
| OpenCode-compatible OAuth 是否可用？ | 浏览器/device 两种登录、refresh rotation、Grok 4.5 两轮请求真实通过 | 暂时关闭 OAuth 入口，API Key 渠道继续可用 |
| 上游是否收紧 Grok CLI client 复用？ | release smoke 持续通过，错误分类能识别 allowlist/redirect 变化 | 快速降级为仅 API Key，并评估自有 client/ACP |
| OAuth token 生命周期是否可靠？ | 按现有存储架构持久化；并发 refresh 单航班、rotation 原子更新、日志/API 不泄露 | 不发布 OAuth；不影响 API Key 渠道 |

## 六、来源

千问官方：

- [Token Plan 个人版概述](https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-overview)
- [Token Plan 个人版快速开始](https://platform.qianwenai.com/docs/token-plan/personal/token-plan-personal-quickstart)
- [Token Plan 团队版概述](https://platform.qianwenai.com/docs/token-plan/team/token-plan-team-overview)
- [Token Plan 团队版快速开始](https://platform.qianwenai.com/docs/token-plan/team/token-plan-team-quickstart)
- [Claude Code 接入](https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/claude-code)
- [Qwen Code 接入与 qwen3.8 sampling 说明](https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/qwen-code)
- [Token Plan API Key 准备](https://platform.qianwenai.com/docs/api-reference/preparation/api-key)
- [阿里云百炼 Coding Plan](https://help.aliyun.com/zh/model-studio/coding-plan)

xAI 官方：

- [Grok 4.5 模型页（`grok-4.5`，2026-07-21 发布前复核）](https://docs.x.ai/developers/models/grok-4.5)
- [Grok Build 概述](https://docs.x.ai/build/overview)
- [Grok Build 企业部署与鉴权](https://docs.x.ai/build/enterprise)
- [Grok Build 设置与模型](https://docs.x.ai/build/settings)
- [Grok / SuperGrok 使用额度 FAQ](https://docs.x.ai/grok/faq)
- [xAI Management API（公开 API-key 管理面）](https://docs.x.ai/developers/management-api-guide)

OpenCode 一手实现：

- [OpenCode xAI Provider 文档](https://opencode.ai/docs/providers/#xai)
- [OpenCode v1.15.7 Release](https://github.com/anomalyco/opencode/releases/tag/v1.15.7)
- [xAI OAuth PR #28557](https://github.com/anomalyco/opencode/pull/28557)
- [xAI provider 源码](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/xai.ts)
- [xAI provider 测试](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/test/plugin/xai.test.ts)
