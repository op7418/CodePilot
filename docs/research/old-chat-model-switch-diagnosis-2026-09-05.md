# 旧聊天切换模型失败：复现与修复

状态：Code complete / Tests pass / 本轮旧聊天路径 Smoke passed；未发版。基线：`9bef7299` / v0.67.13。

## 用户要求

升级后，旧聊天切换模型提示“Runtime、服务商和模型没有保存成功”。用户明确要求：只锁定 Agent / Runtime；同一旧聊天必须能切换不同服务商的兼容模型，保留聊天 ID、历史及页面。不创建、导入或跳转到新聊天。

## 已确认的原因

1. Codex continuation policy 把换 Provider 定义为 `new_session`。bound 聊天在 route API 返回 `409 ROUTE_REQUIRES_HANDOFF`，而模型选择器允许选择，UI 又将拒绝压成通用保存失败。真实 Dev 旧聊天 GPT → DeepSeek 已复现，两个 Runtime 均为 `codex_runtime`。
2. 路由校验只查已落库的 `provider_models`，而模型列表和执行 resolver 都允许当前 catalog 的未落库模型，导致 `INVALID_ROUTE_MODEL`。隔离 handler 和回归用例确认；先打开模型管理页使目录落库会掩盖问题。
3. Codex Account 校验只读当前路由模块的内存缓存。实机在 DeepSeek 回复后切回 GPT 时再次报 `INVALID_ROUTE_MODEL`，独立模型接口仍返回该 GPT 模型。当前路由没有目录缓存不能证明模型不可用；显式选择应允许有时限的模型发现。

这些逻辑没有 Windows 分支；同服务商切换的真实旧聊天对照成功，因此不能据此声称每一种旧聊天、每一种模型组合都会失败。

## 修复

- Codex 同 Runtime 换 Provider 改为 `replay_context`。路由只修改原聊天的 Provider+Model，保留 owner、ID 和消息。
- Codex adapter 在无法复用底层执行 thread 时，消费原聊天摘要和经过压缩边界过滤的最近历史。复用成功时只提交当前输入；复用已有的历史归一化/token budget 逻辑，不复制产品消息。
- 只有新执行 thread 首轮被接受后才替换 ref。启动/输入失败保留旧 ref，重试重新带入上下文；切回旧 Provider 使用当前聊天最新历史。
- route 校验复用 execution resolver 的 DB + catalog 视图，继续拒绝手动隐藏、不存在、不兼容及凭据不可用的路线。显式 Codex Account 选择允许 2500ms 上限的发现；recovery safe mode 和被动全量 feed 继续不启动 Codex。

## 实际验证

使用当前工作区 `npm run electron:dev`，通过 computer-use 操作真实旧聊天。未新建或导入产品聊天。

| 场景 | 结果 |
| --- | --- |
| 修复前：8 月 26 日“问候”，CodePilot，GLM-5.3 → Flash → GLM-5.3 | 两次 PATCH 200，同服务商对照正常 |
| 修复前：8 月 4 日 Codex 账号旧聊天，Sol → Terra → Sol | 两次 PATCH 200，同服务商对照正常 |
| 修复前：同一 Codex 账号旧聊天，Sol → DeepSeek V4 Flash | PATCH 409 / `ROUTE_REQUIRES_HANDOFF` |
| 修复后：同一旧聊天 GPT → DeepSeek → GLM → DeepSeek → GPT | 每步最终保存成功；始终同一聊天及页面，Runtime 固定 Codex |
| 切到 DeepSeek 后实际发送一条历史核对消息 | 模型正常回复并准确复述切换前第一条用户消息；本机 proxy 与 chat 请求终态均为 200 |
| DB 核对 | 聊天总数始终 587；目标旧聊天原有 9 条消息保留，实际 smoke 新增一问一答后 11 条；已切回原 GPT 模型，route revision 为 6 |

诊断阶段 GLM 对照聊天回到原模型时使用选择器的稳定 ID `sonnet`（原保存值是上游 ID `glm-5.3[1m]`），语义一致；两次正常选择使 revision 加 2。

## 自动化与防回归

- `old-chat-model-route.spec.ts`：同一个 case 覆盖 Claude Code、CodePilot、Codex 三个 Runtime 的同/跨 Provider 切换，校验 ID、URL、消息内容与聊天总数不变；跨 Runtime 仍返回 `RUNTIME_OWNERSHIP_CONFLICT`。目标 Provider 不预先访问模型管理页。
- 该跨 Provider case 修复前在 Codex 分支 RED（409），修复后 GREEN；目录未落库用例修复前 RED（`INVALID_ROUTE_MODEL`），修复后 GREEN。
- `codex-thread-continuation.test.ts`：同 Provider resume、跨三种 Provider、MCP 变化、resume 失败、历史一次性注入、启动/输入失败重试、切回后保留期间历史、图片输入。
- `runtime-route-validation.test.ts`：目录模型、隐藏/不存在/不兼容模型、Codex 冷缓存发现、recovery safe mode。
- 完整 `npm run test`：5475 pass / 0 fail / 1 既有 skip；最后补充启动失败用例及强化断言后的定向 17/17。类型检查、Harness boundary 通过。
- E2E 合跑本轮模型切换及前一项 GLM 身份冲突回归：3/3 通过。
- Runtime / Composer guardrail、执行计划和技术交接同步。没有 schema 变更或发布操作。

这里只确认本轮模型切换与一次真实历史承接，不能代替相邻计划的跨 Runtime handoff、三引擎长历史/压缩及缓存成本矩阵。
