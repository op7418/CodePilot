# 基础体验更新事实基线：模型、推理强度、权限与会话命名

> 日期：2026-07-17；2026-07-20 按用户真实 UI smoke、Claude 独立审查与最新厂商文档复核
> 性质：当前代码 + 官方资料 + 本地只读 POC 的调研基线；实现进度以关联 active plans 为准。
> 关联计划：[模型目录与推理强度](../exec-plans/active/model-capability-reasoning-refresh.md) · [跨 Runtime 权限模式](../exec-plans/active/runtime-permission-modes.md) · 自动会话命名

## 结论摘要

1. **推理强度控件不是从零开发。** `MessageInput` 已在模型声明 `supportsEffort` 时把强度选择器放在模型选择器右侧；当前问题主要是模型目录、能力元数据和 Runtime wire contract 漂移。
2. **GLM-5.2、GPT-5.6、Claude Sonnet 5 与 Kimi K3 都有明确 effort 依据，但展示名和 wire ID 仍要分开。** Kimi 2026-07-20 更新说明确认 K3 已集成到 Kimi Code 并支持 low/high/max；用户现场确认 Kimi for Coding 当前返回 K3。CodePilot 因此继续只显示渠道名 `Kimi for Coding`、wire 仍发 `kimi-for-coding`，不增加底层版本选择或兼容层。
3. **Codex 当前有两个模型入口。** `codex_account` 动态读取 app-server `model/list`；旧 `openai-oauth` 仍是硬编码目录。二者必须收敛，否则同为“OpenAI/Codex”却看到不同模型。
4. **“替我审批”不能等同于完全访问。** Claude Agent SDK 已有 `permissionMode: 'auto'`；Codex 有 approval policy + auto reviewer；AI SDK Native 只有 per-tool approval primitives，需要 CodePilot 自建 reviewer 才能提供同等语义。
5. **当前已有自动标题，但只是首消息截断。** 新对话存在两条不一致的 50 字截断链路；语义命名前必须先统一标题事实源、UI 刷新和手动改名优先级。

## 建议迭代编排

| 迭代 | 必做范围 | 可并行项 | 退出条件 |
|---|---|---|---|
| Iteration A：事实源与基础一致性 | 模型计划 Phase 0（Codex schema / GPT-5.6）+ Phase 1（GLM/Kimi 目录）；标题 Phase 0；权限 Phase 0 live schema / contract POC | Sonnet 5 contract 准备 | UI 不再读取空 capability；标题即时同步；权限三档有可验证 wire mapping |
| Iteration B：用户能力落地 | Sonnet 5；Claude/Codex auto reviewer；标题 provenance + 同 provider 语义生成 | 真实凭据 smoke 可按 provider 分批 | 三条主路径各有反例测试和 smoke；不支持的 Runtime 明确降级 |
| Iteration C：长期收敛 | Native reviewer 是否实施；capability normalization / upstream fixture；标题设置与观测 | 可按使用数据决定是否进入 | reviewer 安全门槛通过，或正式记录 Native 不支持；上游变化有 drift guardrail |

Iteration A 不应被“做统一抽象”拖住：先修已出现的 Codex schema drift 和旧目录。Iteration B 才把用户可见能力完整铺开。Native reviewer 风险最高，保留到 POC 结论明确之后。

## 模型与推理强度

