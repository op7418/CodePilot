# Onboarding / OAuth Guardrail

> **Status: Active contract** — 覆盖 OpenAI/xAI OAuth 凭据刷新、xAI browser/device 登录、本地回调和 virtual provider 边界。
> **为什么先读**：OAuth 是会自动刷新、轮换且可能被上游撤销的高权限凭据。构造时捕获旧 token、非原子持久化或向自定义 host 注入 bearer，都会造成发送失败或凭据泄漏。

## 词汇表

- `ensureTokenFresh()` / `ensureXaiTokenFresh()` — 每次请求前的刷新闸门；OpenAI/xAI 均有进程级 single-flight。
- OAuth 原子保存 — xAI 使用单个 JSON setting；OpenAI 保留 legacy keys 的读取兼容性，但 access/refresh/expiry/account metadata 必须在同一 SQLite transaction 内提交。
- Virtual provider — 没有 `api_providers` DB 行、由登录状态动态注入 resolver/picker 的 provider。
- Browser PKCE — `S256 + state + nonce` 的浏览器授权码流程；Grok Build 生产合同使用 OS 分配的动态 loopback callback 端口。
- Device flow — 设备码授权与轮询；是浏览器/loopback 受限环境的正式替代路径。
- `cc-switch shadow` — per-request shadow `~/.claude/` 凭据桥。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|---|---|
| 1 | OAuth 凭据必须在每次 fetch 闭包内 await freshness gate，不能在模型构造时同步捕获 | `src/lib/ai-provider.ts` |
| 2 | xAI access/refresh/expiry/account metadata 必须一次原子写成 `xai_oauth_bundle`；写失败即 fail closed | `src/lib/xai-oauth-manager.ts` |
| 3 | 并发过期检查只允许一个 refresh；refresh token 轮换时整包提交，响应缺 refresh token 时保留旧值 | `xai-oauth-manager.ts`, `xai-oauth.ts` |
| 4 | `invalid_grant`/明确撤销清空 bundle；429/5xx/network 等瞬时失败保留旧 bundle 并可重试 | `xai-oauth.ts:XaiOAuthTokenError` + `parseTokenError()` |
| 5 | Grok Build 的**文本推理与模型目录** OAuth bearer 只能发往精确 origin `https://cli-chat-proxy.grok.com`；推理请求必须按有 provenance 的上游兼容版本发送 `x-grok-client-version`、`X-XAI-Token-Auth: xai-grok-cli`、`x-grok-client-identifier`、`x-authenticateresponse`、`x-grok-client-mode`，并用 `x-grok-model-override` 承载用户实际选择的模型。必须先验 host/route 再刷新，且不改写 caller Headers | `xai-oauth-manager.ts:createXaiOAuthFetch()` |
| 6 | Browser flow 必须验证 state、ID token 存在且 nonce 匹配；callback 只绑定 `127.0.0.1` 的 OS 动态端口，授权与换 token 必须使用同一 redirect URI；拒绝非可信 Origin，HTML 错误必须 escape | `xai-oauth.ts`, `xai-oauth-manager.ts` |
| 7 | Device flow 必须处理 pending/slow_down/denied/expired/cancel/deadline；关闭 UI 必须同时 cancel server flow 与 polling | manager + `/api/xai-oauth/*` + `ProviderManager.tsx` |
| 8 | xAI API Key 与 OAuth 互不覆盖；本地 logout 只删 xAI bundle。无官方 revoke endpoint 时不宣称已远端撤销 | status route + Settings UI |
| 9 | OAuth status/API/UI 不得返回 access/refresh token，不伪造额度、订阅名称或百分比 | manager/routes/UI |
| 10 | OpenRouter Anthropic-skin 历史 alias 只在 alias 自指时 canonicalize；用户自定义 full slug 永不覆盖 | resolver + models route |
| 11 | packaged server 的 xAI OAuth 授权码交换、device、refresh 与 bearer 请求必须显式消费 Electron 注入的 HTTP(S) proxy env，并遵循 `NO_PROXY`；不得靠全局 fetch 自动代理或改写全局 dispatcher | `env-proxy-fetch.ts` + `xai-oauth.ts` + manager |
| 12 | Grok Build Imagine 的 OAuth bearer 按上游合同直接发往 `https://api.x.ai`，但必须由独立、purpose-specific fetch wrapper 限定到图片/视频生成与视频轮询的精确路径；每次请求取 fresh token，带版本/identifier，不携带 proxy-only headers。不得为复用文本 fetch 而放宽整个 `api.x.ai` host gate | `xai-oauth-manager.ts:createXaiOAuthMediaFetch()` + `xai-imagine.ts` |
| 13 | Imagine 的调用方取消必须从 Native、Claude MCP、Codex bridge 与确认 API 四个入口传到生成/轮询/下载 transport。取消发生在轮询或下载完成前时必须停止后续请求且不新增 Gallery 行；若上游已完成且下载字节已经返回，则保留并登记可能已计费的资产，不在落盘前二次丢弃。该本地取消不承诺上游撤销或退款 | `builtin-tools/media.ts` + `image-gen-mcp.ts` + `codex/proxy/builtin-bridge.ts` + `/api/media/generate` + `xai-imagine.ts` |

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
- [ ] Grok Build browser/device scope 保持官方集合（含 conversation/workspace read/write）；文本推理和 `/v1/models` 订阅 bearer 只去 Build proxy，Imagine bearer 只经独立 wrapper 去公共 API 的精确媒体路径
- [ ] Build proxy 的 version/token-auth/identifier/authenticate-response/client-mode headers 与有 provenance 的上游兼容版本一致；推理还必须发送与用户选择一致的 `x-grok-model-override`。缺少任一项不得把真实 OAuth smoke 标为通过
- [ ] OAuth 模型目录从 Build proxy 的 authenticated `/v1/models` 获取；解析、缓存或 entitlement 不确定时 fail closed，不把静态 fallback 冒充账号实际目录
- [ ] Imagine 图片/视频请求只允许精确媒体 endpoint，使用 fresh OAuth bearer + version/identifier，不携带 proxy-only headers；禁止通过放宽通用 OAuth host gate 实现
- [ ] 四个媒体入口都转发调用方 AbortSignal；行为测试同时覆盖取消后轮询冻结/不落库/无 listener 残留，以及完成下载后保留资产的反例。不得把本地 Stop 描述成上游撤销、退款或“任何时点都不落盘”
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
- 把公开 Grok Build client 描述成 CodePilot 与 xAI 的官方合作，或把本地 logout 描述成远端撤销。
- 授权 URL 使用一个动态端口、token exchange 却重建另一个 redirect URI：会触发 redirect mismatch；redirect 必须随 pending flow 保存并原样复用。
- 只补 `x-grok-client-version` 而漏掉 authenticate-response/client-mode：官方 Grok Build 的生产 proxy 请求会同时注入整组客户端识别 headers，单头通过 mock 不代表真实合同闭合。
- 漏发 `x-grok-model-override`：proxy 会按默认 `grok-build` 路由，UI 选择 `grok-4.6` 不能证明实际调用了 4.6，属于用户可见语义失真。
- 为接 Imagine 直接允许 OAuth fetch 访问所有 `api.x.ai` 路径：会把高权限订阅 bearer 暴露给不在媒体合同内的调用；文本 proxy 与媒体 API 必须分成两个精确 allowlist wrapper。
- 在下载字节已完整返回后再次检查 abort 并丢弃结果：远端生成可能已经完成并计费，这会让用户同时失去资产和费用。取消只阻止尚未完成的本地轮询/下载；完成结果必须保留并诚实说明无法保证远端撤销。

