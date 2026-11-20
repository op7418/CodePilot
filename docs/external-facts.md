# 外部事实手册

代码里读不出来的事实：第三方服务商、上游 SDK / CLI、操作系统和 IM 平台的行为。每条都是当时实测或查证的结论，括号里是记录日期；模型、版本、价格类信息会过期，用之前按日期判断是否需要重新核实。

新增条目时只写事实和日期，不写本项目的代码怎么实现。

## 服务商与模型

- Claude Code 上游只有 4 个 provider：firstParty / bedrock / vertex / foundry，由 `CLAUDE_CODE_USE_*` 环境变量选择。（2026-04）
- Claude Code 重试：默认 10 次指数退避；连续 3 次 529 切 fallbackModel；429 读 retry-after。Bedrock 的 beta 只能走 extraBodyParams，不是 header。（2026-04）
- `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 在 `@anthropic-ai/claude-agent-sdk@0.2.62` 全文 0 命中，不生效。（2026-04-15 实测）
- 各家要求的认证变量：
  - OpenRouter：`ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY=""`，模型 ID 带 `anthropic/` 前缀
  - 智谱 GLM（国内 / 海外）、MiniMax、火山、小米 MiMo：`ANTHROPIC_AUTH_TOKEN`
  - Kimi：`ANTHROPIC_API_KEY` + `ENABLE_TOOL_SEARCH=false`
  - Moonshot：`ANTHROPIC_AUTH_TOKEN` + `ENABLE_TOOL_SEARCH=false`
  - 阿里云百炼：`ANTHROPIC_AUTH_TOKEN`，必须用 `sk-sp-` 开头的 Coding Plan Key
  - Ollama：`ANTHROPIC_AUTH_TOKEN=ollama` + `ANTHROPIC_API_KEY=""`，本地地址
- 多数兼容服务商同构：`ANTHROPIC_BASE_URL=https://<endpoint>/anthropic` + AUTH_TOKEN + MODEL + `API_TIMEOUT_MS=3000000`。
- 已知坑：Kimi 必须关 tool_search；小米 MiMo 不支持 Thinking；火山需先激活 endpoint。（2026-04）智谱计费规则见下方 GLM 小节。
- 计费模式：订阅制（火山 / 百炼 / MiMo / GLM 积分 / MiniMax）；按量（Anthropic / OpenRouter / Bedrock / Vertex / Kimi / Gemini）；自托管（Ollama / LiteLLM）。
- Gemini 走 Google AI Studio 而非 Vertex：Vertex 需要 GCP OAuth，门槛高。

### 各家 `/models` 接口（2026-05-06）

- Ollama 用 `${baseUrl}/api/tags`，不需要鉴权。
- Gemini `v1beta/models?key=…` 返回文本、embedding、音频模型混在一起（当天 50 个），按名字过滤图像模型不可靠。
- OpenRouter `/v1/models` 是 300+ 模型的全量目录。
- 火山方舟的 Coding Plan 模型名和 Ark 在线推理 Model ID 是两套；同 host 的 `/v1/models` 返回 100+ 个（含图像、embedding、已废弃），调用套餐外模型会 4xx，还可能额外计费。
- 百炼 FAQ：调用不在 Coding Plan 列表里的模型会报错。
- DeepSeek `/v1/models` 仍列 v3.x 旧型号。
- OpenAI OAuth（ChatGPT 登录）没有可调用的模型列表接口。
- 未实测：Anthropic 官方 `/v1/models` 分页且绑定组织计费范围。

### Anthropic

- `claude-sonnet-5`：1M context，adaptive thinking，不再支持手动 extended thinking。`claude-fable-5`：GA，1M，adaptive thinking 始终开启，支持 effort。（2026-07-20）
- `claude-fable-5-1`：1M 上下文，最大输出 128K，adaptive thinking 始终开启，默认 effort high。强制 `tool_choice: any/tool` 返回 400；旧模型会丢弃读不懂的 5.1 thinking；保留 thinking 的同时改动之前的 system / tools / messages，在开启校验的账号上会报签名或前缀不匹配。（2026-09-05）

### OpenAI / Codex 模型