| 渠道 / 模型 | 官方事实 | 当前仓库事实 | 计划结论 |
|---|---|---|---|
| GLM-5.2 | GLM Coding Plan 已提供 GLM-5.2；Claude Code `/effort` 中 low/medium/high 映射为 high，xhigh/max/ultracode 映射为 max | GLM CN/Global 仍以 GLM-5-Turbo / GLM-5.1 为目录，且无 effort capability | 更新目录与 role mapping；UI 只表达真实有效档位 high/max，并说明映射，不展示伪精度 |
| Kimi for Coding | K3 已集成到 Kimi Code 并支持 low/high/max；产品渠道与显式 `k3` ID 仍是不同 wire identity | 线上 DB 启用的是手动 `kimi-for-coding` 行，label 为裸 ID、capabilities 为空；旧 catalog `sonnet` 行被手动隐藏，因此需要最终 read-path enrichment | 只显示 `Kimi for Coding`，wire 发 `kimi-for-coding`，不展示底层 K3；只读 enrichment 为真实 manual 行补目录名称与 Auto/Low/High/Max，DB 明确值优先且不写回 |
| GPT-5.6 | GPT-5.6 Sol/Terra/Luna 已发布；API 档位包含 none/low/medium/high/xhigh/max；Codex 侧可有额外产品档位 | `openai-oauth` 目录停在 5.5；`codex_account` 动态目录方向正确，但 app-server schema 已漂移；Runtime 仍把 xhigh/max 降为 high | 以 app-server `model/list` 为 Codex Account 真源；兼容新旧 schema；按模型 allowlist 透传，不再全局 clamp；Codex 专属 `ultra` 不冒充普通 API effort |
| Claude Sonnet 5 | `claude-sonnet-5` 已发布，1M context，adaptive thinking；manual extended thinking 不再支持 | Sonnet 5 未进入 catalog / model context / sanitizer | 作为完整模型契约接入，不能只加下拉条目；同步 thinking、sampling、context 与回归测试 |
| Claude Fable 5 | `claude-fable-5` 已 GA，1M context，adaptive thinking always-on，支持 effort | catalog、context、sanitizer 和测试已有接入 | 作为已存在基线重新做真实请求验证，不重复造第二套入口 |

### Codex 本地只读 POC

使用应用内 `/Applications/ChatGPT.app/Contents/Resources/codex`（`codex-cli 0.144.2`）和隔离的临时 `CODEX_HOME` 运行 `initialize + model/list`，未读取用户凭据：

- 返回 `gpt-5.6-sol`（默认）、`gpt-5.6-terra`、`gpt-5.6-luna`，以及 5.5 / 5.4 / 5.4-mini / 5.2。
- GPT-5.6 Sol 返回 low / medium / high / xhigh / max / ultra，默认 low。
- 当前响应元素字段是 `{ reasoningEffort, description }`；仓库 `src/lib/codex/models.ts` 仍读取 `e.effort`。因此模型可被发现，但能力列表会变成空值。
- 此 POC 证明当前二进制的目录能力，不证明每个真实账号的 entitlement；产品仍需对版本、登录状态和 rollout 差异诚实降级。

### 仓库关键触点

- 能力门禁与控件位置：`src/components/chat/MessageInput.tsx:1053-1055,1217-1222`。
- Codex 动态目录与 schema 漂移：`src/lib/codex/models.ts:66-97,151-160`。
- 旧 OAuth 硬编码目录：`src/app/api/providers/models/route.ts:15-24,353-362`。
- Codex 全局 effort clamp：`src/lib/codex/effort.ts:23-43`、`src/lib/codex/runtime.ts:934-951`。
- GLM/Kimi 旧目录：`src/lib/provider-catalog.ts:558-635`。
- Claude 现有目录与 Fable：`src/lib/provider-catalog.ts:348-424`。
- effort 菜单硬编码五档回退（伪档位来源，须随 Phase 0 收编）：`src/components/chat/EffortSelectorDropdown.tsx:36`。
- Native 路径对 adaptive 家族丢弃显式 effort（catalog 声明五档但实际不下发，模型计划 Phase 2 裁决）：`src/lib/agent-loop.ts:408-425`。

### Kimi 展示合同与 wire 合同必须分离

用户已经明确不希望在 CodePilot 中额外展示 K3，用户可见名称继续固定为 `Kimi for Coding`。2026-07-20 更新说明确认 K3 已集成进 Kimi Code 并支持 low/high/max，用户现场又确认该渠道当前返回 K3；这足以更新当前 capability，但不需要把底层版本暴露为第二层模型选择。

