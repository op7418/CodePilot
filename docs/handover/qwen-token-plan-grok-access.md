# 千问 Token Plan 与 xAI Grok 接入交接

> 产品思考见 [docs/insights/qwen-token-plan-grok-access.md](../insights/qwen-token-plan-grok-access.md)
> 执行计划见 [docs/exec-plans/active/qwen-token-plan-and-grok-access.md](../exec-plans/active/qwen-token-plan-and-grok-access.md)

## 交付边界

本轮新增三类千问套餐 identity，以及两条互相独立的 xAI 渠道：

- 阿里云百炼 Coding Plan、Qwen Token Plan Personal、Qwen Token Plan Team。
- xAI 官方 API Key，通过 `@ai-sdk/xai` Responses 调用 `grok-4.5`。
- SuperGrok-compatible OAuth，支持浏览器 PKCE 和 RFC 8628 device flow。

xAI 首版只在 CodePilot Runtime 与 Codex Runtime 暴露。OAuth 复用公开 Grok CLI client，不代表 CodePilot 与 xAI 存在官方合作。

## 套餐 identity

`api_providers.preset_key` 是套餐身份真源。个人版和团队版共享 endpoint，不能再用 URL、数组顺序或 hostname 猜套餐。

身份解析统一经过 `resolveProviderPresetIdentity()`：

1. 显式 `preset_key`。
2. 可证明的 legacy fingerprint。
3. 唯一 endpoint/protocol 匹配。
4. 多候选时返回 ambiguous，要求用户选择。

Provider CRUD、模型目录、Doctor、Runtime picker、请求 resolver 和迁移都消费同一结果。普通编辑只采纳身份；只有 UI 显式发送 `reconcile_catalog: true` 才会按当前 catalog 整理系统管理的模型。

## DB 与迁移

- `src/lib/db.ts` 为 `api_providers` 增加 nullable `preset_key`。
- additive migration 只回填可证明的旧记录，并保持幂等。
- managed identity 与 endpoint/protocol 不一致时拒绝保存，防止改 URL 绕过套餐策略。
- 用户手动启用、隐藏或补充的模型继续由 `enable_source` / `user_edited` 保护。

## 调用策略

千问三套餐标记为 `interactive_only`。所有持有凭据的生成入口必须传入封闭联合 `callScene`，并在创建模型或发起 fetch 前调用统一策略 gate。

允许当前用户回合、工具续轮和同会话压缩；自动标题、定时任务、heartbeat、后台记忆、自动建议等隐藏调用 fail closed 或走无套餐凭据的确定性 fallback。新增 LLM 调用点时，不能用自由字符串或默认值绕过场景枚举。

## xAI API Key 路径

- Catalog identity：`xai-api`。
- 模型：`grok-4.5`。
- SDK：`@ai-sdk/xai` 的 Responses model。
- 请求选项：xAI effort 放入 `providerOptions.xai`，并固定 `store: false`。
- 发送 bearer 前校验官方 `https://api.x.ai` origin；自定义 gateway 不得接收 xAI 凭据。

## xAI OAuth 路径

核心文件：

- `src/lib/xai-oauth.ts`：PKCE、token exchange、refresh、device protocol 与错误分类。
- `src/lib/xai-oauth-manager.ts`：callback server、原子 bundle、refresh single-flight、取消和状态。
- `src/lib/env-proxy-fetch.ts`：让 packaged server 的 xAI 外部请求显式遵循 Electron 注入的 HTTP(S) system proxy 与 `NO_PROXY`。
- `src/app/api/xai-oauth/*`：start/status/cancel 路由。
- `src/components/settings/ProviderManager.tsx`：登录方式选择、轮询、注销和状态 UI。

浏览器流固定监听 `127.0.0.1:56121/callback`，校验 state、nonce 与 PKCE。允许的 `auth.x.ai` / `accounts.x.ai` origin 在 OPTIONS 和 GET callback 上获得一致 CORS/PNA 响应；其他 origin fail closed。设备流尊重服务端 interval、`slow_down` 和 `expires_in`。

取消语义有多层保护：sleep 可中断、fetch 接收 signal、响应后复查、持久化边界再次 fail closed。浏览器 token exchange 和设备轮询都不能在取消后写入迟到 token。

OAuth token bundle 以单个 JSON setting 原子写入；并发 refresh 合并为 single-flight，rotation 后同时替换 access/refresh pair。只有明确的 `invalid_grant` 等永久错误清除凭据；网络、429、5xx 保留旧 bundle。

浏览器授权页由系统浏览器打开，会自然使用系统代理；Node/Next 的全局 `fetch` 默认不会仅因存在 `HTTP_PROXY/HTTPS_PROXY` 就使用代理。xAI 的 code exchange、device、refresh 与后续 bearer 请求因此统一走局部 `envProxyFetch`：HTTP(S) proxy 使用 Undici `ProxyAgent`，`NO_PROXY`、相对 URL 与非支持代理协议保持 direct。该 dispatcher 不设为全局，避免本地 callback 或其他 Provider 被意外代理。网络错误只附加稳定的 socket/DNS/TLS code，不记录 proxy URL、认证信息或 token。

## Runtime 数据流

- CodePilot Runtime：resolver 选择 xAI API/OAuth → `@ai-sdk/xai` Responses → native agent loop。
- Codex Runtime：virtual provider 进入 provider proxy → adapter 注入 xAI options 和 OAuth fetch override → Responses 上游。
- Claude Code Runtime：xAI 不暴露；千问套餐按各自 Anthropic-compatible 目录和角色映射暴露。

## 安全与日志

- API/status/错误响应不得返回 access token、refresh token、auth code 或 device code。
- caller headers 先 clone，再只替换 Authorization；不得原地修改或转发到非官方 origin。
- logout 清理本地 xAI OAuth bundle。xAI 未公开 OAuth revoke endpoint，账户端撤销仍通过 `accounts.x.ai` 手动完成。
- 本轮沿用现有 settings 存储边界，尚未迁移 OS keyring；统一凭据加密由 tech-debt #40 跟踪。

## 验证与剩余风险

关键回归文件包括 `provider-preset-identity-migration.test.ts`、`provider-call-policy.test.ts`、`qwen-token-plan-catalog.test.ts`、`xai-provider.test.ts`、`xai-oauth.test.ts`、`xai-oauth-manager.test.ts`、`env-proxy-fetch.test.ts` 和 `xai-oauth-ui.test.ts`。

用户已在 Electron dev 验证 xAI browser OAuth 与 Qwen Personal 可在 CodePilot/Codex Runtime 连接并回复。device、refresh/tool/logout、Qwen Team/Coding Plan 真实凭据，以及 packaged macOS/Windows OAuth 仍记录在执行计划 Smoke Ledger，不得从 mock 或单一路径推断为已验证。