- GPT-5.6 有 Sol / Terra / Luna 三款；API effort 为 none / low / medium / high / xhigh / max，Codex 侧另有 `ultra`。（2026-07-20）
- `gpt-6-astra` API：总上下文 1,050,000，最大输入 922,000，最大输出 128,000；effort low / medium / high / xhigh / max。（2026-09-05）
- Codex 里 Astra 默认原始窗口 272,000，可配上限 872,000（`max_context_window`）；有效窗口 = 原始 × 95%（默认 258,400），自动压缩阈值 = min(原始 × 90%, 显式阈值)（默认 244,800）。Codex catalog 多一个 `ultra` 档（自动委派），API 没有。Codex 0.153.1 可配置 Astra 但 picker 不显示，0.153.4 修复；实际可见型号还取决于账号和远程目录。（2026-09-05）
- 当时的 `@ai-sdk/openai` 只把 `o1/o3/o4-mini/gpt-5*` 当推理模型：Astra 不加 `forceReasoning:true` 时整个 `reasoning` 字段被丢掉（离线抓包）。（2026-09-05）

### Google AI Studio / Gemini（2026-09-18）

- AI Studio key 访问 `generativelanguage.googleapis.com`，不走 Vertex 的 project / location / ADC。
- `gemini-3.8-flash` GA：输入 1,048,576，输出 65,536；thinking 档位 low / medium / high，默认 medium，没有 minimal；官方迁移说明要求去掉 temperature / top_p / top_k。
- 有 OpenAI Chat Completions 兼容入口 `/v1beta/openai/`，没有 Responses，也没有官方 Anthropic Messages 入口；Claude Code 官方说明网关不支持非 Claude 模型。
- 官方推荐 Interactions API（默认服务端存储，`store:false` 时要客户端完整重放）；generateContent 标 legacy 但完整支持。FunctionResponse 字段名在迁移清单写 `call_id`、REST schema 写 `id`，以实际 wire 为准。
- `@ai-sdk/google@4.0.6`：显式 temperature 会原样发出；历史缺 thoughtSignature 时自动注入 `skip_thought_signature_validator` 并报 warning（离线抓包）。

### 智谱 GLM Coding Plan（2026-08-26；标 08-14 的为当时快照）

- 中国区只列 GLM-5.3 和 GLM-5.3-Flash，全套餐开放；旧 5.2 / 5.1 自动路由到 5.3，旧 5-Turbo / 4.7 路由到 5.3-Flash。
- Claude Code 用 `glm-5.3[1m]` / `glm-5.3-flash[1m]`；Codex Responses 用不带 `[1m]` 的 ID。
- Endpoint：Anthropic 中国区 `https://open.bigmodel.cn/api/anthropic`、国际区 `https://api.z.ai/api/anthropic`；Responses 中国区 `https://open.bigmodel.cn/api/v1`、国际区 `https://api.z.ai/api/v1`。未实测：Flash 走 Responses 是从模型页推断的。
- 两款都标称 1M（示例写 1,000,000，没有依据说是 1,048,576）；5.3 最大输出 131,072（08-14）。5.3 只收文本，图片靠套餐附带的 GLM-4.6V Vision MCP；Flash 原生支持图片。
- 推理档位 Low / High / Max，默认 Max；minimal / light / low → low，medium / high → high，xhigh / max / ultra → max；显式 effort 优先于 thinking 开关。Flash 的 `thinking.type` 只能是 `enabled`。
- 积分倍率（输入 / 缓存 / 输出）：5.3 是 6.9 / 1.7 / 24（08-14），Flash 是 2.3 / 0.56 / 8。高峰为工作日 14:00–18:00（UTC+8），非高峰按积分表 50% 消耗（08-14）。2026-04 时的说法是"高峰 3 倍计费"，已被这条规则取代。

### DeepSeek

- `deepseek-v4-pro` 没有单独的 0813 ID，服务端版本 `DeepSeek-V4-Pro-0813`：1M 上下文，最大输出 384K，支持 JSON、tool calls、Responses 和 Anthropic API；Responses effort 为 `none / low / high / max`。`deepseek-v4-pro[1m]` 是 Claude Code 写法，不能发给 Responses。（2026-08-13）
- `deepseek-v4-flash`（0731 版本，ID 不变）：1,048,576 上下文，Low / High / Max 默认 High，`xhigh` 按 High 处理。（2026-08-02）
- Responses：base `https://api.deepseek.com`，Codex 配 `wire_api="responses"`；无状态，支持 function tools、web search、`reasoning.effort`，不支持图片和文件，custom tool 只有 apply_patch，没有声明 `reasoning.summary`。Anthropic 兼容入口 `https://api.deepseek.com/anthropic`，effort 字段是 `output_config.effort`。（2026-08-02，真实 Key 跑通 Responses 和 Anthropic thinking）