因此实现遵守两层合同：

- **展示合同**：模型列表只显示 `Kimi for Coding`，不把 K3/K2.7 版本名当作第二层选择，也不要求每次底层发布都改 UI 文案。
- **wire 合同**：不得从展示名反推上游 ID。本产品渠道固定发其自己的 `kimi-for-coding`，不因为当前返回模型版本改变成 `k3`；Auto 表示不显式下发，Low/High/Max 是当前 capability 合同，仍需逐档真实 wire smoke。
- **迁移合同**：新记录使用真实上游 ID 作为 canonical identity；旧 `sonnet` 只作为存量 session 的解析兼容，不再作为新 DB 行和 UI 的主 ID。手动添加的 `kimi-for-coding` 行不能继续无能力元数据地遮蔽 catalog，但也不能无 provenance 地覆盖用户自定义能力。

这满足“用户不用理解 K3”的产品目标，也让未来底层升级不要求修改 UI 名称；如果渠道能力再次变化，应更新 capability 真源和回归，而不是增加版本选择层。

## 2026-07-19 用户 smoke 打回与根因

| Signal | 复现事实 | 根因 / 当前判断 | 归属 |
|---|---|---|---|
| Codex GPT-5.6 无强度框 | `/api/providers/models` 中 GPT-5.6 的 nested `capabilities.supportsEffort=true`，但 top-level `supportsEffort` 缺失 | Codex virtual group 在 DB provider 的 capability lift 之后才加入；`MessageInput` 只读 top-level。已有测试只测 builder，没测最终 route contract | 模型计划 Phase 0 重新打开 |
| Kimi 无强度框 | 实际启用行是手动 `kimi-for-coding`，label 为裸 ID、capabilities 为空 | DB 行遮蔽隐藏的 `sonnet` catalog 行；最终 read path 没有按 upstream identity 做只读 enrichment | 已修：只显示 `Kimi for Coding`，wire 不变，final route 暴露 Auto/Low/High/Max；含 hidden legacy alias 的真实形状有回归 |
| 智谱“获取模型列表失败” | 本地 route 8 秒后 502 `PROBE_FAILED`；直连 Kimi/智谱/Google Fonts 都在 DNS 解析阶段超时 | 本次开发环境 `scutil --dns` 显示无 DNS 配置，是立即故障；架构上 CodePlan `/v1/models` 也不是官方承诺，仓库自己的 discovery 研究原本就要求走套餐白名单 | 模型计划 Phase 1：改为 catalog/manual，不把在线搜索当主路径 |
| Claude effort 控件视觉不一致 | trigger 高度/外层圆角/padding 已相同；effort 文字用 sans，model 用 mono；effort menu 强制 `rounded-lg`、窄宽度且缺少 model menu animation | 两个选择器没有共享 composer selector 的字体和 popover geometry contract | 模型计划 Phase 2 重新打开（Tier 0/1） |
| Claude“替我审批”要求 0.2.111 但读不到当前版本 | 磁盘安装确为 SDK 0.2.111，live capability API 却返回 `installedVersion:null` | `createRequire(__filename)` 在 Next/Turbopack route 中从 bundle chunk 定位，向上找不到真实 package manifest；Node 直跑单测未覆盖 bundled route | 权限计划 Phase 1 重新打开 |
| Codex 不支持“替我审批” | 当前 Codex 0.145.0-alpha.18 schema 已声明 reviewer；原 CodePilot runtime 未传字段且误受 Claude SDK 探测门控 | 已修：Runtime 分流 + 保守版本门 + start/resume 回显；旧版或回显不符显式降级 | 权限计划 Phase 2，真实审批 smoke 待跑 |
| Codex 自动命名能力 | 当前 schema 只有 `thread/name/set` / `thread/name/updated`，没有 generate-title 方法 | Codex 提供“写入名字”的 primitive，不提供轻量自动生成标题 API；桌面产品可能在客户端层实现，不等于 app-server 能力 | 标题计划 Phase 3 |
| Claude Code 任意模型很慢 | 最近三条第三方 Claude Code 会话分别 285s/206s 后被用户中止、111s 后返回 SDK `ede_diagnostic`（无 assistant 消息） | 当前开发机无 DNS；旧路径又丢弃 TTFT/result duration并允许首字前空等 10 分钟 | 已修应用侧：DNS 不可解析时约 3.2s 返回 NETWORK_UNREACHABLE；正常 result 持久化 TTFT/API/SDK/墙钟/重试/resume/terminal，真实成功 smoke 待 DNS |

