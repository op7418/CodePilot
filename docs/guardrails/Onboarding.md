# Onboarding / OAuth Guardrail

> **Status: Active contract** — 覆盖 OpenAI/xAI OAuth 凭据刷新、xAI browser/device 登录、本地回调和 virtual provider 边界。
> **为什么先读**：OAuth 是会自动刷新、轮换且可能被上游撤销的高权限凭据。构造时捕获旧 token、非原子持久化或向自定义 host 注入 bearer，都会造成发送失败或凭据泄漏。

## 词汇表

- `ensureTokenFresh()` / `ensureXaiTokenFresh()` — 每次请求前的刷新闸门；xAI 版本有进程级 single-flight。
- OAuth bundle — access/refresh/expiry/account metadata 的单个原子 JSON setting；不拆成多个可部分写入的 key。
- Virtual provider — 没有 `api_providers` DB 行、由登录状态动态注入 resolver/picker 的 provider。
- Browser PKCE — `S256 + state + nonce` 的浏览器授权码流程；xAI 使用固定 loopback callback。
- Device flow — 设备码授权与轮询；是 loopback 端口占用/浏览器受限时的正式替代路径。
- `cc-switch shadow` — per-request shadow `~/.claude/` 凭据桥。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|---|---|
| 1 | OAuth 凭据必须在每次 fetch 闭包内 await freshness gate，不能在模型构造时同步捕获 | `src/lib/ai-provider.ts` |
| 2 | xAI access/refresh/expiry/account metadata 必须一次原子写成 `xai_oauth_bundle`；写失败即 fail closed | `src/lib/xai-oauth-manager.ts` |
| 3 | 并发过期检查只允许一个 refresh；refresh token 轮换时整包提交，响应缺 refresh token 时保留旧值 | `xai-oauth-manager.ts`, `xai-oauth.ts` |
| 4 | `invalid_grant`/明确撤销清空 bundle；429/5xx/network 等瞬时失败保留旧 bundle 并可重试 | `xai-oauth.ts:XaiOAuthTokenError` + `parseTokenError()` |
| 5 | xAI OAuth bearer 只能发往精确 origin `https://api.x.ai`；必须先验 host 再刷新，拒绝 custom gateway，且不改写 caller Headers | `xai-oauth-manager.ts:createXaiOAuthFetch()` |
| 6 | Browser flow 必须验证 state、ID token 存在且 nonce 匹配；callback 仅监听 `127.0.0.1:56121`，拒绝非可信 Origin，HTML 错误必须 escape | `xai-oauth.ts`, `xai-oauth-manager.ts` |
| 7 | Device flow 必须处理 pending/slow_down/denied/expired/cancel/deadline；关闭 UI 必须同时 cancel server flow 与 polling | manager + `/api/xai-oauth/*` + `ProviderManager.tsx` |
| 8 | xAI API Key 与 OAuth 互不覆盖；本地 logout 只删 xAI bundle。无官方 revoke endpoint 时不宣称已远端撤销 | status route + Settings UI |
| 9 | OAuth status/API/UI 不得返回 access/refresh token，不伪造额度、订阅名称或百分比 | manager/routes/UI |
| 10 | OpenRouter Anthropic-skin 历史 alias 只在 alias 自指时 canonicalize；用户自定义 full slug 永不覆盖 | resolver + models route |
| 11 | packaged server 的 xAI OAuth 授权码交换、device、refresh 与 bearer 请求必须显式消费 Electron 注入的 HTTP(S) proxy env，并遵循 `NO_PROXY`；不得靠全局 fetch 自动代理或改写全局 dispatcher | `env-proxy-fetch.ts` + `xai-oauth.ts` + manager |

## 关键文件 + 责任

| 文件 | 责任 |
|---|---|
| `src/lib/xai-oauth.ts` | PKCE/device protocol、JWT expiry/nonce、token exchange/refresh 与错误分类 |
| `src/lib/xai-oauth-manager.ts` | 原子持久化、single-flight、loopback server、fresh bearer fetch、virtual status |
| `src/lib/env-proxy-fetch.ts` | 为 xAI 外部请求显式选择 HTTP(S) env proxy dispatcher；`NO_PROXY`/相对 URL/非支持协议保持 direct |
| `src/app/api/xai-oauth/start/route.ts` | browser/device flow 启动，不返回 token |
| `src/app/api/xai-oauth/status/route.ts` | 脱敏状态与本地 logout |
| `src/app/api/xai-oauth/cancel/route.ts` | 取消未完成流程 |
| `src/lib/ai-provider.ts` | OpenAI/xAI Responses 的 fresh-token fetch 闭包 |
| `src/lib/provider-resolver.ts` | `openai-oauth` / `xai-oauth` virtual resolution |
| `src/components/settings/ProviderManager.tsx` | 双登录方式、轮询/取消、账号管理与风险/兜底文案 |

