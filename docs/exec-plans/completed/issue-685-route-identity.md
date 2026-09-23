# #685 连续对话路由身份修复

> 创建时间：2026-09-14
> 最后更新：2026-09-14
> 状态：Shipped — v0.67.16；平台无关路由身份修复已发布，Windows 真机及其他同码来源仍待验证。

## 背景与取舍

用户在 Windows 多模型遇到第二轮 MESSAGE_ROUTE_MISMATCH，重选后暂时恢复；Mac 实际使用未遇到。隔离诊断已在 macOS 用 MiMo、MiniMax、Anthropic catalog 复现：SDK status.model 覆盖 committed model，前端仍发送 alias，严格字符串比较拒绝。该逻辑不依赖平台，实际双机差异尚未确认。[诊断](../../research/issue-685-message-route-mismatch-2026-09-14.md)。

用户结果：连续聊天不再因 Runtime 回报实际模型名而要求重选；旧版已经写成 upstream 的会话可在同 Provider 中按唯一 live catalog 映射继续。模型/Provider 真变化仍要求显式 route CAS。

保留用户已选路由，collector 不再写 model；实测模型仍由运行事件/usage 提供。旧会话采用只读身份兼容，不批量迁移数据库、不改变 revision/owner。只接受 stored upstream → 唯一 live row 的 modelId，拒绝共享 upstream 的歧义和 distinct modelId 之间的替换；provider 必须完全一致。禁止删掉 route mismatch gate 或按名称猜模型。无 schema/UI 改动，既有未提交保存失败修复保持原样。

## 状态总览

| Phase | 内容 | 状态 |
|---|---|---|
| F1 | collector 保持路由与旧会话安全匹配 | ✅ 已完成 |
| F2 | 连续回合、存量会话与错路由反例，full tests | ✅ 已完成（targeted 27/27；full 5571 pass / 1 skip） |
| F3 | 护栏与诊断记录回写 | ✅ 已完成 |

## 执行清单

- [x] F1：移除 SDK model 路由写回；same-provider 唯一 upstream 兼容。
- [x] F2：MiMo/MiniMax/Anthropic 连续与历史 canonical，会话 owner/CAS 不变，hidden/ambiguous/provider mismatch 反例；full tests。
- [x] F3：更新 Runtime/Composer/StreamSession 护栏及诊断记录。

## 决策日志

- 2026-09-14：工作区未提交。选择只读兼容旧 route 表示，不为恢复同一模型偷偷写 route_revision。修复后不宣称已解决所有 Windows 同码来源；真实 Windows/MiMo packaged 验收仍单列。

## Smoke Ledger

| Date | Runtime / Provider | 场景 | Result | Evidence |
|---|---|---|---|---|
| 2026-09-14 | 真实 POST/DB + Runtime fixture | 双回合与存量 upstream 路由 | ✅ 3/3 | 无真实用户凭据调用，非 packaged smoke |


## 实施与验证记录

- 2026-09-14，未提交：F1/F3 完成。collector 只持久化 SDK ref，不写 model；message route helper 固定 Provider、拒绝 true mismatch，legacy compatibility 使用 live enabled catalog 的唯一 upstream proof，附 Runtime 兼容性。无 UI、schema、构建或 Provider resolver 通用行为修改；没有改动此前未提交补丁的范围外逻辑。
- 初轮定向 17/17；真实 HTTP handler fixture 初次用裸 Node Response.text 读取 route 字符串流报 non-Uint8Array（测试消费层差异），改为直接 reader 后 3/3；没有改变产品 SSE。Runtime transport 使用受控 fixture，其余 POST、锁、持久化、catalog 实现真实。
- 首轮全量受沙箱 loopback listen EPERM 阻断（8 fail），允许本地端口后 5570 pass / 0 fail / 1 skip。随后补 Runtime 兼容与 Provider 缺省边界：新 Native fixture 起初未回显 provider，暴露 session-only resolver 的 inactive provider fallback；helper 现在固定 requestProviderId=session.provider_id，保证匹配证据不来自其他 Provider。最终 targeted 27/27（约 0.6 秒），full tests 重跑中。
- 全部 fixture 使用 db-isolation.setup 临时 SQLite 与虚构 key，HTTP fixture 禁止外网 fetch。未使用真实 Provider 认证、未执行 Windows packaged 或 Mac GUI smoke；本次没有前端改动，验证集中在真实 POST 双回合和 collector/DB。

| Date | Runtime / Provider | 场景 | Result | Evidence |
|---|---|---|---|---|
| 2026-09-14 | Claude / MiMo、MiniMax、Anthropic；Native/Codex 兼容矩阵 | 三回合/重开/历史 upstream、hidden/ambiguous/不同 Provider 与 Runtime | ✅ 27/27 定向 | `/tmp/codepilot-685-targeted-final.log` |
| 2026-09-14 | 真实 POST/SQLite + 模拟 Runtime SSE（无云端调用） | 新 route 与历史 upstream 两次连续发送，回复与历史保存；错路由无副作用 | ✅ HTTP 3/3，已计入 27 | `chat-message-route-http.test.ts` |

## 验证边界与后续

- Code complete / Tests pass 不等于 Windows 真机问题全部关闭。用户双机差异与任何非此链条的同码失败仍未定因。
- 旧会话映射有歧义、已隐藏或已改映射时，保持可见拒绝并要求显式重选；不保证所有历史字符串都能自动恢复。
- 未执行 commit、push、release 或外部 Issue 状态修改。待独立复审和后续用户授权发版；生产停增需在包含修复的新版本观察。


最终验证（2026-09-14，未提交）：`npm run test` EXIT=0，typecheck + harness boundary + 5572 tests：5571 pass / 0 fail / 1 existing skip（29.6s，`/tmp/codepilot-685-full-final.log`）。scoped ESLint 0 error / 5 处既有 warning；hooks、docs-drift、diff 检查通过。本次 F1/F2/F3 全部完成，计划归档，独立复审与正式包真机验收仍是后续边界，不标记 Review passed / Smoke passed / Shipped。

## v0.67.16 发布回写（2026-09-18）

修复随 `17c716c6` / `v0.67.16` Shipped；[正式 CI](https://github.com/op7418/CodePilot/actions/runs/35357476827) 全部成功，[Release](https://github.com/op7418/CodePilot/releases/tag/v0.67.16) Latest / immutable 和 20 项资产均已复核。最终全量 5584 pass / 1 skip，原路由定向测试包含在内。Windows MiMo/MiniMax 连续三轮与重开仍待真实包验收；升级后无唯一映射的旧会话需重选，已写进 Release Notes。生产反馈是否停增尚未验证。
