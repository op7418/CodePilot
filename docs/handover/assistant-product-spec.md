# CodePilot 个人助理 — 产品规格文档

> 版本：v0.44.0
> 上次更新：2026-04-01
> 技术交接：[docs/handover/memory-system-v3.md](memory-system-v3.md)

---

## 一、产品定位

CodePilot 个人助理是一个**有名字、有性格、有记忆的 AI 伙伴**。它不是一次性的问答工具，而是一个随时间成长、越用越懂你的长期伙伴。

与普通项目对话的区别：

| | 项目对话 | 个人助理 |
|---|---|---|
| 目的 | 帮你写代码、调试、重构 | 帮你管理日程、整理笔记、辅助创作和思考 |
| 上下文 | 单个项目文件夹 | 专属工作区（跨对话持久化） |
| 记忆 | 无 | 长期记忆 + 每日记录 + 自动提取 |
| 性格 | 通用 | 个性化（soul.md 定义风格和边界） |
| 形象 | 无 | Buddy 宠物伙伴（物种、稀有度、属性） |
| 主动性 | 被动响应 | 心跳检查 + 定时任务 + 主动提醒 |

---

## 二、用户旅程

### 2.1 新用户首次接触

```
打开 CodePilot
  → 空状态页显示两个入口：
     ┌──────────────┐  ┌──────────────────┐
     │ 💬 项目对话    │  │ 🤖 个人助理       │
     │ 打开项目文件夹  │  │ 设置一个了解你的    │
     │ AI 帮你写代码  │  │ AI 助理           │
     └──────────────┘  └──────────────────┘
  → 下方说明两者区别
```

用户点击"个人助理"后：

- 如果没有配置工作区路径 → 跳转设置页选择目录
- 如果有路径但未完成入职 → 弹出 Wizard
- 如果已配置 → 跳转到助理会话

### 2.2 入职引导（Onboarding Wizard）

3 步前端表单，**零 API 调用**，秒完成：

**Step 1：关于你**
- 名字输入
- 角色选择（6 个 chip：开发/设计/产品/研究/学生/通用）
- → 实时生成 user.md

**Step 2：关于助理**
- 助理名字输入（可留空，默认"个人助理"）
- 沟通风格选择（3 个 chip：简洁直接/详细耐心/轻松幽默）
- 边界/禁区输入（可选）
- → 实时生成 soul.md

**Step 3：Buddy 揭晓**
- 显示生成的 Buddy：大号 emoji + 物种名 + 稀有度星星
- 显示五项属性条（创意/耐心/洞察/幽默/精确）
- peak stat 高亮
- "开始聊天 →" 按钮

完成后：
- 生成 6 个文件：soul.md / user.md / claude.md / memory.md / HEARTBEAT.md / config.json
- claude.md 包含 5 个系统预设规则（时间感知、记一下、文档组织、写作约束、操作安全）
- soul.md 追加 peak stat 性格提示
- Buddy 数据存入 state.json
- 创建助理会话 → 跳转
- 聊天中插入孵化庆祝消息

### 2.3 老用户回归（已有助理但无 Buddy）

- 侧栏显示 🥚 + "领养你的伙伴！"
- 看板显示 🥚 + "孵化你的伙伴！" 按钮
- 设置页显示 🥚 + 孵化按钮
- 点击任意孵化入口 → 生成 Buddy → 庆祝消息插入聊天

---

## 三、日常使用

### 3.1 助理会话

打开助理工作区的会话后：

**上下文注入（system prompt）：**
- Layer 1：身份层（soul.md + user.md + claude.md）— 始终注入
- Layer 2：Session prompt + 技能注入
- Layer 3：指令层（心跳 tick / 渐进式更新指引）
- 记忆不在 system prompt 里 → 通过 MCP 工具按需检索

**输入框上方：Quick Actions**
- 2-5 个记忆驱动的建议 chip
- 来源：daily memory 中的未完成事项 + user.md 中的目标 + AI 动态生成（10 分钟缓存）
- 点击 chip → 自动填入并发送