### Kimi（2026-07-20）

- K3 已进 Kimi Code，支持 low / high / max；Kimi for Coding 渠道的 wire ID 仍是 `kimi-for-coding`，和显式 K3 ID 不同。

### ClinePass（2026-06-30；K3 为 07-20 实测）

- 月费 9.99 美元，2–5 倍 API rate limit，可在 Cline 之外调用。OpenAI 兼容：`POST https://api.cline.bot/api/v1/chat/completions`，`Authorization: Bearer`；模型 ID 为 `cline-pass/*`。
- `/api/v1/models` 不带 Key 返回 401，带 Key 返回 404，没有公开的 models endpoint。`cline-pass/kimi-k3` 真实请求 200，响应 model 为 `moonshotai/kimi-k3`。

### OpenCode Go（2026-06-30；K3 为 07-20 实测）

- 首月 5 美元、之后 10 美元 / 月。同一套餐两种协议：`https://opencode.ai/zen/go/v1/chat/completions`（Bearer）和 `https://opencode.ai/zen/go/v1/messages`（`x-api-key`，传 Bearer 视为缺 Key，不要求 `anthropic-version`）。
- Chat 支持 GLM / Kimi / DeepSeek / MiMo 系列；Messages 支持 MiniMax / Qwen 系列。直调用裸 ID，`opencode-go/` 前缀只用于 OpenCode 配置。
- `/zen/go/v1/models` 不需要 Key，但两种协议的模型混在一起、不标协议（06-30 共 20 个）。

### xAI / Grok（2026-08-15）

- Grok Build OAuth 的 scope 含 `grok-cli:access`、`api:access` 及 conversation / workspace 读写。
- 文本请求和带鉴权的 `/v1/models` 发往 `https://cli-chat-proxy.grok.com`，必须带 `x-grok-client-version`、`X-XAI-Token-Auth: xai-grok-cli`、`x-grok-client-identifier`、`x-authenticateresponse`、`x-grok-client-mode`。
- 推理必须用 `x-grok-model-override` 传实际模型，否则走默认 grok-build 路由。
- 锁定版 `@ai-sdk/xai` 的 effort 只收 none / low / medium / high；`store: false` 固定。`@ai-sdk/xai@4.0.18` 收到 `xhigh` 时在发请求前报 `invalid xai provider options`。（2026-08-14）
- API Key 的 bearer 只发 `https://api.x.ai`。OAuth session bearer 的文本请求走 cli-chat-proxy，Imagine 图片 / 视频请求直接发 `https://api.x.ai/v1/images/*`、`/v1/videos/*`（带 client version 和 identifier，不带 proxy 专用 header）。xAI 没有公开的 OAuth revoke endpoint。
- Imagine：wire 名 `grok-imagine-image-2.0` / `grok-imagine-video-1.5`；视频走 `/videos/generations` 再轮询 `/videos/{id}`；reference 上限 20 MiB。free / X Basic 不能用，SuperGrok 可以；SuperGrok 的周额度在 Chat / Imagine / Voice / Build 之间共享（2026-06 起）。
- Grok Build OAuth：issuer `https://auth.x.ai`，回调 `127.0.0.1` 动态端口，`referrer=grok-build`；设备码 endpoint `https://auth.x.ai/oauth2/device/code`（RFC 8628）。cli-chat-proxy 缺 `x-grok-client-version` 返回 HTTP 426（2026-08-14 复现）。
- `grok-4.6`（2026-08-12 发布）：500K 上下文，文本加图片，推理不能关，默认 High，档位 Low / Medium / High / XHigh。
- 2026-08 起官方仓库和文档的组织主体写成 SpaceXAI，API 品牌和域名仍是 xAI / `x.ai`。

### 千问 / 百炼套餐（2026-07-21；标注处 08-15）

