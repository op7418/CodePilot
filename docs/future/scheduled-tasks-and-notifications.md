# 定时任务 + 通知系统

> 关联：[语音助手](voice-assistant.md)、[统一上下文层 Phase 4-5](../exec-plans/active/unified-context-layer.md)

## 核心想法

让助理从"被动回应"变成"主动服务"。定时唤醒 → AI 判断是否有事要说 → 通过合适的渠道通知用户。

这是主动助理的关键拼图：

```
现有能力                          本功能补齐
├─ 助理工作区（人格/记忆/问询）      ├─ 定时任务（cron 调度 + 持久化）
├─ Bridge（微信/IM 远程）           ├─ 心跳系统（定期醒来，有事才说）
├─ 语音助手（规划中）               ├─ 通知投递（系统通知/IM/浮窗/主窗口）
└─ Context Assembler              └─ 后台执行（无 UI 静默跑任务）
         ↓ 合在一起 ↓
    主动助理（Proactive Assistant）
```

## 竞品调研

调研了四个项目的定时任务实现：

| | CoPaw | OpenClaw | NanoClaw | Claude Code |
|---|---|---|---|---|
| 调度引擎 | APScheduler (Python) | 自建 cron service (TS) | SQLite 轮询 (60s) | 自建 cron (1s 轮询) |
| 持久化 | `jobs.json` | `jobs.json` | SQLite 表 | session-scoped 不持久化 |
| 任务模式 | text / agent | main session / isolated | group / isolated | 复用当前 session |
| 心跳 | Heartbeat + HEARTBEAT.md | HeartbeatRunner + HEARTBEAT_OK 协议 | 无 | 无 |
| 通知 | Channel (DingTalk/Feishu/Discord) | Channel + Device Nodes (系统通知) | IPC → Channel | 终端内 |
| Active Hours | 有 | 有 (per-agent) | 无 | 无 |
| 重试 | misfire grace | 指数退避 (30s→60m) | 无 | 无 |

### 最值得借鉴的模式

**OpenClaw 的 Heartbeat vs Cron 双轨制**：
- Heartbeat：定期"醒来"检查一批事项（读 HEARTBEAT.md），context-aware，有事就说、没事沉默
- Cron：精确时间点执行特定任务，isolated 模式不干扰主会话
- CodePilot 现有的 daily check-in 本质就是 heartbeat 的雏形

**OpenClaw 的 HEARTBEAT_OK 协议**：
- AI 回复 `HEARTBEAT_OK` → 没事，不打扰用户
- 其他回复 → 有事要说，投递到渠道通知用户
- 避免每次心跳都产生无意义通知

**NanoClaw 的 context mode**：
- `group`：带上下文跑（需要记忆的定期任务）
- `isolated`：全新会话（独立后台任务）

**OpenClaw 的系统通知 tool**：
- Agent 主动调用 `notify` tool 发系统通知
- 支持 priority 分级：passive / active / timeSensitive

## 架构设计

### 整体结构

```
┌──────────────────────────────────────────────────────┐
│  CodePilot 主进程 (Electron Main)                      │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ TaskScheduler                                    │  │
│  │ • SQLite 持久化（复用现有 db.ts）                  │  │
│  │ • 三种 schedule: cron / interval / once          │  │
│  │ • 两种 context: session(带记忆) / isolated       │  │
│  │ • 轮询检查 due tasks（60s 间隔）                  │  │
│  │ • Active Hours 控制                              │  │
│  │ • 失败重试 + 指数退避                             │  │
│  └──────────┬──────────────────────────────────────┘  │
│             │                                         │
│  ┌──────────▼──────────────────────────────────────┐  │
│  │ HeartbeatRunner                                  │  │
│  │ • 定期"醒来"，读 workspace 状态                   │  │
│  │ • 注入 heartbeat prompt → 调 AI                  │  │
│  │ • HEARTBEAT_OK → 静默，不打扰                     │  │
│  │ • 有事 → NotificationManager 投递                │  │
│  │ • 复用现有 daily check-in + Context Assembler    │  │
│  └──────────┬──────────────────────────────────────┘  │
│             │                                         │
│  ┌──────────▼──────────────────────────────────────┐  │
│  │ NotificationManager                              │  │
│  │ • Electron Notification（系统通知）                │  │
│  │ • Bridge 渠道（微信/IM）                          │  │
│  │ • 浮窗弹出（语音播报）                             │  │
│  │ • 主窗口内通知（badge / toast）                    │  │
│  │ • priority 分级: low / normal / urgent           │  │
│  └──────────────────────────────────────────────────┘  │
│                                                       │
│  管理入口：                                            │
│  • 设置页 UI（CRUD + pause / resume / run now）        │
│  • 助理对话中自然语言创建/管理                            │
│  • AI 自己通过 MCP tool 调度（自主创建提醒等）            │
└──────────────────────────────────────────────────────┘
```

