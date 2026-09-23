# 2026-09-05：GPT-5.6 昨晚修复复审

范围：当前工作区相对 `9bef7299` 的 GLM 冲突定位、旧聊天模型路由校验、Codex 同 Runtime 跨 Provider 续接及对应测试。官网/图标/README 等其他任务改动不在本次审查范围。初次审查仅补记录；下方保留当时发现，文末追加用户授权后的修复结果。

初次审查结论：**Tests pass，尚未 Review passed**。普通旧聊天切模型路径、Runtime 锁定、失败首轮保留旧 native ref、GLM 清筛选与冲突定位未发现新的阻塞问题。Codex 新增历史重放发现两项 P2；后续修复状态见文末，不覆盖初次审查事实。

## R1 / P2：有充足预算仍静默丢弃旧文本上下文

- 新增调用点：`src/lib/codex/runtime.ts:1111` → `src/lib/codex/thread-continuation.ts:49` → `src/lib/fallback-context.ts:25`。
- 触发：Codex Runtime 下跨 Provider 切换，或 MCP 变化/resume 失败导致重新建立底层 thread；同 Provider 正常 resume 不走此路径。
- `/api/chat` 只取最近 200 条 DB 消息，扣除本轮后剩 199 条，未处理 `hasMore`。Codex 压缩由 Runtime 管理，通常没有 CodePilot `context_summary` 可补前面的历史。共享 fallback 又在预算筛选前按单条 5000/1000 字符截断用户与助手文本。
- 隔离复现：300 条历史仅约 4196 tokens，设 100000 token 预算；调用生产 `getMessages` 和新增 continuation helper 后，最早需求标记不在 `turn/start` 输入，最近消息仍在。另以一条 9038 字符（约 2260 tokens）的近期用户消息复现，中间需求标记也不在输入。均不涉及模型猜测，直接核对发往 Runtime 的输入。
- 影响：界面保留完整旧聊天，但切模型后忽略此前需求/约束，且上下文额度尚未用完。这是旧 fallback 限制被本次扩展到正常 Codex 跨 Provider 切换的路径，不能将短对话 smoke 当成长历史验证。
- 修复方向：正常 provider 续接按实际预算加载所需历史，并保留预算内用户文本；需要摘要时明确其覆盖范围，不依赖未生成的 DB summary。补 >200 条短消息、近期长需求、已有 summary 边界回归。

## R2 / P2：旧图片没有进入重建后的底层 thread

- 新增调用点：`src/lib/codex/thread-continuation.ts:55`，输入来自 `src/lib/codex/runtime.ts:1110` 的本轮 files。
- 触发：旧聊天已有图片，切换到另一个支持图片的 Provider/模型后，用户要求继续检查之前的图；即使只有两条历史也成立。
- DB 历史图片引用存在 `<!--files:...-->` 中。新续接走 `normalizeMessageContent` 将其删除，然后只把本轮 files 传给 `buildCodexTurnInput`，因此旧图片的内容和路径均没有进入新 thread。
- 隔离复现：使用生产持久化格式的两条历史（用户图片元数据+文字、助手确认），本轮只发“再看一下那张图”。捕获 `turn/start` 输入只有一个 text block，image/localImage 数量为 0，原图片路径也不存在。本用例验证输入组装，不调用真实视觉模型，也不声称图片识别 smoke 通过。
- 影响：新模型无法从本轮上下文重新检查原图，只能依赖旧助手文字描述。与 R1 的文本分页/截断不同，即使完整加载这两条消息仍会丢图片。
- 修复方向：在新 thread 续接中恢复可用的历史附件引用/视觉输入，遵守目标模型能力和附件边界；缺失文件或不支持视觉时明确降级。补历史图片和本轮图片同时存在、正常 resume 不重复重放的回归。

## 验证与证据

| 验证 | 结果 |
|---|---|
| `npm run test` | 5476 pass / 0 fail / 1 skip，含 typecheck |
| 7 个定向 Runtime/route/continuation 单测文件 | 73/73 pass |
| `npm run test:e2e -- old-chat-model-route.spec.ts model-identity-conflict.spec.ts --workers=1 --reporter=line` | 3/3 pass |
| 隔离上下文输入复现 | R1 / R2 均确认；真实用户 DB 未参与 |
| `git diff --check` | 通过 |

本机复现脚本：`/private/tmp/codepilot-56-review-context.mts`，运行 `node --import tsx /private/tmp/codepilot-56-review-context.mts`。脚本首先加载项目 DB isolation setup，以合成消息和 Runtime 回调捕获输入，不请求模型。输出：`/private/tmp/codepilot-56-review-context.log`；测试日志分别为 `/private/tmp/codepilot-56-review-full.log`、`/private/tmp/codepilot-56-review-targeted.log`、`/private/tmp/codepilot-56-review-e2e.log`。临时文件不保证跨机器存在，关键结果已记录于本文。

未纳入新 finding：Picker 异步保存与立即发送之间的竞态在本轮前已存在，当前无证据证明由这批修复引入。Windows 缺少 GPT-5.6 的原反馈仍没有完成定因，本轮模型发现校验修复不能作为它已修好的证明。

闭环入口：[Runtime 执行计划](../exec-plans/active/runtime-thread-ownership-and-handoff.md)。

## 用户授权后修复（2026-09-05）

- R1 已落地：新增 Codex continuation context，从 caller history 的 rowid snapshot 向前分页，限定同 session 和摘要边界；按预算保留完整文本，关闭此路径的固定字符截断。未扩大 Claude fallback 范围，未修改用户 DB 消息。
- R2 已落地：从历史 user 消息恢复经真实项目目录校验的图片。声明支持视觉时附加 localImage；不支持/未知则保留安全文件引用并标注像素未附加，缺失/越界标注 unavailable；正常 resume 不重复注入。
- RED：新增 9 项回归在修复前 7 fail / 2 pass，覆盖两项已确认缺陷。
- 定向验证：8 个文件 82/82 pass；全量 5485 pass / 0 fail / 1 skip（含 typecheck/Harness boundary）；相关 E2E 3/3；ESLint 无新 error（仅 claude-client 的 3 个既有 unused warning）。新增测试的 Windows junction/路径断言兼容调整后另跑 9/9。最终日志 `/private/tmp/codepilot-continuation-full-final.log`，其余为 `/private/tmp/codepilot-continuation-{targeted,e2e,lint}.log`。
- 验证范围是隔离 DB、真实临时图片文件和生产输入构建函数的 Runtime 输入捕获；未使用真实视觉模型验证识图回答，不将自动化验证标为真实视觉 smoke 或独立 Review passed。
