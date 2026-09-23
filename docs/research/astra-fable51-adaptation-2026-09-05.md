# GPT-6 Astra / Claude Fable 5.1 接入核验（2026-09-05）

> 后续状态：用户已授权修复 Astra / OpenAI OAuth；实施、测试与剩余 smoke 见 [执行计划](../exec-plans/active/astra-openai-oauth-compatibility.md)。下文的“此次仅诊断/未修改”描述调研当时，不能当作后续代码状态。

结论：Codex Account 已实测发现 Astra，但其默认窗口不是 API 的 1.05M；OpenCode v1.18.29 对照及离线复现确认独立 OpenAI OAuth 的刷新并发/失败清凭据、固定目录和 SDK reasoning 路径需优化；Fable 5.1 需加入精确目录并补协议回归。此次为核验与适配范围，不修改产品模型配置、不升级 CLI/依赖、不切换用户默认模型。

## 实测证据

本项目两个正在运行的本机 Dev 服务（3000 / 3220）的 `GET /api/codex/models?refresh=1` 均返回 HTTP 200、`recoverySafeMode:false`，发现 7 项：

- `gpt-6-astra`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`
- `gpt-5.5`
- `gpt-5.4-mini`
- `gpt-5.3-codex-spark`

Astra 的 Composer effort 为 `low / medium / high / xhigh / max`。3220 的运行时状态报告 Codex Desktop/0.153.1；3000 查询前为 installed_idle，显式模型发现后返回上述列表。这里只证明当前运行环境的发现与展示链路，没有执行 Astra 生成任务，不代表所有用户、所有账号都已经开放。

两个服务的独立 `GET /api/openai-oauth/status` 都是 `authenticated:false`。因此没有用真实 OpenAI OAuth 账号验证 Astra entitlement 或生成；不能把 Codex Account 的可见性直接当作 OAuth 可调用的证明。

## OpenAI：自动发现与固定目录必须分别处理

### Codex Account

- `src/lib/codex/models.ts` 调 app-server `model/list`，当前没有针对 GPT 版本的名字白名单；Astra 已能通过现有解析和展示。
- 上游 `inputModalities` 已读取，但 `buildCodexProviderModelGroup()` 没有将它映射为 `capabilities.vision`。可补齐 UI 能力事实，避免列表能选而视觉能力未知；不能靠型号名称猜。
- `model/list` 响应有 `nextCursor`，当前只读一页；这没有导致本机 Astra 缺失，但应补分页与去重回归。
- 官方 [Codex changelog](https://learn.chatgpt.com/docs/changelog) 记录 0.153.1 加入 Astra 配置支持、当时未显示在 bundled picker，0.153.4 修正 bundled picker 的 Astra 可见性。不同版本/账号的远程目录与 bundled fallback 可能不同；不要用本机 0.153.1 已显示来推断所有旧版本都显示，也不要绕开 hidden/账号访问控制硬塞一个选项。

### 独立 OpenAI OAuth

- `src/lib/managed-virtual-provider-models.ts:OPENAI_OAUTH_CATALOG_MODELS` 是固定 5 项，停在 5.5/5.4/5.3，没有 5.6/Astra；即使账号获权，当前入口也不会自动出现新型号。
- `src/lib/ai-provider.ts` 通过项目自己的 OAuth 凭据请求 `chatgpt.com/backend-api/codex/responses`；它不是 Codex Account 的 app-server transport。优化应以这套凭据可用的上游目录或经过验证的精确目录为准，不能搬用另一账号的 `model/list`。
- Native `src/lib/agent-loop.ts` 的 Responses 分支仍写死 `reasoningEffort:'medium'`；若补新目录和 effort 控件，必须同时接通用户选择，不能只让 UI 多出档位。
- 已用本地安装的 `@ai-sdk/openai` 做完全离线 fetch 捕获（占位 key，fetch 只捕获并抛 sentinel，无联网）：相同 `reasoningEffort:'max'` 参数，`gpt-5.6-sol` 输入有 `reasoning.effort:max`，`gpt-6-astra` 输入没有 reasoning；设置 `forceReasoning:true` 后 Astra 恢复正确字段。原因是该版本内部识别仅覆盖 `o1/o3/o4-mini/gpt-5*`。必须做精确模型能力适配或经验证的 SDK 升级，不能给所有未知模型强开 reasoning。

### Astra：API 容量与 Codex 有效窗口不同（用户追问后核实）

更正前一轮判断：不能把 API 的 1,050,000 直接作为 Codex 的默认历史预算。

| 来源/语义 | tokens | 验证性质 |
| --- | ---: | --- |
| API 总上下文 | 1,050,000 | 官方 API 型号页；最大输入 922,000、最大输出 128,000 |
| Codex 默认原始窗口 | 272,000 | 本机 app-server 目录缓存与最新官方 bundled catalog 一致 |
| Codex 默认有效窗口 | 258,400 | 根据目录的 95% 和官方源码公式推导，非本轮新生成任务的 UI 实测 |
| Codex 默认自动压缩阈值 | 244,800 | 未显式设置时按原始窗口 90% 推导；实际压缩还有其他触发条件 |
| Codex 允许配置的原始窗口上限 | 872,000 | 目录 `max_context_window`；不是默认启用值，也不是 API 最大输入 |
| 配置至上述上限后的有效窗口 | 828,400 | 872,000 × 95% 的条件推导；本轮没有修改配置或验证长上下文生成 |

本机证据文件：`/private/tmp/codepilot-native-site-capture-20260905/data/codex-home/models_cache.json`，`fetched_at:2026-09-05T01:32:26.828194Z`、`client_version:0.153.1`。仅读取模型元数据；该 home 的配置未找到窗口/压缩覆盖项，不把它当成所有用户环境的证明。

官方源码新拉取至 `/private/tmp/codepilot-codex-window-review-20260905`，HEAD `459a79eb85400af759e9220c7bafb4429ae07516`（2026-09-05）：

- [Astra bundled catalog](https://github.com/openai/codex/blob/459a79eb85400af759e9220c7bafb4429ae07516/codex-rs/models-manager/models.json) 的默认/最大窗口与本机缓存一致。
- [ModelInfo](https://github.com/openai/codex/blob/459a79eb85400af759e9220c7bafb4429ae07516/codex-rs/protocol/src/openai_models.rs) 的 `usable_context_window()` 使用原始窗口 × effective percent；默认 percent 为 95，`auto_compact_token_limit()` 取原始窗口 90% 与显式阈值的较小值。
- [with_config_overrides](https://github.com/openai/codex/blob/459a79eb85400af759e9220c7bafb4429ae07516/codex-rs/models-manager/src/model_info.rs) 将显式 `model_context_window` 限制在该模型声明的最大窗口以内。

`getContextWindow('gpt-6-astra')` 仍返回 null，`/api/chat` 历史预算因此回退 200000。应修的是「运行通道/模型元数据/实际配置」感知的预算，不能在公共型号表统一填 1.05M。现有 `src/lib/codex/event-mapper.ts` 已透传 `thread/tokenUsage/updated.tokenUsage.modelContextWindow`，会话展示应继续优先使用该真实运行时值。

推理档位也必须分开：官方 [API 型号页](https://developers.openai.com/api/docs/models/gpt-6-astra) 为 low/medium/high/xhigh/max；本机与官方 Codex catalog 另含 `ultra`，描述涉及自动任务委派。CodePilot 已解析 ultra，但 `src/lib/codex/effort.ts` 明确从通用 effort 菜单排除，原因是尚未建模其多 Agent 产品语义。这不是漏识别型号；不能只为对齐菜单把 ultra 作为普通更高档位暴露给所有 Provider。

## OpenCode 最新源码对照（2026-09-05）

按用户要求从官方仓库重新 shallow clone，未使用旧 `opencode-dev` 副本、未运行上游安装脚本或修改产品代码：

- 本机路径：`/private/tmp/codepilot-opencode-review-20260905`。
- 仓库：`https://github.com/anomalyco/opencode`，默认分支 `dev`。
- 核验 HEAD：`5b1e31988ed74b821b3a7ca6647188446992aafc`，2026-09-04，版本同步 v1.18.29。
- 当前入口 `packages/opencode/src/plugin/index.ts` 确实装载 `./openai/codex`；仓库同时有 V2 provider，以下不把未证实的 V2 能力算到当前路径上。