## 权限模式

### 语义分层

| 用户选项 | 执行语义 | Claude Code | Codex | CodePilot Native |
|---|---|---|---|---|
| 需要时询问我 | 安全规则可自动通过，其余请求用户确认 | SDK `default`；当前仓库实际传 `acceptEdits`，行为比文案更宽 | approval policy `on-request` + reviewer `user`，保留 workspace sandbox | 现有 permission registry + rule engine |
| 替我审批 | Runtime 的 reviewer 对请求逐项批准/拒绝；不是 blanket allow | SDK `permissionMode: 'auto'`（0.2.111 类型已包含） | `approval_policy=on-request` + `approvals_reviewer=auto_review` 的等价配置 | AI SDK 7 无 session-level reviewer；只有 tool `needsApproval`，需 CodePilot 自建且先 POC |
| 完全访问 | 跳过权限检查，危险且需二次确认 | `bypassPermissions` + dangerous flag | danger-full-access / never-ask 等价组合，具体 wire 以 app-server schema 为准 | 现有 `bypassPermissions` |

改动前 DB 与调用链只有 `default | full_access` 二元语义；本轮已把 `auto_review` 扩进前端、API、继承、Bridge 与 Runtime wire。它仍是 Tier 2 权限改动，不是只加一个菜单项。

Codex 的 approval 与 sandbox 是两条独立轴：每个 `turn/start` 显式携带 `approvalPolicy` + `sandboxPolicy`，`thread/start/resume` 同时设置初始默认；`auto_review` 还需经过最低已验证版本门与 response echo。CodePilot profile 是会话真源，不写用户全局配置。

Claude 还有一个前置风险：当前 bare `allowedTools` 会在 permission mode / callback 之前自动批准整组工具。接 `permissionMode: 'auto'` 前必须把 mutating MCP 从 bare allowlist 移出，否则 reviewer 根本看不到这些请求。

### AI SDK 7 判断

仓库已经升级到 `ai ^7.0.11`、`@ai-sdk/anthropic ^4.0.5`、`@ai-sdk/openai ^4.0.5`。AI SDK 的 tool approval（agent 级 `toolApproval` 与工具级 `needsApproval` 两种入口，POC 需评估后选定接入点）可以表达“这个调用需要批准”和 approval round-trip，但不会替 CodePilot 提供 Claude/Codex 那种模型审批器。因此计划中 Native 分支必须满足二选一：

- 实现受限、可审计、fail-closed 的 reviewer；或
- UI 明确标记当前 Runtime 不支持“替我审批”，回退到按规则询问。

不得为了界面一致把 `needsApproval: false` 当成 auto reviewer。

## 自动会话命名

### 当前事实

