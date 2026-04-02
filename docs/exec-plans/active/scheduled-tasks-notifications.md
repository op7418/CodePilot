# 定时任务 + 通知系统

> 创建时间：2026-03-31
> 关联：[docs/future/scheduled-tasks-and-notifications.md](../../future/scheduled-tasks-and-notifications.md)
> 心跳边界：[docs/exec-plans/active/memory-system-v3.md](memory-system-v3.md)

## 状态

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | Notification MCP（全局通知工具） | 📋 待开始 |
| Phase 2 | TaskScheduler（SQLite 持久化调度器） | 📋 待开始 |
| Phase 3 | Electron 系统通知 | 📋 待开始 |
| Phase 4 | 管理 UI（设置页 + 看板集成） | 📋 待开始 |

## 背景

四个参考项目对比：

| | Claude Code | OpenClaw | CoPaw | NanoClaw |
|---|---|---|---|---|
| 存储 | 内存（session-scoped） | JSON 文件 | JSON 文件 | **SQLite** |
| 调度类型 | cron / once | at / every / cron | cron | cron / interval / once |
| 通知方式 | 当前 terminal | 多渠道（IM + webhook） | Console push | IPC → IM |
| AI 可创建 | ✅ CronCreate tool | ❌ | ❌ | ✅ IPC file |
| 持久化 | ❌ 进程退出即丢失 | ✅ | ✅ | ✅ |
| 失败处理 | 无 | 指数退避 + 告警冷却 | 简单日志 | 日志 |
| 漂移防护 | 无 | 锚点 + stagger | APScheduler | 锚点 |

**我们的选择**：
- 存储：**SQLite**（已有 db.ts，NanoClaw 验证可行）
- 调度：**cron + interval + once** 三种（最全面）
- 通知：**MCP tool**（全局可用，任何上下文都能调用）+ **Electron 系统通知** + **已有 Telegram**
- AI 创建：**MCP tool**（比 NanoClaw 的 IPC 更简洁）
- 持久化：**SQLite**（跨重启保留）

## 架构设计

### 核心原则

1. **通知是 MCP tool**——任何上下文（助理/项目/Bridge）都能调 `codepilot_notify` 发通知
2. **定时任务也是 MCP tool**——AI 通过 `codepilot_schedule` 创建/管理任务
3. **调度器在 Electron Main Process**——不依赖 Next.js API 路由的生命周期
4. **通知多渠道**——Electron 系统通知 + Toast + Telegram（已有）

### 系统架构

```
┌────────────────────────────────────────────────────┐
│  Electron Main Process                              │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ TaskScheduler                                  │  │
│  │ • setInterval 轮询（10s 间隔）                  │  │
│  │ • SQLite 读取 due tasks                        │  │
│  │ • 触发执行：IPC → Renderer → POST /api/chat    │  │
│  │ • 漂移防护：锚点计算                            │  │
│  │ • 失败退避：指数退避 30s → 5m → 15m             │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ NotificationManager                            │  │
│  │ • Electron Notification API（系统通知）          │  │
│  │ • IPC → Renderer Toast（应用内通知）             │  │
│  │ • Telegram（复用已有 telegram-bot.ts）          │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│         ↕ IPC                                       │
├────────────────────────────────────────────────────┤
│  Renderer (Next.js)                                 │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ Notification MCP (codepilot-notify)            │  │
│  │ • codepilot_notify：发即时通知                   │  │
│  │ • codepilot_schedule_task：创建定时任务          │  │
│  │ • codepilot_list_tasks：列出任务                │  │
│  │ • codepilot_cancel_task：取消任务               │  │
│  │ → 全局注册，所有上下文可用（不限助理）             │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ API Routes                                     │  │
│  │ • POST /api/tasks/notify  — MCP 调用的后端      │  │
│  │ • POST /api/tasks/schedule — 创建任务           │  │
│  │ • GET  /api/tasks/list    — 列出任务           │  │
│  │ • DELETE /api/tasks/:id   — 取消任务           │  │
│  │ • POST /api/tasks/:id/run — 立即执行           │  │
│  └───────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────┘
```

## Phase 1：Notification MCP（全局通知工具）

### 新建 `src/lib/notification-mcp.ts`

**全局注册**（不限助理模式）——在 `claude-client.ts` 的 MCP 注册区域，无条件注册。

