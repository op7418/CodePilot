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
- 已知坑：智谱高峰期 3 倍计费；Kimi 必须关 tool_search；小米 MiMo 不支持 Thinking；火山需先激活 endpoint。（2026-04）
- 计费模式：订阅制（火山 / 百炼 / MiMo / GLM 积分 / MiniMax）；按量（Anthropic / OpenRouter / Bedrock / Vertex / Kimi / Gemini）；自托管（Ollama / LiteLLM）。
- Gemini 走 Google AI Studio 而非 Vertex：Vertex 需要 GCP OAuth，门槛高。

### xAI / Grok（2026-08-15）

- Grok Build OAuth 的 scope 含 `grok-cli:access`、`api:access` 及 conversation / workspace 读写。
- 文本请求和带鉴权的 `/v1/models` 发往 `https://cli-chat-proxy.grok.com`，必须带 `x-grok-client-version`、`X-XAI-Token-Auth: xai-grok-cli`、`x-grok-client-identifier`、`x-authenticateresponse`、`x-grok-client-mode`。
- 推理必须用 `x-grok-model-override` 传实际模型，否则走默认 grok-build 路由。
- 锁定版 `@ai-sdk/xai` 的 effort 只收 none / low / medium / high；`store: false` 固定。
- API Key 的 bearer 只发 `https://api.x.ai`；xAI 没有公开的 OAuth revoke endpoint。
- Imagine：wire 名 `grok-imagine-image-2.0` / `grok-imagine-video-1.5`；视频走 `/videos/generations` 再轮询 `/videos/{id}`；reference 上限 20 MiB。

### 千问（2026-08-15）

- Coding Plan、Token Plan Personal、Token Plan Team 共享 endpoint。套餐凭据只允许交互式调用，后台任务不能用。

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

## Sentry（2026-08）

- 只删 `user` 字段，Relay 仍会按连接补 IP 和地理位置，必须显式写 `user.ip_address: null`。（2026-08-07 生产复核）
- 常驻托盘的应用不会靠干净退出发送 session，需要启动时主动发。
- source map 用 debug ID 匹配，不设 dist（macOS universal 包的架构对不上）。

## 发版与更新

- GitHub 是 unsigned Windows 更新链的唯一信任根。Immutable Releases 的状态只有管理员能读，Actions token 读不到。
- ruleset 的 `bypass_actors` 字段对没有写权限的调用者是隐藏的，字段缺失不能当成空数组。
- electron-updater 6.8.3 的差分下载任一环节失败会自动回退完整包。`blockMapSize` 只描述嵌入式 blockmap，不适用于外置的 sidecar 文件。
- 没有内置 updater provenance 的旧安装包无法被远端开启自动更新，首个带 updater 的版本必须手动安装。

完整的发版门禁见 [rules/release.md](rules/release.md)。