**AI 消息左侧：Buddy 头像**
- 助理项目中所有 AI 回复旁显示 Buddy emoji（24px）
- 非助理项目不显示

### 3.2 记忆系统

**三个 MCP 工具（全局注册，助理模式始终可用）：**

| 工具 | 用途 |
|------|------|
| `codepilot_memory_search` | 关键词搜索 + AI 重排序 + 时间衰减 + tags 过滤 |
| `codepilot_memory_get` | 读取指定文件（路径安全校验 + wikilink 提取） |
| `codepilot_memory_recent` | 最近 3 天 daily memory + 长期记忆摘要 |

**System prompt 指引：**
- 首轮必调 `codepilot_memory_recent`
- 回答关于过去的问题前必搜索
- Obsidian 语法感知（`[[双向链接]]`、`#标签`、YAML frontmatter）

**自动记忆提取：**
- 每 3 轮对话（Epic+ Buddy 每 2 轮）自动用小模型提取值得记住的信息
- 互斥：如果 AI 本轮已写 memory 文件则跳过
- 提取结果追加到 `memory/daily/{today}.md`
- fire-and-forget，不阻塞响应

**记忆文件结构：**
```
workspace/
├── soul.md          — 助理人格（用户可编辑）
├── user.md          — 用户画像（AI 渐进更新，需告知用户）
├── claude.md        — 执行规则（系统预设 + 个性化）
├── memory.md        — 长期记忆（只追加，不覆写，200 行 + 25KB 上限）
├── HEARTBEAT.md     — 心跳检查清单（用户可自定义）
├── memory/daily/    — 每日记录（按日期命名，30 天归档）
├── Inbox/           — 默认收件箱
├── README.ai.md     — 自动生成的目录概览
└── PATH.ai.md       — 自动生成的路径索引
```

**渐进式文件更新：**
- AI 在日常对话中自主发现偏好并更新文件
- 身份文件（soul/user/claude）修改后必须告知用户
- 记忆文件（memory.md / daily）可静默更新
- 用户说"记一下" → 保留原文存入，不加工

**时间衰减：**
- 日期文件 30 天半衰期（指数衰减）
- 90 天前的笔记只剩 ~12.5% 权重
- memory.md 等常青文件不衰减

### 3.3 心跳系统（双模式）

> 详细设计决策见 [docs/insights/buddy-gamification.md](../insights/buddy-gamification.md)

心跳有两种模式，根据用户是否主动发消息自动选择：

**模式 1：完整心跳（autoTrigger）**

触发条件：空会话 + Buddy 存在 + 服务端 `needsHeartbeat = true`（`shouldRunHeartbeat()` + `!!state.buddy`）。

流程：`useAssistantTrigger` → 发送不可见消息 `'心跳检查'` → `context-assembler` 检测 `userPrompt.includes('心跳检查')` → 注入 `buildHeartbeatInstructions()` → AI 自主检查 HEARTBEAT.md、回顾记忆、整理文件。

- 没事做 → 回复 HEARTBEAT_OK → 静默（不打扰用户）
- 有事说 → 自然对话告知

HEARTBEAT_OK 协议：HTML/Markdown 解包 · ≤300 chars 也算静默 · 标记 `is_heartbeat_ack` · 不显示在聊天历史 · 不触发 Telegram

**模式 2：软心跳（系统 prompt hint）**

触发条件：用户主动发消息 + 心跳过期（`!autoTrigger && shouldRunHeartbeat(state)`）。

流程：`context-assembler` 在 prompt 末尾追加 `buildSoftHeartbeatHint()` → AI 在回答用户问题的同时顺带检查 → 完成后在回复末尾输出 `<!-- heartbeat-done -->` → 后端检测标记并更新 `lastHeartbeatDate` → 标记从所有 contentBlock text 中清除后再持久化。