- 新对话直接发送：`src/app/chat/page.tsx:861-875` 创建 session 时用 `content.slice(0, 50)`。
- 先创建空会话再发送：DB 默认 `New Chat`，首个真实用户消息后由 `src/app/api/chat/route.ts:353-359` 截断 50 字。
- 两条路径的省略号、刷新时机和事件通知不一致；顶部标题可能停留在 `New Chat`，侧栏最多等轮询刷新。
- 第三条截断链路：导入会话 `src/app/api/claude-sessions/import/route.ts:50-56` 同样 slice(0,50)+省略号，应一并收编进统一纯函数（origin 记 `import`，不参与语义重命名）。
- 现有主链路截断基于发给模型的 `content` 全文而非 `displayOverride`，标题可能包含 `[Referenced Directories]` 等隐藏展开段（隐私瑕疵，Phase 0 修复）。
- 系统会话（Bridge / task / heartbeat / worktree）和导入会话已有显式标题，不应被自动生成覆盖。
- `updateSessionTitle` 是无条件 UPDATE，当前没有 `title_origin`、claim 或 CAS；异步生成会覆盖用户手动改名。

### 推荐合同

1. 首条真实、可见、非 autoTrigger 用户消息持久化后，立即生成确定性 fallback 标题。
2. 语义标题在首轮主回答完成后后台生成，不阻塞正文首 token。
3. 标题 prompt 只使用用户可见文本（优先 `displayOverride`），不读取附件内容/路径、system prompt、thinking、tool result 或隐藏的 skill expansion。
4. 只使用当前 session 的 provider；禁止复用会跨 provider 回退的 auxiliary resolver。
5. 增加 title provenance + 原子更新：只允许 `fallback -> generated`，manual/system/import 永远不可被异步结果覆盖。
6. 超时、离线、限流、空输出都静默保留 fallback；每 session 最多一次、禁 tools/MCP/联网/高推理。
7. 本地 `chat_sessions.title` 是 canonical；如需同步 Codex thread，只做 `thread/name/set` best effort，失败不回滚本地标题。

## 官方来源

- [GLM-5.2 模型](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2)
- [GLM Claude Code 适配与 effort 映射](https://docs.bigmodel.cn/cn/guide/develop/claude)
- [Kimi Code 概览（三个当前模型 ID）](https://www.kimi.com/code/docs/)
- [Kimi 模型配置（K3 / kimi-for-coding / highspeed 的独立合同）](https://www.kimi.com/code/docs/kimi-code/models.html)
- [OpenAI 模型目录（GPT-5.6）](https://developers.openai.com/api/docs/models)
- [Claude 最新模型总览](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Claude Sonnet 5 迁移说明](https://platform.claude.com/docs/en/about-claude/models/whats-new-sonnet-5)
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [AI SDK Tool Approvals](https://ai-sdk.dev/docs/agents/tool-approvals)
- [Codex 配置参考（approval / reviewer / sandbox）](https://learn.chatgpt.com/docs/config-file/config-reference)（原 developers.openai.com/codex/* 已 308 迁移至 learn.chatgpt.com/docs/*）
- [Codex app-server API](https://developers.openai.com/codex/app-server/)（同上，已迁移至 learn.chatgpt.com/docs/*）
- [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)（原 platform.claude.com 路径已 307 迁移）
- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

## 尚待真实凭据验证

- GLM-5.2 CN / Global Coding Plan 的 alias、`[1m]` 变体和两档 wire 映射。
- Kimi 展示名保持 `Kimi for Coding`，wire 固定 `kimi-for-coding`；逐档验证 Low/High/Max、Auto 省略、`queryOptions.effort` 与 `CLAUDE_CODE_EFFORT_LEVEL` 优先级。不得用展示名改变 wire ID。
- GPT-5.6 在真实 Codex Account 登录下的 entitlement、全部 reasoning levels 和 turn/start 参数。
- Sonnet 5 / Fable 5 在 Claude Code 与 Native 两条路径的 thinking/effort/sampling 请求形状。
- Claude/Codex auto reviewer 的批准、拒绝、超时、不可用和审计事件。
- Codex `item/permissions/requestApproval` 的 response 形状：当前统一返回 `{ decision }`（`approval-bridge.ts:275-293`）是否被上游接受；GrantedPermissionProfile 的正确形状。