### 已确认值得移植的差异

1. **P2：刷新并发与失败清凭据。** [OpenCode OAuth loader](https://github.com/anomalyco/opencode/blob/5b1e31988ed74b821b3a7ca6647188446992aafc/packages/opencode/src/plugin/openai/codex.ts) 用共享 `refreshPromise` 合并同一 loader 的并发刷新，失败向上传播，不在这里清空凭据。CodePilot `ensureTokenFresh()` 没有合并，且 catch 无条件 `clearOAuthTokens()`。直接对当前 TypeScript 源码 transpile 后在 VM 中注入内存 DB/假 refresh 函数：两个同时请求实际调用 refresh 两次；先成功再失败时，成功保存的新凭据被清空。单独模拟网络 TypeError 也清空 access/refresh。无真实 DB、凭据、网络或授权服务变更。应合并刷新，并区分临时故障与明确失效；持久化前还需防止 logout/换账号后的旧请求回写。
2. **P2：Astra reasoning 丢失。** [OpenCode providerOptions](https://github.com/anomalyco/opencode/blob/5b1e31988ed74b821b3a7ca6647188446992aafc/packages/opencode/src/provider/transform.ts) 根据能力声明或明确推理参数设置 `forceReasoning:true`，避免 SDK 型号名字门禁。再次捕获本机真实 SDK 的离线请求：5.6 Sol 有 `reasoning.effort:max`，Astra 无 force 时缺整个 reasoning，带 force 后恢复 max。应接通用户 effort 并按能力映射，不全局给未知型号强开。
3. **模型目录已不依赖五项固定列表。** [目录加载器](https://github.com/anomalyco/opencode/blob/5b1e31988ed74b821b3a7ca6647188446992aafc/packages/core/src/models-dev.ts) 默认拉 `https://models.opencode.ai/api.json`，有五分钟缓存、内置快照和网络失败处理；[Provider 转换](https://github.com/anomalyco/opencode/blob/5b1e31988ed74b821b3a7ca6647188446992aafc/packages/opencode/src/provider/provider.ts) 读取能力、容量和 `reasoning_options`。OAuth 再过滤 pro/不适用型号，版本规则允许 Astra；[上游测试](https://github.com/anomalyco/opencode/blob/5b1e31988ed74b821b3a7ca6647188446992aafc/packages/opencode/test/plugin/codex.test.ts) 有 Astra 正例。**这仍是公共目录过滤，不是用当前用户 OAuth 获取 entitlement**。本次直接读取公共目录返回 HTTP 403，所以只确认源码支持，不能宣称已实测 OpenCode 线上目录包含 Astra 或当前账号可调用。
4. **账号标识与区域路由。** 上游可先从 ID token、再从 access token 提取账号 ID；从 access token 的 compute residency claim 添加 `x-openai-internal-codex-residency`，只发往被重写的 Codex backend 请求。我们只从 ID token 保存账号 ID，未处理 residency。属于有明确源码差异、真实账号影响待验证的兼容项，不宣称普通账号必坏。

### 已对齐或不应照搬的部分

- PKCE S256、client ID、授权/令牌 endpoint、localhost:1455 callback、scope、Codex Responses endpoint、每次 fetch 更新 bearer/account ID 这条主链已经基本一致，不需要整体替换 OAuth。
- CodePilot 已 `store:false`，Responses 路径已经不传 `maxOutputTokens`；不要把这两项重复报成缺口。上游额外有 originator、版本 User-Agent、session-id、缓存 affinity、encrypted reasoning continuation 等，应按各字段真实用途补 wire tests，不能只复制头字段就宣称兼容。
- OpenCode 的 5.5/5.6 OAuth 限额覆盖为 context 400K / input 272K / output 128K；Astra 不经过该覆盖，沿用公共目录。**不能将上游公共目录的 Astra 容量直接复制成 Codex app-server 默认容量。**
- 上游按 `reasoning_options` 建档位优于型号名猜测；若元数据缺失，其通用 fallback 仍可能不足以准确代表 Astra，因此也不能照抄 fallback 并宣称 max 已支持。
- Device flow 是浏览器回调不可用时的补充入口；上游的 403/404 轮询只用于等待 device authorization。我们的旧代码注释将它作为 authorization-code exchange 403 重试的参考，证据并不等价；不据此认定浏览器 flow 的 403 根因。
- WebSocket 有复用/失败回退，但当前稳定通道需显式开启，预发布通道默认开启。它是后续性能项，不是这次 Astra/OAuth 正确性的前置条件。

不能精确宣称「落后 N 个版本」：本项目是独立实现，git 历史显示 OAuth 主实现 2026-04-07、exchange 重试 2026-04-15，期间其他调用层还有修复；可确认的是上述逐项行为差异，不能把 OpenCode 版本号当作我们已采用的版本。

### 验证记录与待修范围

| 离线场景 | 结果 |
| --- | --- |
| 并发过期刷新，第一项成功、第二项失败 | 2 次刷新；登录状态 true → false，复现失败请求清掉新凭据 |
| 单次临时网络失败 | access 与 refresh 都被清空 |
| SDK 5.6 Sol，effort=max | wire 含 max |
| SDK Astra，effort=max，无 force | wire 缺 reasoning |
| SDK Astra，effort=max，force=true | wire 恢复 max |

推荐修复顺序：刷新 single-flight/失败分类及账号代际防护 → OAuth 目录与 capability/effort wire → 按通道与运行时事实算上下文 → 账号区域兼容。回归至少覆盖并发成功/失败交错、临时 5xx/断网保留登录、永久失效、刷新中 logout/重登录不复活旧账号、Astra max 不丢、未知模型不强开、Codex 默认/覆盖窗口不混用。此次仅诊断及文档回写，未关闭以上 finding；实际 OAuth 账号登录、Astra 生成和长上下文 smoke 仍待实施阶段验证。

## Anthropic：Fable 5.1

官方 [型号页](https://platform.claude.com/docs/en/models/fable-5-1/overview) 给出 `claude-fable-5-1`、1M 上下文、128K 最大输出、始终开启 adaptive thinking，默认 effort high。应作为新的明确选项保留 Fable 5 和原角色默认，不自动迁移旧聊天。

本地核验结果：

- `ENV_CLAUDE_CODE_MODELS` 和第一方 catalog 没有 5.1。
- `getContextWindow('claude-fable-5-1')` 已经通过旧 Fable 5 的 substring fallback 返回 1M。
- `claude-model-options.ts` 的现有 Fable pattern 能匹配 5.1，effort 返回 low/medium/high/xhigh/max；显式关闭 thinking 会被去掉并设置 `thinkingForcedOn:true`。这些基础保护已有，不能误报成必须全部重写。
- 需要把以上“碰巧由 family 匹配成立”的行为变成精确 5.1 catalog、能力 metadata 和测试合同。

[官方迁移说明](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide) 的关键变化：强制 `tool_choice:any/tool` 会报 400；较旧模型会丢弃无法读取的 5.1 thinking；保留 thinking 却修改先前 system/tools/messages，在启用相应校验的账号上可报签名/前缀不匹配。应核对旧聊天切模型、压缩、工具变化和失败重试。当前 Native 主循环使用 auto/none，跨轮 `message-builder.ts` 不重放旧 thinking，已经避开部分风险；但单轮多步仍追加 SDK response.messages，需用严格 prefix 校验做 wire/真实账号验证，不能仅凭静态匹配宣布完全兼容。

增强项可后续处理：[What's new](https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1) 的 per-message effort、turn-scoped system 和 progress updates。其 beta 接线与旧 SDK 是否透传应单独验证，不要为本次基础型号接入同时重构整个消息协议。费用若展示需核对 5.1 的新 cache-read 定价与真实 usage 来源，未知仍显示未知。

## 建议一次完成的适配范围

1. Astra：Codex 动态发现正例、分页/hidden 负例、inputModalities 映射、按通道与实际配置区分的上下文预算；无需为本机列表硬编码补项，不能将 API 1.05M 填成 Codex 默认值。
2. OpenAI OAuth：先修刷新并发/失败清凭据；在同凭据发现/校验的基础上更新可选目录，公共目录仅作候选；接通精确 effort，修复 Astra 在当前 SDK 下丢 reasoning 的离线可复现问题；未登录与无 entitlement 均不能显示成已验证可用。
3. Fable 5.1：新增精确目录与能力，保持既有默认/用户编辑行；覆盖 auto/none 工具、thinking 始终开启、5 ↔ 5.1 ↔ Opus 的原聊天切换、压缩与重试。
4. 验证：隔离模型目录/真实 SDK wire tests → 完整测试 → 原聊天 Picker E2E → 对应已授权账号的最小文本、工具和多轮 smoke。发现成功与生成成功分开记录。

本轮证据为官方文档、现有代码、两个本机发现端点和离线请求捕获；没有运行完整测试（没有修改产品代码），没有真实 OAuth/Astra/Fable 5.1 生成验证。


## 2026-09-05 用户授权后的 Fable 5.1 实施回写

上文“仅调研/待适配”是原始核验时点；本次用户明确追加授权后，已新增第一方和 env 共享目录的 `fable-5-1 → claude-fable-5-1`、精确 1M 窗口与 high 默认 effort 能力。旧 Fable 5、Opus/Sonnet 角色与用户行保持原语义。官方 [overview](https://platform.claude.com/docs/en/models/fable-5-1/overview) 与 [migration guide](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide) 于 2026-09-05 再次核实。

现有 sanitizer 已支持始终 adaptive 与五档 effort，实际 Native 双步工具请求捕获确认 `output_config.effort=max`、`thinking.type=adaptive`、`tool_choice=auto`、system/tools/shared history 不变、签名重放。跨回合 DB 重建不发送旧 thinking，切换 5/5.1/Opus 可保留正文；无工具路径不发 any/tool。未添加需要新 beta 的 per-message effort、turn system、updates 或自动 refusal fallback；未宣称真实模型签名/entitlement 已通过。完整验证和剩余 smoke 见 [执行计划](../exec-plans/active/astra-openai-oauth-compatibility.md)。
