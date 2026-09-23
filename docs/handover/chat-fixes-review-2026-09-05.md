# 本次聊天全部修改：Claude 独立审查文案

请审查本次提交相对父提交 `9bef7299` 的全部差异，不只审查最后一轮 Astra 修复。先阅读仓库 `CLAUDE.md`、相关 guardrail，再独立核对代码与测试；本文记录背景和待核对点，不是已经通过审查的结论。当前工作区有另一个任务的官网改动，审查以此次提交的 diff 为边界，勿把未提交的官网/README/图标改动混进来。请先出审查结果，不直接改代码、push 或发版。

## 用户问题与关键取舍

1. Windows 用户添加 GLM-5.3-Flash 时提示 `haiku` 身份冲突，但角色映射里的 Haiku 未设置；其 Codex 列表也没有 GPT-5.6。已确认“模型记录身份”与“角色映射”不是同一件事。旧行来源、该用户缺 5.6 的最终根因没有充分证据，不能猜测迁移或自动删除模型。本轮只修确定的 UI 缺陷：查看冲突记录时清筛选、包含隐藏项、定位实际冲突行，并纠正文案。
2. 更新后旧聊天普遍无法切换模型，新聊天正常。用户反复明确：已有聊天锁定 Runtime 可以接受，但同 Runtime 必须继续支持切换不同 Provider 和模型，绝不通过创建/导入新产品聊天绕过。这不限于 DeepSeek；三 Runtime 都要遵守。Codex 底层 thread 绑定 Provider，必要时可重建底层 thread，但产品聊天 ID、页面和消息不变，并承接已有历史；不能切回旧分支或提前覆盖仍可重试的旧 ref。
3. 对 GPT-5.6 前一晚修复的复审又确认两项 P2：预算充足时仍因最近 200 条和单条字符截断丢需求；重建 thread 时旧图片消失。因此继续修复预算分页、summary boundary 和安全附件恢复，不仅验证短聊天切换成功。
4. Astra 接入和 OpenCode 最新实现对照确认：独立 OpenAI OAuth 固定目录滞后、SDK 丢 Astra reasoning、并发刷新/临时断网会清凭据。API 的 1.05M 不能套用为 Codex 默认窗口。Codex 目录默认 272K、95% 有效为 258400，最大原始窗口 872K；显式 override 必须先 clamp 再计算。独立 OAuth 与 Codex Account 使用不同凭据，目录可见不等于账号生成 entitlement。

## 按实际行为核对

### GLM 冲突恢复

- `ModelsSection.tsx` / `OpenRouterSearchDialog.tsx` / 中英文文案：查看冲突能显示隐藏记录并定位；正常关闭不能改变筛选；focus 恢复不能把页面拉回 Add 按钮。
- 恢复入口只揭示真实记录，不改用户模型数据、角色映射或身份迁移条件；冲突 ID 以服务端为准。

### 旧聊天路由与 Codex 续接

- `runtime/route-validation.ts` 的校验目录是否和执行 resolver 一致：catalog 尚未落库仍可选，用户隐藏/编辑不被覆盖，精确 Provider+Model 不串线；Codex 冷缓存只做有界发现，recovery safe mode 不被绕过。
- 同 Runtime 跨 Provider 原地切换，跨 Runtime 仍按 owner 拒绝；CAS/revision、权限、MCP 参数不能因重构遗漏。`continuation-policy.ts` 不得重开自动 handoff/new-chat 路径。
- `codex/thread-continuation.ts` / `runtime.ts`：新 thread 的首轮确实消费历史；成功 resume 不重复重放；`turn/start` 接受后才更新 ref；失败重试仍保留历史，切回 Provider 不复活陈旧分支。
- `codex/continuation-context.ts` / `fallback-context.ts`：>200 条短消息、长用户需求、summary coverage boundary、rowid/session 隔离、预算不足和当前 prompt 去重。不能用 5000/1000 字符限制抢先删预算内内容；抽取共享 helper 不得改变原 Claude fallback 语义。
- 图片只从用户消息前缀元数据恢复；文件必须存在并通过真实项目目录 containment/realpath 校验，只有目标明确支持 vision 才发送历史图片。缺文件/能力未知有明确降级，不重放预算外图片，不解析 assistant/tool 文本中的伪附件。

### OpenAI OAuth / Astra