**互斥守卫：**
- Buddy-welcome（`!state.buddy`）和 heartbeat（`!!state.buddy`）天然互斥
- `needsHeartbeat` 字段由服务端 `GET /api/settings/workspace` 计算（单一数据源）
- `context-assembler` 通过 `userPrompt` 内容区分 heartbeat 和 buddy-welcome，不仅依赖 `autoTrigger` flag

**Telegram 完全静默：**
- 所有 auto-trigger turns（心跳 + 入职）的 5 条 Telegram 出口全部守卫
- notifySessionStart / Complete / Error / Generic / PermissionRequest 均不触发

### 3.4 定时任务 + 通知

**全局 MCP 工具（所有上下文都能调用，不限助理）：**

| 工具 | 用途 |
|------|------|
| `codepilot_notify` | 即时通知（low=Toast / normal=Toast+系统通知 / urgent=+Telegram） |
| `codepilot_schedule_task` | 创建定时任务（cron / interval / once + durable/session-only） |
| `codepilot_list_tasks` | 列出所有任务 |
| `codepilot_cancel_task` | 取消任务 |

**调度器：**
- 10 秒轮询（Next.js 服务端 setInterval + globalThis 防 HMR）
- SQLite 持久化（跨重启保留）
- 三种调度：cron（5 字段）/ interval（30m/2h）/ once（ISO 时间戳）
- 确定性 jitter（task ID hash → 10% interval 偏移，max 15min）
- 锚点防漂移（next = last + interval，不是 now + interval）

**失败处理：**
- 指数退避：30s → 1m → 5m → 15m
- 10 次连续失败 → 自动禁用
- 任务完成/失败 → 插入 assistant 消息到聊天 + 通知

**生命周期：**
- Recurring 任务 7 天自动过期（permanent 标记豁免）
- 一次性任务过期后启动时恢复（提示用户"要执行吗？"）
- Session-only 任务（durable=false）只存内存，关进程即清

**执行历史：**
- `task_run_logs` 表记录每次执行（状态/结果/错误/耗时）

---

## 四、视觉体系

### 4.1 Buddy 宠物

**生成：**
- 16 种物种：猫🐱 / 鸭子🦆 / 龙🐉 / 猫头鹰🦉 / 企鹅🐧 / 海龟🐢 / 章鱼🐙 / 幽灵👻 / 六角龙🦎 / 水豚🦫 / 机器人🤖 / 兔子🐰 / 蘑菇🍄 / 狐狸🦊 / 熊猫🐼 / 鲸鱼🐋
- 5 级稀有度：普通(60%) / 稀有(25%) / 精良(10%) / 史诗(4%) / 传说(1%)
- 5 项属性：创意 / 耐心 / 洞察 / 幽默 / 精确
- 确定性生成：workspace 路径 + 时间戳 → hash → Mulberry32 PRNG

**稀有度能力差异：**

| 稀有度 | 称号 | 增强性格 | 记忆加速 | 传说特效 |
|--------|------|---------|---------|---------|
| Common ★ | ❌ | ❌ | ❌ | ❌ |
| Uncommon ★★ | ✅ "勤奋的" | ❌ | ❌ | ❌ |
| Rare ★★★ | ✅ | ✅ 双属性 | ❌ | ❌ |
| Epic ★★★★ | ✅ | ✅ | ✅ 每 2 轮 | ❌ |
| Legendary ★★★★★ | ✅ | ✅ | ✅ | ✅ 金色光效 |

**进化系统：**

| 进化路径 | 记忆数 | 天数 | 对话数 |
|---------|--------|------|--------|
| Common → Uncommon | 10 | 7 | 20 |
| Uncommon → Rare | 30 | 21 | 50 |
| Rare → Epic | 60 | 45 | 100 |
| Epic → Legendary | 100 | 90 | 200 |

进化后：全属性提升 + 解锁更高级能力 + soul.md 更新 + 庆祝消息

### 4.2 侧栏

