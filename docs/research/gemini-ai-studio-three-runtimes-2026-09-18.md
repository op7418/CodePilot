# Gemini 3.8 Flash：AI Studio 接入三个 Runtime 的可行性

日期：2026-09-18。范围：调研、源码核验、离线协议 POC；未修改产品代码，未调用真实 Gemini API，未验证写作质量。

## 用户目标与结论

用户希望通过 Google AI Studio 接入 Gemini，重点体验 Gemini 3.8 Flash 的写作能力，并询问能否用于三个渠道。本文将“三个渠道”理解为 CodePilot Native、Codex、Claude Code 三个 Runtime。

结论：AI Studio / Gemini Developer API 可以作为统一上游。Native 和 Codex 有现成基础，但仍有端到端适配工作；Claude Code 需要新增 Anthropic Messages 转换入口，只能按实验性兼容推进。不能仅添加模型名称就宣称三个 Runtime 已支持。

| Runtime | 现有基础 | 尚缺什么 | 可行性判断 |
|---|---|---|---|
| CodePilot Native | `createModel()` 已有 Google SDK，resolver 已识别 google，模型发现已有 Gemini 分支 | 文本 Provider 预设、精确能力与参数映射、历史签名持久化/恢复、真实多轮验证 | 最适合作为首期写作入口 |
| Codex | 本地 Responses proxy 已复用 `createModel()` | Google 预设准入、思考档位映射、工具调用签名往返与恢复、错误/usage 转换验收 | 可沿现有桥接路径支持 |
| Claude Code | 已有第三方 Anthropic 协议 Provider 路径 | 新建 Messages → Gemini → Messages/SSE 适配器，含工具/签名/中断/续聊/角色模型请求 | 技术上可尝试，工作量最大；不是官方支持组合 |

推荐顺序：先完成 Native 的写作和续写体验，再让 Codex 复用同一套 Google 适配；Claude Code 单独做兼容性 POC，通过真实 Agent 流程后才展示支持。

## 上游事实与服务边界

