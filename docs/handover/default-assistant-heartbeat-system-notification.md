# 默认助理 → 心跳 → 系统通知：技术交接

> 对应产品思考：[为什么这条 P0 必须做成纵向闭环](../insights/default-assistant-heartbeat-system-notification.md)
> 执行计划：[P0 默认助理、心跳与系统通知](../exec-plans/active/default-assistant-heartbeat-system-notification.md)

## 1. 最终边界

这次交付不是 Memory vNext，也没有把 Assistant Workspace 自动迁移成 Harness Home。它只打通一条用户可见路径：没有设置的新用户获得自己的默认助理目录；用户显式开启心跳后，由唯一 scheduler 运行；有事才写助理消息并创建 durable notification；Electron Main 领取系统通知并在点击后回到应用内目标。

老用户任意非空 `assistant_workspace_path` 都 no-touch。目录无效或暂时离线也只显示修复，不会偷偷切到默认目录。

## 2. 默认助理数据流

```text
Renderer GET workspace(ifUnconfigured)
  → preload.getDefaultAssistantHome()        // 无输入 IPC
  → Electron app.getPath('documents')
  → bootstrapDefaultAssistantWorkspace()     // process single-flight
  → initializeWorkspace()                    // 幂等、不覆盖
  → compareAndSetSettingIfBlank()             // commit-time CAS
  → CAS loser 读取显式 workspace，不删除刚建空目录
```

新目录的规则真源是 `instructions.md`，并生成带 provenance hash 的 `CLAUDE.md` / `AGENTS.md`，让目录离开 CodePilot 后仍可被两个原生客户端发现。mirror 仍等于上次生成内容时才随 canonical 更新；任一被手动修改或原本就是 unmanaged 文件，整组停止覆盖，Settings 显示冲突。用户需先把要保留的内容合并回 `instructions.md`，再删除冲突 mirror，后续助理对话会重建。无 canonical 的旧 workspace 继续只读 legacy 文件，不自动迁移。

真实 Claude CLI POC 证明 project `CLAUDE.md` 会由 SDK 的 `settingSources=project` 原生装载，因此只有 env Claude + clean `CLAUDE.md` 时省略 rules fragment；soul/user/session 仍进入 system prompt，Claude DB provider 继续由 CodePilot 注入 canonical。Codex 对非 git cwd 与 `project_doc_max_bytes=0` 的 native discovery 尚无真实证据，所以即使 `AGENTS.md` clean，也始终把 canonical rules 随 assembled system prompt 送进 app-server `developerInstructions`。mirror 冲突时不覆盖用户版，Assembler 保留 canonical，明确接受 Runtime 可能同时原生加载用户版的保守双投递。

默认初始化不创建 session、不调用模型、不启用 heartbeat、不发通知。侧栏为 configured-but-empty workspace 渲染助理入口，用户点击后才创建第一条真实会话。

## 3. Heartbeat 的四个事实源

| 层 | 事实源 | 内容 |
|----|--------|------|
| 用户内容 | `HEARTBEAT.md` | 检查什么 |
| 用户意图 | `.assistant/state.json` | enabled、interval |
| 调度运行 | `scheduled_tasks`, `task_run_logs` | task、next run、attempt、错误、耗时 |
| 提醒投递 | `notification_events`, `notification_deliveries` | alert、channel、claim、attempt、OS accepted/error |

workspace PATCH 顺序为 desired 原子写入后 reconcile。reconcile 确保 exact `source='assistant_heartbeat'` 为 0/1 row；旧 duplicate 会先重关联 run/event，再合并并创建 partial UNIQUE index。cadence 不变时保留 future `next_run`，用户更改 cadence 时保留 task id 并重算。

runner 在创建 session、选择 Provider 和产生通知前重新读取 desired。disabled、workspace mismatch 或不可验证时记 `skipped_reconcile_drift`；空 checklist 记 `skipped_empty`。两者都不能到 Provider policy boundary。定时触发和“立即检查”统一进入 `runScheduledTaskNow` 的 DB row lock，避免重复费用。