```typescript
// 2 个工具
tool('codepilot_notify', {
  description: '发送通知给用户。支持系统通知、应用内 Toast、Telegram。',
  parameters: {
    title: z.string().describe('通知标题'),
    body: z.string().describe('通知内容'),
    priority: z.enum(['low', 'normal', 'urgent']).optional().default('normal'),
    action: z.object({
      type: z.enum(['open_session', 'open_url']),
      payload: z.string(),
    }).optional(),
  },
  handler: async ({ title, body, priority, action }) => {
    // POST /api/tasks/notify
    // 后端根据 priority 决定渠道：
    //   low: Toast only
    //   normal: Toast + Electron 系统通知
    //   urgent: Toast + 系统通知 + Telegram（如果配置了）
  },
})

tool('codepilot_schedule_task', {
  description: '创建定时任务。支持 cron 表达式、固定间隔、一次性定时。',
  parameters: {
    name: z.string().describe('任务名称'),
    prompt: z.string().describe('到时间后执行的指令'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string().describe('cron: "0 9 * * *", interval: "30m", once: "2026-03-31T15:00:00"'),
    priority: z.enum(['low', 'normal', 'urgent']).optional().default('normal'),
    notify_on_complete: z.boolean().optional().default(true),
  },
  handler: async (params) => {
    // POST /api/tasks/schedule
    // 写入 SQLite scheduled_tasks 表
  },
})

tool('codepilot_list_tasks', {
  description: '列出所有定时任务',
  handler: async () => {
    // GET /api/tasks/list
  },
})

tool('codepilot_cancel_task', {
  description: '取消定时任务',
  parameters: { task_id: z.string() },
  handler: async ({ task_id }) => {
    // DELETE /api/tasks/:id
  },
})
```

### System Prompt

```
## 通知与定时任务

你可以发送通知和创建定时任务：

- codepilot_notify: 立即发送通知（标题 + 内容 + 优先级）
- codepilot_schedule_task: 创建定时任务（cron / interval / once）
- codepilot_list_tasks: 查看已有任务
- codepilot_cancel_task: 取消任务

用户说"提醒我..."或"每天..."时，用 codepilot_schedule_task。
任务完成或出错时，用 codepilot_notify 告知用户。
```

### 注册方式

**全局注册**——在 `claude-client.ts` 中，不在任何条件块内（不限 isAssistantProject）：

```typescript
// Notification + Schedule MCP: globally available in all contexts
const { createNotificationMcpServer, NOTIFICATION_MCP_SYSTEM_PROMPT } =
  await import('@/lib/notification-mcp');
queryOptions.mcpServers = {
  ...(queryOptions.mcpServers || {}),
  'codepilot-notify': createNotificationMcpServer(sessionId),
};
// Append system prompt
queryOptions.systemPrompt.append += '\n\n' + NOTIFICATION_MCP_SYSTEM_PROMPT;
```

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/lib/notification-mcp.ts` | **新建** |
| `src/lib/claude-client.ts` | 全局注册 notification MCP |

## Phase 2：TaskScheduler（SQLite 调度器）

### DB Schema

```sql
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron', 'interval', 'once')),
  schedule_value TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT '',
  next_run TEXT NOT NULL,
  last_run TEXT,
  last_status TEXT CHECK(last_status IN ('success', 'error', 'skipped', 'running')),
  last_error TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'disabled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'urgent')),
  notify_on_complete INTEGER NOT NULL DEFAULT 1,
  session_id TEXT,
  working_directory TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_scheduled_tasks_next_run ON scheduled_tasks(next_run);
CREATE INDEX idx_scheduled_tasks_status ON scheduled_tasks(status);
```

### API Routes

```
POST   /api/tasks/schedule  — 创建任务
GET    /api/tasks/list      — 列出任务（可选 status 过滤）
GET    /api/tasks/:id       — 获取单个任务
DELETE /api/tasks/:id       — 取消/删除任务
POST   /api/tasks/:id/run   — 立即执行
POST   /api/tasks/:id/pause — 暂停
POST   /api/tasks/:id/resume — 恢复
POST   /api/tasks/notify    — 发送即时通知
```

### 调度器（Electron Main Process）

```typescript
// electron/main.ts 中启动
const POLL_INTERVAL = 10_000; // 10 秒轮询

function startTaskScheduler() {
  setInterval(async () => {
    // 1. 通过 IPC 或直接 HTTP 调用 GET /api/tasks/list?due=true
    // 2. 对每个 due task：
    //    a. 标记 status = 'running'
    //    b. 通过 IPC 触发 renderer 发起聊天请求（复用 streamClaude）
    //    c. 完成后更新 next_run + last_status
    //    d. 如果 notify_on_complete，发通知
    // 3. 失败处理：consecutive_errors++，指数退避
  }, POLL_INTERVAL);
}
```

但 Electron Main Process 不能直接调用 Next.js API——需要通过 HTTP localhost 或 IPC。

**更简单的方案**：调度器跑在 Next.js API 层（Node.js），用 `setInterval` 在服务端轮询。因为 CodePilot 的 Next.js dev server 始终运行，这个方案更可靠。

```typescript
// src/lib/task-scheduler.ts
let schedulerStarted = false;

export function ensureSchedulerRunning() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  setInterval(async () => {
    const dueTasks = getDueTasks(); // SQLite 查询 next_run <= now AND status = 'active'
    for (const task of dueTasks) {
      executeDueTask(task);
    }
  }, 10_000);
}

