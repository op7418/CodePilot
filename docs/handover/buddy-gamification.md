> 产品思考见 [docs/insights/buddy-gamification.md](../insights/buddy-gamification.md)

# Buddy 游戏化系统 — 技术交接文档

> 上次更新：2026-04-01

---

## 一、架构概览

Buddy 系统横跨 6 个子系统，核心数据流为：

```
Wizard/孵化 API → state.json(buddy) → context-assembler(性格 prompt)
                                     → DashboardPanel(看板卡)
                                     → ChatListPanel(侧栏)
                                     → MessageItem(聊天头像)
                                     → ChatEmptyState(空状态)
```

### 数据存储

| 数据 | 位置 | 格式 |
|------|------|------|
| Buddy 属性 | `{workspace}/.codepilot/state.json` → `buddy` 字段 | `BuddyData` (species/rarity/stats/buddyName/emoji) |
| 性格提示 | `{workspace}/soul.md` → `## Buddy Trait` 节 | Markdown |
| 心跳状态 | `state.json` → `lastHeartbeatDate` / `heartbeatEnabled` | ISO date string / boolean |
| 定时任务 | SQLite `scheduled_tasks` 表（durable）/ globalThis Map（session-only） | `ScheduledTask` type |
| 通知队列 | globalThis ring buffer（50 条上限） | `QueuedNotification[]` |
| 记忆提取计数 | globalThis `Map<sessionId, number>` | per-session counter |

---

## 二、Buddy 生成与进化

### 核心文件：`src/lib/buddy.ts`

**生成算法**：deterministic PRNG（workspace path + timestamp → hash → Mulberry32）
- 16 种物种，5 级稀有度（1%/4%/10%/25%/60%），5 项属性（20-100 随机）
- `SPECIES_IMAGE_URL`：Fluent UI 3D emoji CDN 地址映射
- `EGG_IMAGE_URL`：3D 蛋图片 CDN 地址
- `RARITY_BG_GRADIENT`：稀有度渐变色映射（用于背景）
- `SPECIES_LABEL`：物种中英文名映射

**进化**：`checkEvolution(buddy, memoryCount, daysActive, conversationCount)`
- 返回 `{ canEvolve, nextRarity, requirements, current }`
- `evolve(buddy)` → 稀有度 +1，全属性 +5~15，称号更新

**API 路由**：
- `POST /api/workspace/hatch-buddy` — 生成或更名 buddy，追加 `## Buddy Trait` 到 soul.md
- `POST /api/workspace/evolve-buddy` — 检查并执行进化，更新 soul.md trait 节

### 3D 图片使用位置

| 位置 | 有 Buddy | 无 Buddy | 文件 |
|------|---------|---------|------|
| Wizard Step 3 | 3D 物种图 + 渐变背景 | — | `OnboardingWizard.tsx` |
| 聊天空状态（助理） | 3D 物种图 + 渐变背景 | 3D 蛋图 | `MessageList.tsx` |
| 新建聊天入口 | — | 3D 蛋图 (24px/14px) | `ChatEmptyState.tsx` |
| 侧栏推广卡 | — | 3D 蛋图 (20px) | `ChatEmptyState.tsx` → `AssistantPromoCard` |
| 看板 Buddy 卡 | 3D 物种图 + 渐变背景 | 3D 蛋图 | `DashboardPanel.tsx` |

`globalThis.__codepilot_buddy_info__` 用于在 MessageList 中跨组件传递 buddy 信息（由 ChatView 设置）。

---

## 三、心跳系统

### 触发链路

```
                    ┌─ useAssistantTrigger ─────────────────────┐
                    │  空会话 + state.buddy 存在                  │
                    │  + data.needsHeartbeat (server-computed)   │
                    │  → autoTrigger: true, content: '心跳检查'   │
                    └──────────────┬────────────────────────────┘
                                   ▼
                    ┌─ context-assembler ────────────────────────┐
                    │  isHeartbeatTrigger =                      │
                    │    autoTrigger && userPrompt.includes('心跳检查')│
                    │  → buildHeartbeatInstructions() (完整 tick)  │
                    └──────────────┬────────────────────────────┘
                                   ▼
                    ┌─ route.ts (collectStreamResponse) ────────┐
                    │  isHeartbeatTurn = autoTrigger &&          │
                    │    content.includes('心跳检查')              │
                    │  → HEARTBEAT_OK 处理 / lastHeartbeatDate   │
                    └───────────────────────────────────────────┘
```

### 软心跳链路（普通对话附带）

```
context-assembler: !autoTrigger && shouldRunHeartbeat(state)
  → 注入 buildSoftHeartbeatHint()
  → AI 回复中包含 <!-- heartbeat-done --> 标记

route.ts (finally):
  → fullText.includes('<!-- heartbeat-done -->')
  → 更新 lastHeartbeatDate

route.ts (保存前):
  → contentBlocks 中所有 text block 清除 <!-- heartbeat-done -->
  → 持久化后的消息无标记痕迹
```

### `needsHeartbeat` 单一数据源