## 测试覆盖

| 契约 | 测试文件 |
|---|---|
| xAI PKCE、nonce、refresh rotation、错误分类、device flow | `src/__tests__/unit/xai-oauth.test.ts` |
| HTTP(S) proxy 选择、`NO_PROXY`、dispatcher 缓存与真实 CONNECT tunnel | `src/__tests__/unit/env-proxy-fetch.test.ts` |
| 原子持久化、single-flight、host/header 防泄漏、loopback/CORS、virtual provider | `src/__tests__/unit/xai-oauth-manager.test.ts` |
| 双渠道 UI、disabled fallback、无假额度、关闭取消 | `src/__tests__/unit/xai-oauth-ui.test.ts` |
| xAI Responses 与 provider options | `src/__tests__/unit/xai-provider.test.ts`, `provider-request-shape.test.ts` |
| Imagine wire、下载边界与取消行为 | `src/__tests__/unit/xai-imagine.test.ts`（轮询冻结、取消不落库、listener 清理、完成下载后保留资产） |
| OpenAI OAuth fresh fetch | `src/__tests__/unit/openai-oauth-fetch-refresh.test.ts` |
| Provider resolver routing | `src/__tests__/unit/provider-resolver.test.ts` |

## 设计决策日志

- 2026-05-18 — OpenAI OAuth freshness gate 移到 fetch 闭包，避免模型实例捕获 stale token。
- 2026-07-21 — xAI OAuth 使用公开 Grok CLI public client 的 browser PKCE + device flow；UI 明示兼容风险，API Key 保留为稳定兜底。
- 2026-07-21 — xAI token metadata 使用单个 JSON setting 原子提交；refresh 进程级 single-flight，瞬时错误不清凭据。
- 2026-07-21 — 历史首版 OAuth fetch 只允许 `https://api.x.ai`；该 inference host 已由 2026-08-13 Grok Build 合同刷新取代。host gate 在 refresh 前、logout 仅做本地清除两条仍有效。
- 2026-07-22 — v0.59.0 packaged 真实反馈确认系统浏览器走代理、Node token exchange 默认直连会分流；xAI OAuth 全生命周期改为 opt-in env proxy fetch，不全局改写其他 Provider/loopback。
- 2026-08-13 — 按 xAI 开源 Grok Build 当前源码升级合同：生产 callback 改为动态 loopback 端口，补 conversation/workspace scopes，`referrer=grok-build`，订阅 token 从公共 API host 改走 `cli-chat-proxy.grok.com` 并附专用 token-auth header；API Key 路径保持独立。
- 2026-08-14 — 独立复核上游 Grok Build commit `e5fd4816…`：proxy 有客户端版本门禁，production 请求同时注入 version、token-auth、identifier、authenticate-response 与 client-mode。用户真实请求随后以 HTTP 426 证实 version `(none)` 会被拒绝；实现已补完整推理 header、精确 `/v1/responses` route gate 与 model override，并用真实 AI SDK wire 测试锁定。2026-08-15 已补 authorize URL 与 token exchange 动态 `redirect_uri` 严格等值断言；真实凭据重试仍待完成。
- 2026-08-14 — 同一上游复核确认：session auth 的文本目录来自 Build proxy authenticated `/v1/models`，文本推理靠 `x-grok-model-override` 路由实际模型；Imagine 图片/视频工具则用 fresh OAuth bearer 直连 `api.x.ai` 的媒体 endpoint。三者必须分别做窄路由与凭据 smoke，不能继续用“OAuth bearer 永不去公共 API”的旧概括。
- 2026-08-14 — Imagine client 已落地为独立媒体 fetch：精确允许 image generation/edit、video generation/poll，401 强制 refresh 后最多重试一次；文本 proxy headers 被剥离。视频下载只接受受控 xAI CDN、限定媒体类型与 250 MiB 流式上限，产物以有 provenance 的 `MediaBlock` 进入 Gallery。自动化合同通过不替代真实订阅 entitlement/计费 smoke。
- 2026-08-15 — Imagine 取消合同补齐四入口和行为测试：轮询/下载未完成时 Stop 冻结后续请求且不落库；下载字节已完成返回时保留并登记资产，避免丢失可能已计费的结果。本地 AbortSignal 不冒充上游撤销或退款。


