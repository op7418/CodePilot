# TokenDance 接入

> 产品思考见 [docs/insights/tokendance-integration.md](../insights/tokendance-integration.md)。
> 执行与验证记录：[TokenDance 计划](../exec-plans/active/tokendance-integration.md)。

## 入口与数据流

Settings → Providers → 添加服务只有一个 TokenDance 入口。`tokendance` 连接在 Native/Codex 使用 OpenAI Chat Completions，在 Claude Code 使用 Anthropic Messages；已有连接的 ID、Key、base URL 与持久化 protocol 不变。旧 `tokendance-anthropic` preset 保留供历史连接编辑/重授权，不再出现在添加菜单。预设不静态写入模型，添加后使用保守 discovery/apply；默认只启用 GLM 5.3、Kimi K3、MiniMax M3、DeepSeek V4 Flash、DeepSeek V4 Pro、GLM 5.3 Flash。其余发现项隐藏，用户仍可手动启用。公开目录仅证明协议声明，不证明账号 entitlement、工具能力或生成成功。仅排除未声明该连接聊天协议的模型；声明 Chat Completions 的 TTS 模型也会被发现，但因不在六款精选中默认隐藏。协议声明不等于通用聊天能力，用户手动启用时仍需核实用途。

`tokendance.ts` 是可供客户端导入的固定 URL、协议筛选和恢复标记。`model-discovery.ts` 从公开 `/gateway/v1/models` 读取，不携带用户 Key，以 `supported_protocols` 过滤。缺失协议字段属于 schema 错误，不能当成合法空目录。`catalog-recommend.ts` 以六个精确上游 ID 决定默认启用，不依赖 Claude 命名。刷新会将系统管理行收敛到精选集合。现有用户编辑/隐藏保护不变；不修改默认模型或旧聊天。

`tokendance-fetch.ts` 仅允许精确 HTTPS origin 的 models/chat-completions/messages/count_tokens 路径，禁止重定向，使用现有系统代理 fetch，覆盖任意大小写 `X-App-URL` 为 `https://www.codepilot.sh/`。Native 与 Codex 的真实 AI SDK/compat transport 共用包装。Claude Code 子进程使用 `ANTHROPIC_AUTH_TOKEN`、清空 `ANTHROPIC_API_KEY` 并关闭非必要流量；未显式映射的 Sonnet/Opus/Haiku 与 small helper 在本轮 env 中回退到已选模型，避免调用内置 Claude ID，显式角色配置保持优先，base URL 指向本机 `/api/tokendance/gateway`，仅转发 Messages/count_tokens 到固定上游；请求认证来自子进程，路由不读取其他服务商 Key。成功 SSE 字节直接转发，恢复错误统一后进入现有分类/本地化路径。

Runtime 兼容性由 `getModelCompat` 统一计算，所有 DB Provider 调用方传入实际 base URL。仅精确官方地址使用 `tokendance.ts` 中 2026-09-05 官方 `supported_protocols` 快照；模型按 upstream ID 匹配，未知模型不宣称支持 Claude Code。精选六款中 Kimi K3 只声明 OpenAI Chat Completions，其余五款声明 Anthropic Messages。选择器、路由验证、resolver 和子 Agent 使用同一规则。后续新增 Anthropic 模型需更新有来源的快照；当前不会随目录刷新自动增加 Claude 能力。

连接测试不能把公开目录的 HTTP 200 当成有效 Key：先取该协议的真实模型 ID，再发 `max_tokens:32` 的小生成请求（可能产生少量用量），仅成功响应显示连接成功。

## 授权与凭据

`tokendance-auth.ts` 实现进程级单个 pending flow（HMR 保留），S256 verifier 64 字符。浏览器回调监听 OS 分配的 `127.0.0.1` 端口，随机 state 放进 callback_url query；验证 method/path/state/Origin/flow ownership 后兑换。备用 code 模式不携带 callback_url，用户将 TokenDance 页面给出的一次性 code 粘回 CodePilot。两种方式固定携带 App URL 与 `key_name=Codepilot`。