- Coding Plan 的 host 是 `https://coding.dashscope.aliyuncs.com/apps/anthropic`；Token Plan 个人版和团队版共用 `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic`。三者的 key 都是 `sk-sp-` 开头，靠 URL 或 key 都分不出套餐。
- 套餐凭据只允许交互式调用，后台任务不能用。（08-15）
- Coding Plan：Lite 只服务存量用户，Pro 限量售卖，按调用次数计量。Token Plan：按 Credits 计费，额度窗口 5 小时加 7 天；个人版每个实名主体限购一份，团队版按席位。套餐 key 只在创建或重置时完整显示一次。
- 三档的模型列表各不相同（Coding Plan 10 个、个人版 6 个、团队版 15 个），必须按套餐身份维护精确目录，以官方页面为准。
- 官方给 Claude Code 的默认映射：主模型 / Sonnet / Opus 用 `qwen3.8-max-preview`，Haiku 用 `qwen3.6-flash`，Subagent 用 `qwen3.7-max`，最大上下文 983616。`qwen3.8-max-preview` 的 thinking 始终开启，`reasoning_effort` 为 low / high / xhigh 默认 xhigh；temperature 低于 0.6 会被上游改成 0.6。

### OpenRouter / TypeSafe Jev（2026-09-18）

- Jev 是决策模型，只输出 choices / scores / probabilities（`modality: text->decisions`，`has_text_output: false`），不生成文本。
- OpenRouter 的 `~typesafe/jev-latest` 是移动别名（当时指向 `typesafe/jev-1.13`），不要和 TypeSafe 直连 ID `jev-1.13.0` 混用。OpenRouter 的决策调用协议未查到、未实测。
- TypeSafe 直连：`POST https://api.typesafe.ai/v1/systemone`，请求 `model / state / questions`，返回 `answers / usage`；英语效果最好。

### TokenDance（2026-09-05）

- 公开目录 `https://tokendance.space/gateway/v1/models` 不需要 Key，每个模型带 `supported_protocols`。
- 当日快照：精选六款里 Kimi K3 只支持 OpenAI Chat Completions，其余（GLM 5.3、GLM 5.3 Flash、MiniMax M3、DeepSeek V4 Flash / Pro）声明支持 Anthropic Messages。
- 授权是 PKCE S256（verifier 64 字符），回调 `127.0.0.1` 动态端口；备用 code 模式不带 callback_url。
- 非 2xx 响应带 `TokenDance-Recovery-Action`：`top_up_balance` / `reauthorize_api_key` / `api_key_quota`。
- 目录返回 200 不代表 Key 可用，连接测试要发一次小生成。

## Codex / Claude SDK 与 CLI