- 使用 AI Studio 创建的 Gemini API key，访问 `generativelanguage.googleapis.com`；不接 Vertex 的 project/location/ADC 服务账号流程。AI Studio key 自身关联 Google 项目，不应把“非 Vertex”描述为“完全不涉及 Google 项目”。见 [API keys](https://ai.google.dev/gemini-api/docs/api-key)。
- 官方模型 ID 是 `gemini-3.8-flash`，状态为 GA。输入上限 1,048,576 tokens，输出上限 65,536 tokens；文本输出、函数调用、结构化输出均受支持。这些是模型上限，不等于 CodePilot 当前能使用的完整上限。见 [模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)。
- 思考档位为 low / medium / high，默认 medium；minimal 不支持。迁移文档要求移除 temperature / top_p / top_k，不能沿用其他模型的通用参数。见 [3.8 迁移说明](https://ai.google.dev/gemini-api/docs/latest-model)。
- 官方支持 OpenAI Chat Completions 兼容入口 `https://generativelanguage.googleapis.com/v1beta/openai/`。这不等于已经提供 Codex 所需的 Responses API，也不等于 Anthropic Messages。见 [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)。
- 本次未找到 Google 官方的 Anthropic Messages 兼容入口。Claude Code 官方要求网关提供 Messages 等指定格式，并明确不支持通过网关接非 Claude 模型。因此 Claude 方案只能定位为 CodePilot 自行维护的实验性兼容。见 [网关说明](https://code.claude.com/docs/en/llm-gateway)、[协议要求](https://code.claude.com/docs/en/llm-gateway-protocol)。

用户提供的 AI Studio 模型页本次抓取失败；核验改用 Google 官方 `ai.google.dev` 的对应模型页和 API 文档。

## 源码事实与具体缺口

### Provider 与模型目录

- `src/lib/ai-provider.ts:408` 使用 `createGoogleGenerativeAI()`，返回 `google(config.modelId)`。
- `src/lib/provider-resolver.ts:1008` 的 google 分支传入 API key/base URL；不需要借用 Vertex Provider。
- `src/lib/provider-catalog.ts` 定义了 google 文本协议，但未配置 Gemini 文本预设。现有 `gemini-image` 是图像专用；`vertex` 预设是 Vertex 上的 Claude，均不应复用成这次的文本入口。
- `src/lib/runtime-compat.ts:72` 先匹配预设，失败返回 unknown；虽然后面存在 google → codepilot_only（Native + Codex）的分支，但不能据此认定当前 UI 已完整开放。
- `src/lib/model-discovery.ts:244` 已有 google / models.list；新增入口仍需核对分页、可生成文本的模型过滤、权限失败与手动添加回退。模型目录必须让官方 model ID 与本地 alias 分离，延续 #685 路由身份保护。
- `inferProtocolFromLegacyFields()` 未单列 google，新增预设时需要覆盖旧记录缺 protocol 的迁移/兼容测试。

建议新增独立 `Google AI Studio` 文本预设，明确 API key 来源。初始目录放 `gemini-3.8-flash`，未来模型通过可发现能力和精确规则扩展，不通过名称猜测所有 Gemini 都有相同能力。

### Native

当前安装的是 `ai@7` + `@ai-sdk/google@4.0.6`，不能按旧 handover 文档中的 AI SDK 6 版本号设计。

- `src/lib/agent-loop.ts:556` 附近有 OpenAI/xAI options，未发现 Google thinking options 映射。
- 同一 Agent 回合内，`agent-loop.ts:918` 追加 `responseData.messages`，这给签名保留提供基础。
- 下一次用户发消息时，重新走 `buildCoreMessages()`。`src/lib/message-builder.ts:282` 跳过 thinking，tool_use 重建也不带 providerOptions。故历史序列化/反序列化需要扩展，不能只修同一次工具循环。
- Native 当前单次输出上限写为 16,384。若宣称 64K 长文输出，需要单独调整输出预算、截断提示及思考 token 占用处理；首期可保留明确的应用上限。

### Codex

拟沿用：Codex app-server → 本地 `/api/codex/proxy/v1/responses` → 统一适配器 → Google Gemini API。

- `src/lib/codex/proxy/unified-adapter.ts:805` 的 `buildProviderOptions()` 未构建 Google 思考设置。
- `src/lib/codex/proxy/translate-stream.ts:302` 把工具调用输出成 call_id/name/arguments，未保留 Google provider metadata。
- `src/lib/codex/proxy/translate-input.ts:131` 从下一次 Responses 请求重建 tool-call 时，也未恢复签名。
- 不能简单往 Responses 中加入一个未知字段并假设 Codex 会保存。需要实测支持的载体，或由本地 bridge 保存按 session/provider/model/call ID 隔离的原始状态；需覆盖重启、重试、压缩和取消后的恢复。

### Claude Code

`ANTHROPIC_BASE_URL` 接收的是 Anthropic 协议入口，不能直接填 Gemini 原生 URL 或 OpenAI 兼容 URL。已有 AI SDK 的 Anthropic **客户端**适配能力也不是能够接收 Claude Code 请求的 **服务端**入口。

若要求三个 Runtime 都能使用，需要新增本地适配器：

1. 接收 `/v1/messages`，解析 system/messages/tools/tool_choice、角色模型及思考请求。
2. 通过共享 Google 适配器调用 AI Studio；保留签名和工具调用身份，转换 tool_use/tool_result。
3. 返回符合 Messages 的 content block 流、stop_reason、usage 和错误；支持中断，避免工具重复执行。
4. 区分真正的 Gemini 模型身份和 Claude Code 的路由别名；不向用户展示伪造 Claude 能力。token counting 若只能估算，需要明示。

本地转换仍可直接使用用户的 AI Studio key，不必引入第三方托管模型中转商。

## 两条 Google 原生 API 路线

Google 现在推荐 Interactions API；generateContent 已属 legacy，但仍完全支持。见 [Interactions overview](https://ai.google.dev/gemini-api/docs/interactions-overview) 和 [generateContent reference](https://ai.google.dev/api/generate-content)。

| 选项 | 好处 | 需要处理的边界 |
|---|---|---|
| 复用 generateContent | 当前 `createModel()` 已走此路；改动面较小 | 本地完整保存 thoughtSignature，补 3.8 参数规则 |
| 显式 `google.interactions(model)` | 已安装的 Google SDK 存在该方法；跟随官方新接口，可使用服务端会话链 | 不是更换 URL 就完成：思考 options 结构不同，需测试输出/SSE/usage；选 stateful 时还要保存并隔离 previousInteractionId，处理过期、分支及数据存储语义 |

本次建议：短期基于现有 generateContent 先做真实凭据 POC，以便尽快验证写作价值；同时将 Google 的调用方式封装在统一 adapter 内。若新接口实测在恢复与工具状态上更可靠，再明确切换 Interactions，避免两个 Runtime 各自维护一套规则。

Interactions 默认存储请求；`store:false` 时需自行完整重放状态，不能再依赖 previous_interaction_id。不能为了省掉签名持久化而悄悄改变应用的存储行为。思考签名是模型状态，不能把 UI 中可见的思考摘要当成它。见 [Thinking / signatures](https://ai.google.dev/gemini-api/docs/thinking)。

## 离线 POC 证据

临时脚本：`/tmp/codepilot-gemini-research.ts`。运行：`node --import tsx /tmp/codepilot-gemini-research.ts`，2026-09-18，exit 0。

使用真实已安装的 Google SDK、AI SDK generateText 和项目的 `translateResponsesInput()`；fetch 全量替换为合成响应，使用假 key，没有网络请求或模型调用。

| 核验项 | 实际结果 |
|---|---|
| `google('gemini-3.8-flash')` 请求地址 | `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent` |
| tool-call 带 `providerOptions.google.thoughtSignature` | 原签名正确进入请求 |
| 经现有 Codex 输入转换重建历史 | 原签名不存在；SDK 自动注入 `skip_thought_signature_validator` 并发出 warning |
| 显式 temperature=0.6 | SDK 原样发送，未按 3.8 自动剔除 |
| Google thinkingConfig.thinkingLevel=low | 正确进入 generationConfig |
| function result ID | SDK 发送 `functionResponse.id=call_1`，name 正确 |
| `google.interactions` | 方法存在；本次未验证其真实端到端行为 |

这证明了转换缺口，**并不证明真实请求一定报 400**：SDK 的 sentinel 本来就是协议兜底，但它不等价于保存了原始推理状态，也不能作为稳定多轮体验的验收依据。

另有官方文档命名差异：3.8 迁移清单写 FunctionResponse 的 `call_id`，generateContent REST schema 则仍使用 `id`。本地 SDK 使用后者；实现时应按具体 API 的真实 wire 验证，不机械改名。

## 验收建议与写作评测

首期验收需要真实 API key，但本次没有索要或读取凭据。实现后至少覆盖：

1. 添加 AI Studio Provider，精确保存模型 ID；Native/Codex picker 与真实能力一致，Claude 未通过 POC 前禁用并解释原因。
2. 中文长文生成 → 指定段落改写 → 改变语气 → 重启应用继续写，检查历史承接与格式保真。
3. 连续两次文件读取/搜索调用，校验每次原始签名、调用 ID 和结果匹配；覆盖并行工具、失败工具、压缩后续聊。
4. low/medium/high 正确映射，minimal/off/max 不直接外发；采样参数不再进入 3.8 请求。
5. 验证流式首字、取消后再次发送、429/配额错误、模型权限不足、真实 usage 与缓存/思考 token、输出截断提示。
6. Windows/macOS 各跑相同脚本，特别验证代理网络与 packaged 子进程路径；不能因为通用 HTTP 代码相同就直接宣称跨平台 smoke 通过。

“写作不错”暂时是用户转述，未形成独立证据。建议用同一批真实题材盲测 3.8 Flash 与当前常用模型：中文文章、品牌语气、局部润色、长文续写；分别比较原生中性写作提示与各 Runtime 自身系统提示，记录约束遵循、套话、事实准确性、修改稳定性、延迟及成本。Runtime 的编程提示可能影响文风，不能将其差异全部归因于模型。

以上是调研阶段结论。2026-09-18 用户随后授权先接 Native，现已完成产品代码与离线回归、本地 UI fixture smoke；详见 [Native 执行计划](../exec-plans/active/gemini-native-ai-studio.md)。仍未达到真实 API Smoke passed，未发版；其他 Runtime 不在本轮实现范围。