- `openai-oauth-manager.ts`：并发只刷新一次、generation/refresh-token 所有权、退出/取消/重登录期间的晚到响应、更新事务失败回滚、refresh token 缺省时保留旧值；永久错误才清凭据，网络/429/5xx/未知 4xx 保留并可重试。不要只验证 happy path。
- `openai-oauth-models.ts`：使用独立 OAuth 自己的凭据；缓存跨账号失效、成功空目录不补回、失败降级不伪装 entitlement。核对静态能力来源、陌生型号、未知 effort、超时/冷却、请求频率与刷新失败对整个模型 feed 的影响。
- `agent-loop.ts` / `ai-provider.ts` / Codex `unified-adapter.ts`：所选 Astra max 确实进入最终 SDK 请求；不能只测 helper；未知能力不强开，不静默降为 medium。bearer/account/residency 只发往允许 endpoint，不随 redirect 或自定义地址外传。
- `codex/models.ts`：分页去重、异常 cursor 有界、inputModalities 映射；窗口读取使用 CodePilot-owned home 和项目 cwd 的 effective config，默认/上限/配置 override/实际 usage 的含义不混淆。被动 feed 不因窗口查询启动 Codex；超时降级不能冒充实测。
- `model-context.ts` / `/api/chat`：API 1050000 与 Codex 258400 分开，较小 override 和最大值 clamp 有效，跨模型/Provider 不能复用错误容量；原有运行时实际 usage 仍优先。`ultra` 涉及自动委派，继续保持通用菜单的原边界。

## 证据入口与验证要求

执行计划：
- `docs/exec-plans/active/runtime-thread-ownership-and-handoff.md`
- `docs/exec-plans/active/astra-openai-oauth-compatibility.md`

原始诊断/复审：`docs/research/windows-model-feedback-diagnosis-2026-09-04.md`、`old-chat-model-switch-diagnosis-2026-09-05.md`、`gpt56-fixes-review-2026-09-05.md`、`astra-fable51-adaptation-2026-09-05.md`。文内早期失败是历史证据，修复状态按后续记录和当前代码判断。

最近完整验证：typecheck + Harness boundary + 单测 5508 pass / 1 skip；旧聊天模型切换与 GLM conflict 浏览器 E2E 3/3。提交 hook 会对暂存内容再次执行 lint、类型检查和完整单测。请自行复核这些测试是否真正覆盖风险，必要时补有判别力的反例。

建议复跑：

```sh
CODEX_DISABLED=1 npm test
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3136 npm run test:e2e -- src/__tests__/e2e/old-chat-model-route.spec.ts src/__tests__/e2e/model-identity-conflict.spec.ts --workers=1 --reporter=line
```

E2E 使用隔离数据库，不能指向日常 Dev 数据；不通过真实用户聊天写入来伪造 smoke。优先核对本提交新增的 `runtime-route-validation`、`codex-thread-continuation`、`codex-continuation-context`、`openai-oauth-compatibility` 和修改的 `codex-models-dual-schema` 单测。

边界：独立 OAuth 本机未登录，真实 token rotation、Astra 生成/工具/长上下文、历史图片的真实模型识别尚未完成；Windows 原用户缺 5.6 的最终根因仍未确定。Fable 5.1 仅做了调研，没有完成本轮产品适配，不能因为报告名称而判断已经支持。外部源码位于临时目录，跨机器可能不存在；报告已保存官方仓库 commit permalink。原始用户日志、截图、真实凭据没有提交。

## 输出

按 P1/P2/P3 列出具体问题、提交内文件/行号、触发路径、用户影响、最小复现和建议修复。区分本次引入、原有问题及未验证风险。不要只凭文档或测试通过关闭 finding，也不要把合理保守降级误报成静默数据丢失。最后给出能否合并/是否存在 blocker 和仍需真实 smoke 的清单；若无 actionable finding，明确说明检查范围及剩余验证边界。


## 审查后的追加修复（2026-09-05，工作区）

用户再次授权修复。关键取舍：不采纳 unknown visibility 默认可见；不静默降 effort；保持原聊天同 Runtime 切模型。新增 OAuth 非阻塞目录与 pending 后刷新、模型选择错误中英文恢复、代理参数错误封装，以及 Codex replacement 经运行中 client 有界恢复模型能力。代理真实 SDK 请求捕获现已补齐（原报告前文称两条 wire 已测、后文又承认代理缺测试，以后文缺口为当时事实）。

Fable 5.1 现在已作为独立精确模型接入：共享目录/第一方 upstream/1M 窗口及五档 effort/high 默认；沿用已正确的 adaptive sanitizer。Native 双步 SDK wire 测试覆盖 prefix 与签名原样保留，旧回合重建/换模型不带旧思考签名；不扩展未验证 beta 功能或改默认模型。

验证：全量 5518 pass / 1 skip，隔离 Dev E2E 2 pass；新 `fable-5-1-model.test.ts`、`fable51-review-followup.spec.ts` 及 OAuth/Codex 追加反例是重点。完整进度/日志/真实账号未验证边界见 [执行计划](../exec-plans/active/astra-openai-oauth-compatibility.md)。