- Codex API endpoint 是 `https://chatgpt.com/backend-api/codex/responses`；`instructions` 必填，`store: false` 必传。
- Codex Responses 没有服务端执行工具的槽位。`tools[]` 里非 function 的合法 type 只有六个：namespace / tool_search / local_shell / image_generation / web_search / custom。
- Codex 的 `turn/interrupt` 不会打断正在等待本地 `item/tool/call` 的执行。
- app-server `model/list` 默认只返回 picker 里可见的模型（`includeHidden: false`），分页用 `nextCursor`；返回结果取决于 CLI 版本和账号，API 目录里有的模型不一定出现。（2026-09-04）
- Codex CLI 的 effort 兼容：0.133.0 接受 `model_reasoning_effort = "xhigh"`，配 `max` 或乱填只在 stderr 报 unknown variant 并降到 medium；更旧的 Homebrew 版把 `xhigh` 当致命错误以 code 1 退出（2026-06-01）。稳定版 0.144.2 起 `turn/start` 同时接受 `max` 和 `xhigh`，`0.144.2-alpha.*` 不算（2026-08-14）。
- 0.144.2 的 `supportedReasoningEfforts` 元素变成 `{ reasoningEffort, description }`，旧字段名是 `effort`。（2026-07-17）
- 0.145.0-alpha.18 的 schema 已有 approval reviewer（`approvals_reviewer=auto_review`），每个 `turn/start` 可带 `approvalPolicy` 和 `sandboxPolicy`。app-server 只有 `thread/name/set` / `thread/name/updated`，没有自动生成标题的方法。（2026-07-20）
- Codex 文档已从 developers.openai.com/codex/* 308 跳到 learn.chatgpt.com/docs/*。（2026-07-20）
- `@anthropic-ai/claude-agent-sdk@0.2.111`（2026-06-26 源码核验）：内部 `readMessages` 丢弃 `keep_alive`，`query()` 迭代器收不到；CLI 的 keep_alive 只是本地定时心跳，不代表上游有数据。`system/api_retry` 只在请求失败准备重试时才发；上游只是慢时什么都不发，开了 `includePartialMessages` 也要等首 token 才有 `stream_event`。Options 没有空闲超时，只能用 `abortController`。
- Claude Agent SDK 0.2.111 的类型已有 `permissionMode: 'auto'`；不带限定的 `allowedTools` 会在权限模式和回调之前直接批准整组工具。（2026-07-20）
- Claude Agent SDK（版本未记录，2026-03）：只有显式传 effort 才加 `--effort`；`settingSources` 含 `user` 时继承 `~/.claude/settings.json` 的 `alwaysThinkingEnabled`、`effortLevel`、plugins、hooks。Skills 只从文件系统加载（`settingSources` 含 `user` / `project` 才加载对应目录），没有程序注册 Skill 的 API。
- AI SDK：工具 `execute()` 抛错时 `fullStream` 产出 `tool-error` part；tool_call 没有配对 tool_result 时，下一次请求抛 `AI_MissingToolResultsError`。（2026-07-05）`@ai-sdk/anthropic` 没有 key 时在流开始抛 `AI_LoadAPIKeyError`，不发网络请求。（2026-09-21）
- AI SDK v6 的 `Tool.inputSchema` 必须用 `jsonSchema()` / `zodSchema()` / `tool()` 包装，直接类型断言在运行时才报错；没有 execute 的 definition-only tool 是合法的。
- Claude Agent SDK 不会把 in-process MCP 工具结果里的 `image` block 透传给消费者，图片只进模型的视觉通道。
- Claude Agent SDK 的终态要同时看 `is_error` 和 `api_error_status`：`subtype=success` 但 `is_error=true`（实测 403）仍是失败。
- Claude SDK `settingSources=project` 会原生加载项目 `CLAUDE.md`（POC 实证）。Codex 在非 git 目录下是否原生发现 `AGENTS.md` 没有证据。
- Claude native 安装会自动后台更新。官方安装命令：macOS / Linux `curl -fsSL https://claude.ai/install.sh | bash`，Windows `irm https://claude.ai/install.ps1 | iex`。
- Codex 官方安装：`irm https://chatgpt.com/codex/install.ps1 | iex` 或 `npm.cmd install -g @openai/codex`。`install.ps1` 在部分 Windows PowerShell 上报 `OSArchitecture` 属性错误，需回退 npm。（2026-08-07 实测）
- Homebrew cask 过期时 `brew outdated` 可能返回 exit 1 但输出仍是可解析的 JSON。npm registry 的最新版本只对 npm / bun 渠道权威，brew / winget 会滞后数小时到数天。
- Windows 上 npm 全局命令是 `.cmd` shim，不能直接 spawn，要用 `node <包内 bin>`。

## Windows

- Store / 桌面版应用里的 `codex.exe` 位于 `C:\Program Files\WindowsApps\OpenAI.Codex_*\` 下，受 MSIX 包 ACL 管理，第三方进程无权 spawn。macOS `.app` 内的 CLI 是普通可执行文件，可以复用。
- PowerShell 用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 绝对路径；命令走 UTF-16LE 的 `-EncodedCommand`。`spawn` 成功只说明进程创建了，不说明窗口可见。
- 受限令牌下 Git 可能报 dubious ownership；JS 版 `realpath` 逐级 `lstat` 也会被拒，要用 `fs.realpathSync.native`。
- 文件 `fsync` 要用 `r+` 句柄才可靠落盘。
- Claude Code 在 Windows 依赖 Git Bash，缺失时所有命令 exit 1。安装 `winget install Git.Git`，检测 `winget list Anthropic.ClaudeCode`。
- Electron safeStorage：Windows 用 DPAPI，macOS 用 Keychain，Linux 用 keyring 或 `basic_text`；`basic_text` 等同明文，要按降级处理。
- unsigned 安装包可能被 SmartScreen 或企业策略拦截。

## macOS 与 Electron

- 从访达或 Dock 启动的打包应用不继承 shell 的 PATH（不读 `~/.zshrc`），只有 `/usr/bin:/bin` 这类基础路径。（2026-05-31）
- `BrowserWindow.vibrancy` 是窗口级的，DOM 里的 popover / tooltip 做不了单独的毛玻璃。
- Apple Liquid Glass 只用于控件、导航、侧栏、工具栏，不用于内容层。
- Electron 40 在未签名的 dev 环境下，Notification 的 `show` 事件会触发，但通知不进通知中心，只有打包后的应用才能验证送达。
- macOS 上 VPN 通常不设 `HTTP_PROXY`。Node 的全局 `fetch` 不读系统代理，需要用 `session.defaultSession.resolveProxy()` 取 Chromium 的代理结果再注入环境变量。

## IM 平台

- Telegram：Bot API 9.5 有 `sendMessageDraft`（同 draft_id 后写覆盖；返回 400 / 404 表示不支持，要永久降级）；消息上限 4096 字符；只支持有限 HTML 标签；相册靠 `media_group_id` 合并。
- Discord：消息上限 2000 字符；按钮交互必须 3 秒内 deferUpdate；编辑限速约每频道 5 次 / 5 秒。
- 微信（ilink 协议）：发消息的 body 是 `{ msg, base_info }` 且必须带 `context_token`，这是主动回消息的硬前置，要按账号和对端持久化；不返回 message_id；`errcode=-14` 表示会话失效；媒体用 AES-128-ECB；只有私聊纯文本，没有按钮和编辑。
- 飞书：
  - 流式卡片用 CardKit v2。WSClient SDK 不处理卡片事件，要把 `type:"card"` 改成 `"event"`，否则 `card.action.trigger` 报 200340。
  - Schema V2 不支持 action tag（错误 200861），按钮用 column_set + column + button。
  - post 的 md tag 不支持 `<br>`，换行用 `\n\n`。
  - 一键建应用走 `POST accounts.feishu.cn/oauth/v1/app/registration` 设备流，archetype 为 PersonalAgent；Lark 租户换成 `accounts.larksuite.com`。

## Sentry

- 只删 `user` 字段，Relay 仍会按连接补 IP 和地理位置，必须显式写 `user.ip_address: null`。（2026-08-07 生产复核）
- 常驻托盘的应用不会靠干净退出发送 session，需要启动时主动发。（2026-08）
- source map 用 debug ID 匹配，不设 dist（macOS universal 包的架构对不上）。（2026-08）
- 免费 Developer 计划：每个账单周期 5,000 条 error，按订阅日滚动；同组织所有项目共用；事件保留 30 天。只保留历史的项目不耗额度，继续接收才耗；删除已接收事件不退额度。（2026-09-21）
- `error` 类别包含 exception 和 message 事件；只查 `event.type:error` 会漏掉 message。`client_discard`、`network_error`、日志 buffer overflow 不计入已接收 error。fingerprint 合并后每条事件仍各自计额度；`tracesSampleRate: 0` 只关 tracing，不采样 error。（2026-09-21）
- `stats_v2` 是接收量统计，不能和账单逐条对上；Issue 列表的 count 是生命周期累计数。`extras` 里的字段在 Discover 里不能聚合，要聚合得设成 tag。（2026-09）
- 换 DSN 的新包不会让已安装的旧包停止上报，要立刻止住只能在服务端停用旧 key；项目 key 默认 `rateLimit=null`。release 名和内置 DSN 都能被伪造，不能证明发送方身份。（2026-09-21）

## 发版与更新

- GitHub 是 unsigned Windows 更新链的唯一信任根。Immutable Releases 的状态只有管理员能读，Actions token 读不到。
- ruleset 的 `bypass_actors` 字段对没有写权限的调用者是隐藏的，字段缺失不能当成空数组。
- electron-updater 6.8.3 的差分下载任一环节失败会自动回退完整包。`blockMapSize` 只描述嵌入式 blockmap，不适用于外置的 sidecar 文件。
- 没有内置 updater provenance 的旧安装包无法被远端开启自动更新，首个带 updater 的版本必须手动安装。

完整的发版门禁见 [rules/release.md](rules/release.md)。