silent 只有一种定义：trim 后严格等于 `HEARTBEAT_OK`。silent 留 run evidence，但不写 assistant message、不创建 notification event。其余输出是 speak-up，同时关联 run、session 与 event。普通 `/api/chat` 的 `autoTrigger` 不再有 heartbeat 特权。

## 4. Durable native notification

```text
notification event + per-channel delivery
  → POST /api/tasks/notify/claim
  → Electron Main claims electron-native
  → deliverNativeNotification waits lifecycle
  → POST /api/tasks/notify/ack with owner token
  → delivered(OS accepted) or retry/error
```

所有新 Notification Manager 事件无论 priority 都只写 `electron-native`，Electron Main 始终是唯一 consumer，不随窗口 visible/hidden 切换；Renderer 不再挂 notification delivery poll，页面 toast 只负责操作反馈。claim 用 additive owner/time/attempt/backoff columns，现有 delivery status 枚举不变；stale lease 可恢复，最多三次后 terminal error。当前单次 native lifecycle timeout 为 12 秒、stale claim lease 为 30 秒；调整前者时必须同步复核后者并保持 `timeout < lease`，避免同一 delivery 在首次系统回调仍未收口时被重复领取。

旧版本曾把页面通知 payload 放在进程内队列，却把 delivery 长期留为 `queued`。durable consumer 首次上线若直接领取，会把数月前的测试通知当成新提醒重放。第一层迁移只在首次执行时把超过 1 小时的遗留 queued 行改为可审计 skipped；第二层退役迁移把仍可执行且只有 renderer channel 的 queued 行原位改成 native，若同 event 已有 native peer 则只收口冗余 renderer row。两层都保留 event/delivery 审计且可重入。

交互聊天的两个核心通知由服务端 `collectStreamResponse` 统一触发：`permission_request` 按 request id 去重后创建审批通知；任务完成只有 successful result、assistant terminal 已持久化、当前 lock owner 三项同时成立才创建。失败、停止、autoTrigger、stale owner 不通知完成。锁屏文案仅含 bounded 会话名和 tool name，不包含 tool input、路径或模型正文；点击 action 回到 `/chat/<sessionId>`。

所有平台以 Electron `show` event 作为 OS accepted；共同处理 throw、unsupported 和 12 秒 timeout，Windows 额外处理 `failed`。Electron 40 的 macOS unsigned dev 可能触发 `show` 却不进入 Notification Center，因此 Main 在 `!app.isPackaged` 时以稳定错误码 fail-closed，设置页明确要求 signed CodePilot package；不再把 dev 结果写成 delivered。macOS options 使用 `silent:false + sound:'default'`，Windows/Linux 服从平台默认。代码和单测不替代 signed/installed packaged 声音证据。

已 show 的 Electron Notification 对象在 click/close 前进入有界 retention，避免 JS wrapper 提前回收导致点击丢失；TTL 和数量上限避免常驻应用无限持有。点击 action 先校验为内部 route，heartbeat speak-up 明确写入对应 `/chat/<session>`；renderer 未 ready 时进入有界队列，ready handshake 后按 event id 幂等送达。测试通知也走真实 DB 和 Main consumer，但只跳回设置页，不创建聊天、记忆或模型调用。

## 5. 可观测性与失败语义

设置页分别展示 desired、actual task、next run、last attempt/error/duration、last meaningful alert 和 native delivery attempt/error/accepted time。`lastHeartbeatDate` 只保留兼容，不能再被解释为健康状态。

关键术语：

- `delivered`：OS 发出 `show`，即系统接受展示请求。
- 不代表：用户看见、点击或已读。
- `blocked`：用户意图已保存，但 scheduler/provider 等实际条件不满足。
- `skipped_empty` / `skipped_reconcile_drift`：可解释的 0 模型调用结果，不是成功模型运行。

## 6. 验证入口与未关闭门禁

自动化入口见 `AssistantWorkspace.md` guardrail。真实 Claude SDK rules POC 已完成。三平台 packaged notification 的 sound/click smoke 仍是发布门禁：未完成前状态只能是 Code complete + Tests pass，不能写 Smoke passed 或 Release ready。