```
┌──────────────────────────┐
│ 🐱 Toki                  │  ← Buddy emoji + 助理名字（或 🥚 领养提示）
│   / test-workspace       │  ← 文件夹路径（灰色小字）
├──────────────────────────┤
│  对话 1              3h前  │  ← 主题色高亮（bg-primary/[0.06~0.12]）
│  对话 2              1天   │
└──────────────────────────┘
```

- 助理项目始终置顶
- 展开时浅主题色背景
- 对话列表 hover/选中也带主题色
- 无 buddy → 🥚 + "领养你的伙伴！"

### 4.3 看板面板

助理项目的看板（右侧面板）顶部注入 Buddy 状态卡：

```
┌─────────────────────────────────────┐  ← 稀有度边框色（传说金色发光）
│ 🐱 Toki                    ★★★ 精良 │
│ "敏锐的" 猫咪                        │  ← 称号 + 物种
│ 孵化于 2026-03-31                    │
│                                     │
│ 创意 ████████░░ 80                  │  ← peak stat 高亮
│ 耐心 ██████░░░░ 60                  │
│ 洞察 ███░░░░░░░ 30                  │
│ 幽默 ███████░░░ 70                  │
│ 精确 █████░░░░░ 50                  │
│                                     │
│ ❤️ 心跳 2h前 · 🧠 记忆 23 · ⏰ 任务 3 │
│                                     │
│ 进化进度 ████░░░░░░ 40%     下一级: 史诗 │
│ 🌟 检查进化                          │
│                                     │
│ ⚙ 助理设置                           │
└─────────────────────────────────────┘
```

无 buddy → 🥚 + "领养你的伙伴！" 按钮

### 4.4 顶栏

看板按钮：
- 助理项目 → Buddy emoji（或 🥚）
- 非助理项目 → ChartBar 图标

---

## 五、设置页（助理 Tab）

### 5.1 路径设置
- 工作区目录选择 + 实时校验

### 5.2 入职状态
- 已完成：一行 "✓ 已设置" + "重新设置" 链接
- 未完成：完整卡片 + Wizard 按钮

### 5.3 人格 / Buddy 预览
- Buddy emoji（或 🥚）+ 助理名字 + 稀有度
- 风格描述
- 无 buddy → 孵化按钮
- "编辑 soul.md 自定义人格" 提示

### 5.4 心跳开关
- 启用/禁用切换
- 上次心跳日期 + 状态
- "编辑 HEARTBEAT.md 自定义检查内容" 提示

### 5.5 定时任务列表
- 任务名 / 调度 / 状态 / 下次执行
- 每个任务有删除按钮
- 无任务："让助理创建"

### 5.6 文件状态
- soul/user/claude/memory/heartbeat 存在性 ✓/⚠

### 5.7 高级选项（折叠）
- 分类体系 / 文件索引 / 组织管理

---

## 六、通知渠道

| 优先级 | Toast | 系统通知 | Telegram |
|--------|-------|---------|----------|
| low | ✅ | ❌ | ❌ |
| normal | ✅ | ✅ | ❌ |
| urgent | ✅ | ✅ | ✅ |

**通知流（服务端 → 用户）：**
- `sendNotification()` → 服务端 globalThis ring buffer（50 条上限）+ Telegram（urgent）
- 前端 `useNotificationPoll`（5 秒轮询 `GET /api/tasks/notify`）→ Toast + Electron IPC 原生通知
- 后台 tray-only 模式：`electron/main.ts` 中 `startBgNotifyPoll()` 直接 HTTP 轮询 + `new Notification()`
- 点击通知 → 窗口前置（前台）或重新创建窗口（后台）
- auto-trigger turns 全部静默（不推送心跳/入职的通知）

---

## 七、质量保障

- ESLint 0 error + CI 门槛恢复（`continue-on-error` 已移除）
- Smoke 测试进 CI（`smoke-test` job 接入 build/release 链）
- 525 个单元测试全过
- 外链默认浏览器打开（`shell.openExternal`）
- Tech debt 追踪（6 项）