`GET /api/settings/workspace` 返回：
```ts
needsHeartbeat: !!state.buddy && shouldRunHeartbeat(state)
```
前端 `useAssistantTrigger` 直接使用此字段，不重新实现判定逻辑。

### Buddy-welcome 与 Heartbeat 互斥

```ts
// useAssistantTrigger.ts
const needsBuddyWelcome = state.onboardingComplete && !state.buddy && initialMessages.length === 0;
const needsHeartbeat = !!data.needsHeartbeat && !!state.buddy && initialMessages.length === 0;
```

`!state.buddy` vs `!!state.buddy` 天然互斥，不可能同时为 true。

---

## 四、定时任务调度器

### 核心文件：`src/lib/task-scheduler.ts`

**启动时机**：
1. `src/instrumentation.ts` — Next.js 服务启动时（覆盖冷启动）
2. `POST /api/chat` — 首次聊天时（冗余保障）
3. `POST /api/tasks/schedule` — 创建任务时

**轮询机制**：10 秒 `setInterval`，globalThis 防 HMR 重复启动

### Durable vs Session-only 任务

| | Durable | Session-only |
|---|---------|-------------|
| 存储 | SQLite `scheduled_tasks` | globalThis `Map<string, ScheduledTask>` |
| 跨重启 | ✅ | ❌ |
| 列出 | `/api/tasks/list` + MCP 合并 | MCP `codepilot_list_tasks` 合并显示 |
| 取消 | `/api/tasks/{id}` DELETE | MCP `codepilot_cancel_task` 先查 Map |
| 失败退避 | SQLite `updateScheduledTask` + `applyBackoff` | 内存中累加 `consecutive_errors` + BACKOFF_DELAYS |
| 自动禁用 | 10 次连续失败 | 10 次连续失败 → `status = 'disabled'` |

**`executeDueTask(task, isSessionTask)`**：
- `isSessionTask = true` 时跳过所有 SQLite 写入，错误时 re-throw 让 poll loop 处理
- `isSessionTask = false` 时走完整 SQLite 记录 + `computeNextRun` + `applyBackoff`

### Cron 表达式解析

`getNextCronTime(expression): Date | null`

- 统一 4 年（1461 天）日级扫描，每天预检 dom/month/dow 跳过不匹配日
- 支持：`*`、逗号 `1,15`、范围 `1-5`、步进 `*/5`
- 无匹配返回 `null` → 调用方暂停任务（`status: 'paused'`）或拒绝创建（400 错误）
- `schedule/route.ts` 和 `notification-mcp.ts` 都 import 此函数（不再有重复实现）

---

## 五、通知系统

### 核心文件

| 文件 | 职责 |
|------|------|
| `src/lib/notification-manager.ts` | 服务端通知队列 + `sendNotification()` |
| `src/app/api/tasks/notify/route.ts` | POST 接收通知 / GET 轮询队列 |
| `src/hooks/useNotificationPoll.ts` | 前端 5 秒轮询 + Toast + 系统通知 |
| `src/lib/notification-mcp.ts` | MCP 工具（notify/schedule/list/cancel/hatch） |

### 通知流

```
服务端触发（task-scheduler / notification-mcp）
  │
  ├─ sendNotification() → enqueueNotification() (globalThis ring buffer, max 50)
  │                     → Telegram (urgent only)
  │
  └─ 前端 useNotificationPoll (5s interval)
      └─ GET /api/tasks/notify → drainNotifications()
          ├─ showToast() (all priorities)
          └─ 系统通知 (normal/urgent):
              ├─ Electron: electronAPI.notification.show (IPC, 支持点击回到窗口)
              └─ Browser: new Notification() (dev fallback)
```

### 端口问题修复

`notification-mcp.ts` 中所有 HTTP 调用改为：
- **通知**：直接 `import('@/lib/notification-manager').sendNotification()`，不走 HTTP
- **任务调度**：`getBaseUrl()` 读 `process.env.PORT`，支持 worktree 和 Electron 非默认端口
- **任务列表/取消**：同上 + 合并 session-only 任务

`task-scheduler.ts` 的 `sendTaskNotification` 也改为直接 import。

---

## 六、记忆提取

### 核心文件：`src/lib/memory-extractor.ts`

**计数器隔离**：`Map<sessionId, number>`（globalThis），每个会话独立计数。
- 普通 buddy：每 3 轮提取
- Epic/Legendary：每 2 轮提取

**写入检测**：`hasMemoryWritesInResponse(fullResponseJson)`
- 传入 `JSON.stringify(contentBlocks)`（含 tool_use/tool_result 块）
- 检查 memory 路径模式（memory.md, memory/daily/, soul.md, user.md）
- 如果 AI 本轮已通过工具写入 memory → 跳过自动提取

### Symlink 安全

`codepilot_memory_get`（memory-search-mcp.ts）：
1. 词法检查：`path.relative()` 拒绝 `..` 前缀
2. Symlink 检查：`fs.realpathSync()` 解析真实路径后再验证是否在 workspace 内

---

## 七、Buddy 重置