### 三个核心模块

#### 1. TaskScheduler — 定时调度引擎

```typescript
// DB schema（扩展现有 db.ts）
interface ScheduledTask {
  id: string
  name: string
  enabled: boolean
  schedule_type: 'cron' | 'interval' | 'once'
  schedule_value: string        // cron expression / ms interval / ISO timestamp
  timezone: string              // IANA timezone, default 系统时区
  context_mode: 'session' | 'isolated'
  prompt: string                // AI 执行的指令
  dispatch_target: string       // 'notification' | 'bridge' | 'floating' | 'silent'
  active_hours_start?: string   // "09:00"
  active_hours_end?: string     // "22:00"
  next_run: string              // ISO timestamp
  last_run?: string
  last_status?: 'success' | 'error' | 'skipped'
  last_error?: string
  retry_count: number
  max_retries: number
  created_at: string
}
```

执行流程：
1. 主进程启动 → 从 SQLite 加载所有 enabled 任务
2. 每 60s 轮询 `next_run < now` 的任务
3. Active Hours 检查 → 不在范围内则跳过
4. 按 context_mode 执行：
   - `session`：在助理工作区会话中执行，带完整上下文（记忆/人格/历史）
   - `isolated`：创建临时会话，执行完即销毁
5. 执行完成 → 计算 next_run → 按 dispatch_target 投递结果
6. 失败 → 指数退避重试（30s, 1m, 5m, 15m, 最多 max_retries 次）
7. once 类型执行完 → 标记 completed

#### 2. HeartbeatRunner — 心跳系统

心跳是一种特殊的定时任务，但更轻量：

```
每 N 分钟醒来（默认 30m，用户可配）
  → 读 workspace 状态（最近记忆、待办、日历等）
  → 注入 heartbeat prompt（"检查是否有需要提醒用户的事项"）
  → AI 判断
    → 回复 HEARTBEAT_OK → 什么都不做，静默
    → 回复其他内容 → 投递到通知渠道
```

与现有 daily check-in 的关系：
- daily check-in 是"AI 主动找用户聊天"（触发对话）
- heartbeat 是"AI 后台巡检"（静默检查，有事才说）
- 两者复用同一套 workspace prompt + Context Assembler

Heartbeat prompt 来源：
- 默认内置 prompt（检查日历、待办、未读消息等）
- 用户可在 workspace 放 `HEARTBEAT.md` 自定义检查项
- 定时任务也可以把自己注册为 heartbeat 检查项（批量执行，省 token）

#### 3. NotificationManager — 通知投递

```typescript
interface Notification {
  title: string
  body: string
  priority: 'low' | 'normal' | 'urgent'
  source: 'heartbeat' | 'scheduled_task' | 'agent'  // 来源
  action?: {
    type: 'open_session' | 'open_url' | 'open_floating'
    payload: string  // session id / url
  }
}
```

投递渠道（按 priority 和用户配置决定）：