---

## 八、文件清单

### 新增文件（本次迭代）

| 文件 | 用途 |
|------|------|
| `src/lib/buddy.ts` | Buddy 生成系统（物种/稀有度/属性/进化） |
| `src/lib/heartbeat.ts` | HEARTBEAT_OK 协议 |
| `src/lib/memory-search-mcp.ts` | Memory Search MCP（3 工具） |
| `src/lib/memory-extractor.ts` | 自动记忆提取 |
| `src/lib/notification-mcp.ts` | 通知 + 定时任务 MCP（4 工具） |
| `src/lib/notification-manager.ts` | 多渠道通知分发 + 服务端通知队列 |
| `src/lib/task-scheduler.ts` | 定时任务调度器 |
| `src/lib/bg-notify-parser.ts` | 后台通知解析（Electron main process 共用） |
| `src/hooks/useNotificationPoll.ts` | 前端通知轮询 + Toast + Electron IPC 通知 |
| `src/lib/identicon.ts` | boring-avatars 配置 |
| `src/components/ui/AssistantAvatar.tsx` | 头像组件 |
| `src/components/assistant/OnboardingWizard.tsx` | 3 步入职 Wizard |
| `src/components/chat/QuickActions.tsx` | 记忆驱动建议 chips |
| `src/components/layout/panels/AssistantPanel.tsx` | 助理状态面板（保留） |
| `src/app/api/workspace/wizard/route.ts` | Wizard API |
| `src/app/api/workspace/summary/route.ts` | 助理概要 API |
| `src/app/api/workspace/quick-actions/route.ts` | Quick Actions API |
| `src/app/api/workspace/hatch-buddy/route.ts` | Buddy 孵化 API |
| `src/app/api/workspace/evolve-buddy/route.ts` | Buddy 进化 API |
| `src/app/api/tasks/schedule/route.ts` | 创建定时任务 |
| `src/app/api/tasks/list/route.ts` | 列出任务 |
| `src/app/api/tasks/notify/route.ts` | 发送通知 |
| `src/app/api/tasks/[id]/route.ts` | 任务 CRUD |
| `src/app/api/tasks/[id]/run/route.ts` | 立即执行 |
| `src/app/api/tasks/[id]/pause/route.ts` | 暂停/恢复 |

### 主要修改文件

| 文件 | 改动 |
|------|------|
| `src/lib/context-assembler.ts` | 6 层上下文 + 双模式心跳（完整 tick + 软 hint）+ 渐进式更新 |
| `src/lib/assistant-workspace.ts` | shouldRunHeartbeat + HEARTBEAT.md + V4→V5 迁移 + Buddy state |
| `src/lib/claude-client.ts` | Memory MCP + Notification MCP 全局注册 + Telegram 静默 |
| `src/app/api/chat/route.ts` | heartbeat ack + 软心跳检测/清理 + 自动记忆提取 + Telegram 静默 |
| `src/lib/db.ts` | scheduled_tasks + task_run_logs 表 + is_heartbeat_ack 列 |
| `src/components/layout/panels/DashboardPanel.tsx` | Buddy 卡片 + 进化 + 状态 |
| `src/components/layout/ProjectGroupHeader.tsx` | Buddy emoji + 两行布局 |
| `src/components/layout/ChatListPanel.tsx` | summary 加载 + PromoCard |
| `src/components/chat/ChatEmptyState.tsx` | 双入口 + AssistantPromoCard |
| `src/components/chat/MessageItem.tsx` | AI 消息 Buddy 头像 |
| `src/components/chat/MessageInput.tsx` | QuickActions 集成 |
| `src/components/settings/AssistantWorkspaceSection.tsx` | 设置页重构 |
| `electron/main.ts` | 通知 IPC + 外链拦截 + 后台 tray-only 通知轮询 |
| `electron/preload.ts` | 通知 API 暴露 |