// 在 route.ts 或 app 初始化时调用
ensureSchedulerRunning();
```

### 执行引擎

任务执行不走 streamClaude（太重）——而是用轻量的文本生成 API 或直接调用 SDK：

```typescript
async function executeDueTask(task: ScheduledTask) {
  updateTaskStatus(task.id, 'running');
  try {
    // 用轻量方式执行 prompt（不需要完整的 streaming UI）
    const result = await generateTextForTask(task.prompt, task.working_directory);

    updateTaskStatus(task.id, 'success', { lastResult: result });
    computeNextRun(task); // 更新 next_run

    if (task.notify_on_complete) {
      await sendNotification({
        title: `✅ ${task.name}`,
        body: result.slice(0, 200),
        priority: task.priority,
      });
    }
  } catch (err) {
    const consecutiveErrors = task.consecutive_errors + 1;
    updateTaskStatus(task.id, 'error', {
      lastError: err.message,
      consecutiveErrors,
    });

    // 指数退避：30s → 1m → 5m → 15m
    applyBackoff(task, consecutiveErrors);

    if (task.notify_on_complete) {
      await sendNotification({
        title: `❌ ${task.name} 失败`,
        body: err.message.slice(0, 200),
        priority: 'urgent',
      });
    }
  }
}
```

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/lib/db.ts` | 新增 `scheduled_tasks` 表 + CRUD 函数 |
| `src/lib/task-scheduler.ts` | **新建**：调度器轮询 + 执行引擎 |
| `src/app/api/tasks/schedule/route.ts` | **新建** |
| `src/app/api/tasks/list/route.ts` | **新建** |
| `src/app/api/tasks/[id]/route.ts` | **新建**（GET/DELETE） |
| `src/app/api/tasks/[id]/run/route.ts` | **新建** |
| `src/app/api/tasks/[id]/pause/route.ts` | **新建** |
| `src/app/api/tasks/notify/route.ts` | **新建** |

## Phase 3：Electron 系统通知

### 通知后端

```typescript
// electron/main.ts 新增
ipcMain.handle('show-notification', async (_, { title, body, onClick }) => {
  const notification = new Notification({
    title,
    body,
    icon: nativeImage.createFromPath(path.join(__dirname, '../assets/icon.png')),
  });
  if (onClick) {
    notification.on('click', () => {
      mainWindow?.focus();
      mainWindow?.webContents.send('notification-click', onClick);
    });
  }
  notification.show();
});
```

### 前端调用

```typescript
// src/lib/notification-manager.ts
export async function sendNotification(opts: {
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'urgent';
  action?: { type: string; payload: string };
}) {
  // 1. Toast（始终）
  showToast({ type: 'info', message: `${opts.title}: ${opts.body}` });

  // 2. Electron 系统通知（normal + urgent）
  if (opts.priority !== 'low') {
    const w = window as unknown as { electronAPI?: { showNotification?: (opts: unknown) => void } };
    w.electronAPI?.showNotification?.({
      title: opts.title,
      body: opts.body,
      onClick: opts.action,
    });
  }

  // 3. Telegram（urgent，如果配置了）
  if (opts.priority === 'urgent') {
    try {
      await fetch('/api/tasks/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
    } catch { /* best effort */ }
  }
}
```

### 涉及文件

| 文件 | 改动 |
|------|------|
| `electron/main.ts` | IPC handler `show-notification` |
| `electron/preload.ts` | 暴露 `showNotification` API |
| `src/lib/notification-manager.ts` | **新建**：多渠道通知分发 |

## Phase 4：管理 UI

### 设置页

设置 → 新增"定时任务"tab：
- 任务列表（名称、调度、状态、下次执行、操作按钮）
- 创建任务表单
- 暂停/恢复/删除/立即执行

### 看板集成

助理看板的 AssistantStatusCard 中新增定时任务计数：
```
⏰ 定时任务: 3 个（2 active, 1 paused）
```

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/components/settings/ScheduledTasksSection.tsx` | **新建** |
| `src/components/settings/SettingsLayout.tsx` | 新增 tab |
| `src/components/layout/panels/DashboardPanel.tsx` | 任务计数显示 |

## 实施顺序

```
Phase 1 (Notification MCP) ←── 最先做，立即有价值
    ↓
Phase 2 (TaskScheduler)    ←── 核心调度器
    ↓
Phase 3 (Electron 通知)    ←── 系统通知增强
    ↓
Phase 4 (管理 UI)          ←── 可视化管理
```

Phase 1 单独就有价值——AI 可以在任何对话中发通知（"帮我记一下，5 分钟后提醒我"目前做不到，但有了 notify 至少能发 Toast）。

## 与心跳系统的边界

| | 心跳 | 定时任务 |
|---|---|---|
| 作用域 | 助理 workspace 专属 | 全局，任何项目 |
| 触发 | 打开会话时 | 后台调度器 |
| 内容 | HEARTBEAT.md 检查清单 | 用户自定义 prompt |
| 静默协议 | HEARTBEAT_OK | 无 |

未来心跳可以用定时任务的 TaskScheduler 作为底层调度器（替代"打开会话时触发"）。