`PATCH /api/settings/workspace` with `{ resetBuddy: true }`：
1. `state.buddy = undefined`
2. 清除 soul.md 中 `## Buddy Trait` 节（正则移除到下一个 `##` 或文件末尾）
3. 下次进入空会话 → 触发 buddy-welcome（领养引导）

---

## 八、空状态视觉一致性

| 场景 | 组件 | 有 Buddy | 无 Buddy |
|------|------|---------|---------|
| 聊天空（助理） | `MessageList.tsx` | 3D 物种图 + 渐变背景 + 名字 | 3D 蛋 + 领养提示 |
| 聊天空（项目） | `MessageList.tsx` | — | CodePilot logo |
| 新建聊天页 | `ChatEmptyState.tsx` | — | 3D 蛋图替代旧 Brain 图标 |
| 侧栏推广卡 | `AssistantPromoCard` | — | 3D 蛋图 (20px) |
| 看板 Buddy 卡 | `DashboardPanel.tsx` | 3D 物种图 + 渐变背景 + 状态行 | 3D 蛋 + 孵化按钮 |

---

## 九、关键设计决策记录

### 为什么心跳用 `<!-- heartbeat-done -->` 标记而非关键词检测

**背景**：最初尝试用关键词（heartbeat、记忆、检查等）检测 AI 是否做了心跳检查。
**问题**：关键词太泛（讨论 memory leak 也会命中），太窄（AI 用自然语言不一定提到文件名）。
**决策**：在 soft hint 中指示 AI 完成检查后输出不可见标记 `<!-- heartbeat-done -->`。持久化前从所有 contentBlock text 中清除。

### 为什么 cron 无匹配返回 null 而非远期日期

**背景**：先后尝试 1h fallback → 30 天 fallback → 4 年 fallback，都会导致提前触发。
**问题**：调度器执行逻辑是 `next_run <= now`，任何 fallback 日期最终都会到期并错误执行。
**决策**：返回 `null`，由调用方暂停任务或拒绝创建。这是唯一不会导致错误执行的方案。

### 为什么 needsHeartbeat 放在服务端而非前端计算

**背景**：前端重新实现了 `shouldRunHeartbeat` 的日期比较逻辑，与服务端分叉。
**问题**：UTC 兼容日期、activeHours 等条件只在服务端 `shouldRunHeartbeat()` 中实现，前端手写版会缺少这些。
**决策**：`GET /api/settings/workspace` 返回 `needsHeartbeat` 布尔值（含 buddy 存在性检查），前端直接用。

### 为什么 buddy-welcome 和 heartbeat 通过 `!!state.buddy` 互斥

**背景**：两者共用 `autoTrigger` flag，同时为 true 时只发一条消息。
**问题**：heartbeat 优先 → 新用户看到心跳检查而非领养引导；buddy-welcome 优先 → heartbeat 指令被注入到领养 turn 中。
**决策**：buddy-welcome 要求 `!state.buddy`，heartbeat 要求 `!!state.buddy`，逻辑上不可能冲突。

---

## 十、文件清单

### 本轮新增

| 文件 | 用途 |
|------|------|
| `src/hooks/useNotificationPoll.ts` | 前端通知轮询 + Toast + 系统通知 |

### 本轮主要修改

| 文件 | 改动 |
|------|------|
| `src/lib/context-assembler.ts` | autoTrigger 参数、isHeartbeatTrigger 判定、buildSoftHeartbeatHint、3D 蛋图 |
| `src/lib/task-scheduler.ts` | session 任务推进/退避/禁用、getNextCronTime→null、getSessionTasks 导出、冷启动 |
| `src/lib/notification-manager.ts` | 服务端通知队列 + enqueue/drain |
| `src/lib/notification-mcp.ts` | getBaseUrl() + 直接 import + session 任务合并 |
| `src/lib/memory-extractor.ts` | 按 sessionId 隔离计数器 |
| `src/lib/memory-search-mcp.ts` | symlink 安全检查 |
| `src/app/api/chat/route.ts` | 软心跳检测/清除、autoTrigger 传递、记忆写入检测、heartbeat-done 清理 |
| `src/app/api/tasks/notify/route.ts` | GET 轮询端点、POST 改用 sendNotification |
| `src/app/api/tasks/schedule/route.ts` | 改用 task-scheduler 导出函数、cron null 处理 |
| `src/app/api/settings/workspace/route.ts` | needsHeartbeat 字段、resetBuddy 清理 soul.md |
| `src/hooks/useAssistantTrigger.ts` | heartbeat 触发恢复、server-computed needsHeartbeat、buddy 互斥 |
| `src/components/layout/AppShell.tsx` | useNotificationPoll 集成 |
| `src/components/chat/MessageList.tsx` | 助理空状态 3D buddy/egg |
| `src/components/chat/ChatEmptyState.tsx` | 3D 蛋图替代 Brain 图标 |
| `src/components/layout/panels/DashboardPanel.tsx` | 紧凑状态行、进化反馈、设置按钮位置 |
| `src/types/electron.d.ts` | notification 接口类型 |
| `src/instrumentation.ts` | 冷启动调度器 |