## 2026-09-05 OpenAI / Astra 修复合同

- `ensureTokenFresh` 并发只执行一次 refresh；只有 generation 与原 refresh token 都仍匹配才回写或清空。logout、取消/替换登录让旧请求失效，HMR 不重置 generation。新登录清旧 metadata 和写新凭据也在一笔事务内完成。
- 明确 invalid_grant/revoked/reused/expired/invalidated 才清凭据；网络、429/5xx、未知 4xx 保留登录并报可重试错误；刷新 10 秒超时，绝不将过期 bearer 当成功使用。
- ID token 缺账号 ID 时可从 access token 补取；compute residency 来自 access token 的真实 claim。bearer/residency 仅进入精确 ChatGPT Codex endpoint，redirect:error，禁止自定义 host 和非 Responses SDK 路径。
- `openai-oauth-models.ts` 用独立 OAuth 凭据发现模型，不读 app-server 的账号目录。缓存绑定 generation；真实空目录不被 fallback 补回。失败沿用同账号旧目录或 bundled 兼容候选，不能将候选说成生成 entitlement 已验证。
- Native 和 Codex provider proxy 共用 `buildOpenAIOAuthOptions`，按模型声明发送所选 effort 与 `forceReasoning`；未知能力不强开，unsupported effort 明确拒绝，不能静默改 medium。`ultra` 不进入通用菜单。
- 回归：`openai-oauth-compatibility.test.ts` 覆盖并发、临时/永久失败、logout 竞态、DB 半写回滚、同账号目录、真实 SDK 与生产 Native max/headers；Codex 分页/窗口见 `codex-models-dual-schema.test.ts`。本轮真实 OAuth entitlement smoke 未执行（本机独立 OAuth 未登录）。

- 2026-09-05 独立审查后续：全局模型 GET 不 await OAuth 网络发现，返回同账号缓存及 pending 事实；Composer 仅在 pending 时后台轮询（20 秒上限、unmount/新请求取消），不重置已加载目录。缺失/未知 visibility 是失败而不是真空目录，不能默认可见或覆盖上次有效目录。effort 失效必须明确引导重新选择，不能静默降档；空目录不能生成空默认模型。错误标记经两个 live SSE 入口和持久化消息渲染统一本地化。Codex proxy 的本地参数拒绝必须返回结构化 invalid_request。回归：openai-oauth-compatibility、fable51-review-followup E2E。