## 改动检查表

- [ ] OAuth fetch 在闭包内拿 fresh token；没有把旧 token 捕获进 model instance
- [ ] 新增/改动持久化仍是一笔完整 bundle 写入，并覆盖 write-failure 测试
- [ ] 所有 bearer 注入先验证精确 scheme/host/port，再做 refresh 或网络请求
- [ ] browser flow 仍校验 state + nonce；callback 只绑定 loopback，错误页面经过 HTML escape
- [ ] device polling 正确应用 server interval 与 `slow_down + 5s`，并有 cancel/deadline
- [ ] status/UI/日志没有 token、假额度、假套餐；logout 文案没有承诺远端 revoke
- [ ] API Key 与 OAuth 同时配置时 resolver/picker 能明确区分 provider id 与 billing source
- [ ] packaged/server OAuth 请求在 HTTP(S) system proxy 下走代理，`NO_PROXY` 仍可显式直连；不得把 proxy URL/认证信息写入错误或日志
- [ ] 修改 loopback/打开浏览器行为后，按 `ElectronMain.md` 做 packaged macOS/Windows 验证

## 常见坑

- 在构造时调用同步 credentials getter：refresh 后实例继续发旧 bearer，稳定 401。
- 把 access/refresh/expiry 拆成多个 setting：进程退出或第二个写失败会留下不可恢复的半状态。
- 先 refresh 再检查请求 URL：恶意 custom URL 虽最终被拒绝，仍能触发不必要的凭据操作；host gate 必须最先发生。
- 复用传入的 `Headers` 再 set authorization：会修改 caller 对象并让 token 泄漏到后续请求；必须 clone/merge。
- callback handler 内 await `server.close()`：当前请求尚未结束会形成关闭死锁；先 end response，再异步 close。
- 把公开 Grok CLI client 描述成 CodePilot 与 xAI 的官方合作，或把本地 logout 描述成远端撤销。
- 固定端口被占用时静默换端口：registered redirect 不匹配；应明确报错并引导 device-code。

## 测试覆盖

| 契约 | 测试文件 |
|---|---|
| xAI PKCE、nonce、refresh rotation、错误分类、device flow | `src/__tests__/unit/xai-oauth.test.ts` |
| HTTP(S) proxy 选择、`NO_PROXY`、dispatcher 缓存与真实 CONNECT tunnel | `src/__tests__/unit/env-proxy-fetch.test.ts` |
| 原子持久化、single-flight、host/header 防泄漏、loopback/CORS、virtual provider | `src/__tests__/unit/xai-oauth-manager.test.ts` |
| 双渠道 UI、disabled fallback、无假额度、关闭取消 | `src/__tests__/unit/xai-oauth-ui.test.ts` |
| xAI Responses 与 provider options | `src/__tests__/unit/xai-provider.test.ts`, `provider-request-shape.test.ts` |
| OpenAI OAuth fresh fetch | `src/__tests__/unit/openai-oauth-fetch-refresh.test.ts` |
| Provider resolver routing | `src/__tests__/unit/provider-resolver.test.ts` |

## 设计决策日志

- 2026-05-18 — OpenAI OAuth freshness gate 移到 fetch 闭包，避免模型实例捕获 stale token。
- 2026-07-21 — xAI OAuth 使用公开 Grok CLI public client 的 browser PKCE + device flow；UI 明示兼容风险，API Key 保留为稳定兜底。
- 2026-07-21 — xAI token metadata 使用单个 JSON setting 原子提交；refresh 进程级 single-flight，瞬时错误不清凭据。
- 2026-07-21 — OAuth fetch 只允许官方 `https://api.x.ai`，host gate 在 refresh 前；无官方 revoke 能力时 logout 仅做本地清除。
- 2026-07-22 — v0.59.0 packaged 真实反馈确认系统浏览器走代理、Node token exchange 默认直连会分流；xAI OAuth 全生命周期改为 opt-in env proxy fetch，不全局改写其他 Provider/loopback。