`POST /api/tokendance/auth` 接受 start/complete/cancel；`GET ?flowId=…` 仅返回 status/expiresAt/providerId。前端显式点击官方链接，在页面确认额度/有效期后完成。关闭、取消、重启授权或 10 分钟到期使旧结果失效。兑换 20 秒超时、禁止重定向、不自动重试；不回显上游错误正文、Key、code、verifier。远端已创建但本地未保存的 Key 需用户去 TokenDance 检查并删除，不能声称本地取消已远端撤销。

Key 通过 `createProvider` / `updateProvider` 走现有 AES-GCM Provider secret 存储，没有新 schema、access token、refresh token 或明文 setting。重授权验证原连接仍存在、identity 与旧 Key 未变化，仅替换原行 Key，保留 provider ID、模型配置和会话。授权 pending 时禁止并行手动保存，避免创建两份连接。

## 失败恢复

只在非 2xx 响应按 `TokenDance-Recovery-Action` 处理：

| 上游值 | 用户动作 | 本地凭据 |
|---|---|---|
| `top_up_balance` | 到 TokenDance 充值后重试 | 保留，仍有效 |
| `reauthorize_api_key` | 编辑原连接重新授权或替换 Key | 不自动删除 |
| `api_key_quota` | 等待周期重置，或编辑原连接授权新 Key | 保留 |
| 缺失/未知 | 沿用标准协议错误 | 保留 |

稳定标记经过 Native/Codex/Claude 错误路径，三处现有 SSE/持久化消息渲染统一映射中英文。Claude 错误分类必须保留具体恢复动作，不能退化成泛泛的“鉴权失败”。不自动创建支付订单、不默认充值金额。

## 验证与边界

定向单测覆盖目录协议/漂移、exact-host/redirect/归因、真实 AI SDK 与 Codex proxy wire、Claude SSE 转发、恢复分类、本地 PKCE 回调、加密落盘、取消竞态和原连接重授权。隔离 Dev E2E 覆盖设置入口、真实本地授权 start/status/cancel、授权链接参数和手动 Key 保存，单一添加入口、非空发现后真实 model feed 和同一连接在三个 Runtime 的选择器均有覆盖，Kimi K3 在 Claude Code 不可选。

用户已确认真实 TokenDance 授权成功；开发侧未执行真实账号生成、计费、工具调用和 packaged macOS/Windows smoke。公开模型目录成功读取不是这些 smoke 的替代。产品方分润价目 API 需要专用产品方 Key，当前未提供，因此未查询或展示分润价格。媒体/语音/支付与原生 Responses 特性属于后续产品范围，当前 Codex 沿用现有代理转换。

## 来源

- [AI 接入](https://tokendance.space/docs/ai-integration.md)
- [应用归因](https://tokendance.space/docs/app-attribution.md)
- [授权与恢复](https://tokendance.space/docs/api-key-oauth.md)
- [协议总览](https://tokendance.space/docs/multi-protocol.md)
- [Claude Code 接入](https://tokendance.space/docs/claude-code.md)
- [实时模型目录](https://tokendance.space/gateway/v1/models)

Claude 审查收尾：Provider 标签说明多协议与模型差异；Models 按模型 tier 筛选，Kimi K3 不因 Provider 整体支持 Claude 被归入 Claude 组；Codex parity 按连接实际协议显示 OpenAI/Anthropic adapter。不可用 reason 进入字典，models feed 按当前 locale 返回。协议快照后续工作见 [技术债 #91](../exec-plans/tech-debt-tracker.md)。

本次 Claude 审查收尾验证：18 项定向、3 项隔离 E2E、全量 5542 pass / 1 skip；详细日志和未验证范围见执行计划。新增收尾尚未独立复审，未提交。

品牌图标：`public/provider-icons/tokendance.svg` 保存官网原始 SVG（来源见同目录 README），由共享 ProviderBrandIcon 渲染；preset 与名称/精确网关 URL 解析均指向 `tokendance`，添加菜单、已连接服务与 Composer 共用。