| priority | 默认行为 |
|----------|---------|
| `low` | 主窗口内 badge，不弹通知 |
| `normal` | Electron 系统通知（macOS Notification Center / Windows Notification） |
| `urgent` | 系统通知 + 声音 + Bridge 渠道（微信/IM） + 浮窗弹出 |

点击通知的行为：
- 跳转到相关会话（`open_session`）
- 拉起浮窗显示摘要（`open_floating`）
- 用户可配置默认行为

### 与现有系统的集成点

| 现有模块 | 集成方式 |
|---------|---------|
| `db.ts` | 新增 `scheduled_tasks` + `task_run_logs` 表 |
| `assistant-workspace.ts` | Heartbeat 复用 workspace 文件加载 + prompt 注入 |
| `context-assembler.ts` | 新增 `entryPoint: 'scheduled'`，按需注入上下文 |
| `claude-client.ts` | 任务执行复用现有 SDK 调用链路 |
| `stream-session-manager.ts` | isolated 任务创建临时 session |
| Bridge (conversation-engine) | urgent 通知可通过 Bridge 投递到 IM |
| 浮窗（规划中） | urgent 通知可触发浮窗弹出 + TTS 播报 |
| 设置页 | 新增"定时任务"tab（任务列表/创建/编辑/日志） |

### AI 自主调度（MCP tool）

AI 在对话中可以自己创建定时任务：

```
用户："明天下午三点提醒我开会"
  → AI 调用 schedule_task tool
  → 创建 once 类型任务，dispatch_target: 'notification'

用户："每天早上九点给我总结昨天的邮件"
  → AI 调用 schedule_task tool
  → 创建 cron 类型任务，prompt 包含邮件总结指令

AI heartbeat 发现用户日历有冲突：
  → AI 调用 notify tool
  → 立即发系统通知
```

MCP tool 定义：

```typescript
// tool: schedule_task
interface ScheduleTaskInput {
  name: string
  schedule_type: 'cron' | 'interval' | 'once'
  schedule_value: string
  prompt: string
  context_mode?: 'session' | 'isolated'
  dispatch_target?: 'notification' | 'bridge' | 'floating' | 'silent'
  priority?: 'low' | 'normal' | 'urgent'
  active_hours?: { start: string; end: string }
}

// tool: notify (立即通知)
interface NotifyInput {
  title: string
  body: string
  priority?: 'low' | 'normal' | 'urgent'
  action?: { type: string; payload: string }
}

// tool: list_tasks / cancel_task / pause_task / resume_task
```

## 实现优先级

建议的实现顺序：

**Phase 1：通知基础 + 简单定时**
- NotificationManager（Electron Notification API）
- TaskScheduler 基础（SQLite 持久化 + 轮询 + cron/once）
- 设置页 UI（任务列表 + 创建）
- AI 可调用 `notify` tool 发即时通知

**Phase 2：心跳系统**
- HeartbeatRunner（定期醒来 + HEARTBEAT_OK 协议）
- 与 workspace prompt 集成
- Active Hours 控制
- HEARTBEAT.md 自定义检查项

**Phase 3：AI 自主调度**
- `schedule_task` / `cancel_task` 等 MCP tool
- 对话中自然语言管理任务
- isolated 上下文模式

**Phase 4：多渠道投递**
- Bridge 渠道投递（urgent 级别）
- 浮窗弹出 + 语音播报（依赖语音助手）
- 投递策略配置（用户选择哪些渠道接收哪些级别）

## 待确认的问题

- 轮询间隔：60s 够用吗？once 类型的"3 分钟后提醒"精度不够
- Electron 后台限制：应用最小化/不活跃时 setInterval 可能被节流，需要用 Electron 的 powerSaveBlocker 或 Main Process timer
- 任务并发：多个任务同时 due 时，串行还是并行？并行需要控制 API 调用量
- Token 消耗：heartbeat 每次都调 AI，30m 间隔一天 48 次，需要控制 prompt 大小和 effort level
- 用户感知：后台跑任务时，主窗口是否显示指示器（"助理正在后台工作..."）
