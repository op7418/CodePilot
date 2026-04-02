# 记忆系统 V3：Onboarding 重写 + Heartbeat + 渐进式更新

> 创建时间：2026-03-30
> 最后更新：2026-03-30
> 产品思考见 [docs/future/core-system-guardrails.md](../../future/core-system-guardrails.md)

## 状态

| Phase | 内容 | 状态 | 备注 |
|-------|------|------|------|
| Phase 1 | Onboarding 重写（对话式 bootstrap） | ✅ 已完成 | commit `93fd470` |
| Phase 2 | Check-in → Heartbeat | ✅ 已完成 | commit `93fd470` + 4 轮 Codex 审核修复 |
| Phase 3 | 渐进式文件更新 | ✅ 已完成 | commit `93fd470` |
| Phase 4 | Memory Flush（压缩前自动写盘） | 📋 待开始 | 依赖 SDK compaction hook |
| V3.1 | Memory Search MCP + 记忆移出 prompt | ✅ 已完成 | commit `c92ea99` |
| V3.1 | 时间衰减 + Obsidian 感知 | ✅ 已完成 | commit `1c5c349` |
| V3.1 | Transcript 裁剪 (is_heartbeat_ack) | ✅ 已完成 | commit `c92ea99` + 修复 `d4b30eb` |
| V3.1 | Telegram 通知静默 | ✅ 已完成 | commit `8933001` + `72c27f2` + `c87a3bb` |

## 背景

V2 记忆系统的核心问题：
- Onboarding 13 题太多，结束节点不明确，用户每次进来都被问一遍
- Check-in 是填表不是对话（3 题固定问卷 → JSON → 机械写文件）
- 身份文件（soul/user/claude）生成后定型，没有渐进式学习机制
- 生成的文件质量泛泛，缺乏具体性（对比用户手动优化的结果差距大）

参考：
- OpenClaw：对话式 Bootstrap、HEARTBEAT_OK 协议、Memory Flush
- CoPaw：APScheduler 心跳 + HEARTBEAT.md + active hours
- 用户实践验证：六文件分离、三层记忆、Obsidian 式组织哲学

### 作用域边界：心跳 vs 定时任务

| | 心跳（本文档 Phase 2） | 定时任务（[docs/future/scheduled-tasks-and-notifications.md](../../future/scheduled-tasks-and-notifications.md)） |
|---|---|---|
| **作用域** | 助理 workspace 专属 | 通用，任何项目可用 |
| **触发条件** | `session.working_directory === assistant_workspace_path` | cron / interval / once 调度 |
| **内容来源** | HEARTBEAT.md 检查清单 + 记忆文件 | 每个任务各自的 prompt |
| **Context** | 轻量模式（HEARTBEAT.md + daily + memory.md） | 按 context_mode 决定（session 或 isolated） |
| **静默协议** | HEARTBEAT_OK → 不打扰用户 | 无，任务结果按 dispatch_target 投递 |
| **状态管理** | `.assistant/state.json` 内的心跳字段 | SQLite `scheduled_tasks` 表 |

**交汇点**：未来定时任务的 TaskScheduler 可以作为心跳的底层调度器（替代"打开会话时触发"的临时方案），但心跳的上层逻辑（HEARTBEAT.md、HEARTBEAT_OK、轻量 context、transcript 裁剪、去重）只在助理模式生效。非助理项目的定期检查走定时任务系统，不走心跳。

---

## Phase 1：Onboarding 重写

### 目标

13 题固定问卷 → 自然对话式 bootstrap。至少 3 轮对话，用户说"可以了"就结束；用户想继续聊就继续。**结束必须明确**。

### 交互流程

```
用户首次进入助理 workspace
  → AI 发起自然对话（参考 OpenClaw Bootstrap）
  → 围绕 3 个核心主题展开：
    1. 关于你：名字、角色、主要工作、偏好
    2. 关于我（AI）：你希望我是什么风格？边界在哪？
    3. 关于工作区：你的文件怎么组织？什么习惯？
  → 每轮对话后 AI 评估：信息是否足够？
    → ≥3 轮 + 用户表示 OK/可以了/差不多了 → 触发完成
    → 用户继续主动聊 → 继续收集，不打断
    → 用户明确说结束 → 立即完成
  → 完成时：
    1. AI 用 tool 写入 6 个文件
    2. 明确告知用户："初始设置完成！我已经创建了以下文件：..."
    3. 展示摘要（不需要用户看完整文件）
    4. 设置 state.onboardingComplete = true
```

### 结束检测改进

**旧方案（废弃）**：AI 输出 `onboarding-complete` JSON fence → 前端正则检测 → 调后端 API。脆弱、用户不知道什么时候结束。

**新方案**：
- AI 在对话中自然说出"好的，我已经准备好了，让我来创建配置文件"
- AI 调用 `workspace_write` MCP tool 写文件（或调用现有的 POST /api/workspace/onboarding）
- 写完后 AI 明确说"设置完成！从现在开始我会按照这些配置来帮你。"
- 前端检测 `state.onboardingComplete` 变化，更新 UI

**防重复触发**：
- `state.onboardingComplete === true` 后，永远不再触发 onboarding
- 用户要重新设置 → 设置页手动重置（已有此功能）

### claude.md 内置最佳实践

生成的 claude.md 包含两部分：**系统预设规则**（固定）+ **用户个性化规则**（对话中收集）。

**系统预设规则（不需要用户回答就应该有的）：**

```markdown
## 时间感知
任何涉及时间的场景，先用 date 命令确认当前时间，不要凭记忆猜测。

## 记忆规则
- 用户说"记一下"或"记住"：保留原文存笔记，不添加 TODO，不"发挥"，不改写
- 重要决策和稳定偏好 → 写入 memory.md（追加，不覆写）
- 日常工作记录 → 写入 memory/daily/{日期}.md
- 修改 soul.md / user.md / claude.md → 必须告知用户

## 文档组织
- 双向链接：使用 [[文件名]] 创建文档之间的链接
- 反向链接：追踪哪些文档引用了当前文档
- 标签系统：使用 #标签 进行分类和检索
- 属性标记：在文档顶部使用 YAML frontmatter 添加元数据
- 少用文件夹层级，多用标签和链接做组织

## 写作约束
- 不使用空泛修饰词（核心能力、关键、彰显、赋能、驱动…）
- 不使用"不是...而是..."对比句式，除非用户要求
- 输出内容以实用为主，不添加不必要的修饰

## 操作安全
- 修改身份文件（soul/user/claude.md）后必须通知用户具体改了什么
- memory.md 只追加，不覆写已有内容
- 不在记忆文件中存储密码、API key 等敏感信息
```

**用户个性化规则**（对话中收集后追加）：
- 文件夹哲学（按项目/时间/主题/混合）
- 默认收件箱位置
- 归档策略
- 其他用户主动提到的偏好

### 生成的文件质量提升

**soul.md 生成 prompt 改进**（从一句话 → 结构化引导）：

```
根据与用户的对话，生成 soul.md。参考以下结构：

## 核心性格
（1-2 句话定义助理的基本性格特征）

## 沟通风格
（具体的：简洁/详细、正式/随意、主动/被动）

## 行为边界
（用户明确的禁区和偏好）

## 与用户的关系
（怎么称呼用户、对话的基调）

保持在 1500 字符以内。用第二人称（"你是..."）。
每条规则要具体可执行，不要泛泛而谈。
```

**user.md 生成 prompt 改进**：

```
根据与用户的对话，生成 user.md。参考以下结构：

## 基本信息
（称呼、角色、主要工作领域）

## 当前目标
（用户提到的近期目标或关注点）

## 偏好
（已知的工作习惯和偏好，用具体条目列出）

## 工作区组织
（用户的文件组织方式和习惯）

保持在 1500 字符以内。用第三人称。
只写对话中明确提到的信息，不要推测。
```

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/lib/context-assembler.ts` | 重写 `buildOnboardingInstructions()`，新的对话式引导 prompt |
| `src/lib/onboarding-processor.ts` | 重写文件生成逻辑，提升 prompt 质量 |
| `src/app/api/workspace/onboarding/route.ts` | 适配新流程 |
| `src/components/chat/ChatView.tsx` | 适配新的完成检测（去掉 fence 检测） |
| `src/lib/assistant-workspace.ts` | 更新 claude.md 模板（内置规则） |

---

## Phase 2：Check-in → Heartbeat

> 深度参考：OpenClaw heartbeat-runner.ts（wake 队列 + HEARTBEAT_OK + transcript 裁剪）、CoPaw heartbeat.py（简单 interval + HEARTBEAT.md + active hours）

### 目标

3 题固定问卷 → HEARTBEAT.md 驱动的智能检查。有事才说，没事静默。

### 设计决策

深入分析 OpenClaw 和 CoPaw 后的取舍：

| 机制 | OpenClaw 做法 | CoPaw 做法 | 我们的选择 | 理由 |
|------|-------------|-----------|-----------|------|
| 调度 | wake 队列 + 优先级去重 + 自动重试 | APScheduler IntervalTrigger | **简单 setInterval**（像 CoPaw） | 我们只有单 agent，不需要多 agent 优先级队列 |
| HEARTBEAT_OK 检测 | HTML/Markdown 解包 + 首尾匹配 + ≤300 chars 静默 | **没有此协议** | **学 OpenClaw**，完整实现 | 核心体验：没事就不打扰 |
| 用户消息冲突 | 检查 main queue → 跳过 + 1s 重试 | 无处理 | **学 OpenClaw**，检查活跃流 | 防止 heartbeat 插队用户对话 |
| Context 模式 | `lightContext`（只 HEARTBEAT.md）+ `isolatedSession`（无历史） | 完整 agent | **轻量模式**：只注入 HEARTBEAT.md + 最近 daily memory | 省 token，心跳不需要完整 workspace |
| 空文件检测 | 正则跳过纯 heading + 空 checklist | `strip()` 后空就跳过 | **学 OpenClaw**，正则检测 | 用户可能留了 heading 但没有实际内容 |
| transcript 裁剪 | HEARTBEAT_OK 后截断 transcript 到心跳前的大小 | 无 | **学 OpenClaw** | 防止无信息量的 OK 轮次污染上下文 |
| 去重 | `lastHeartbeatText` 防 24h 内重复发送 | 无 | **学 OpenClaw** | 防止同样的提醒反复推送 |
| Active Hours | 完整的时区感知 window | `HH:MM` 解析 + 本地时间 | **简单版**（像 CoPaw） | 我们暂时只在本地 UI 使用，不需要跨时区 |
| 投递控制 | 4 层 visibility + 多渠道 | target=main/last | **暂不做投递**，只在本地 UI 显示 | 未来有定时任务 + 通知后再接入 |

### 交互流程

```
用户打开助理 workspace 会话
  → 检查 shouldRunHeartbeat(state, streamManager)
    → onboardingComplete === false → 跳过
    → heartbeatEnabled === false → 跳过
    → lastHeartbeatDate === today → 跳过
    → 当前有活跃 stream（用户消息在飞）→ 跳过，等空闲后重试
    → HEARTBEAT.md 内容为空（纯 heading / 空 checklist）→ 跳过
  → 轻量 context 加载：
    → HEARTBEAT.md（检查清单）
    → 最近 2 天的 daily memory（今天 + 昨天）
    → memory.md（长期记忆，用于回顾）
    → 不加载：soul.md / user.md / claude.md / 检索结果 / CLI tools / widget
  → 注入 heartbeat system prompt
  → AI 自主判断：
    → 读 HEARTBEAT.md 检查清单逐项检查
    → 回顾最近的 daily memory
    → 检查未完成事项、临近 deadline 等
  → 判断结果：
    → 没什么事 → 回复包含 HEARTBEAT_OK → 静默处理
    → 有事要说 → 自然地提出来
  → 对话中 AI 自主决定写哪里：
    → memory/daily/{日期}.md → 今天的记录
    → memory.md → 稳定偏好（追加）
    → user.md → 用户画像变化（告知用户）
```

### HEARTBEAT.md 默认模板

```markdown
# 心跳检查清单

每次心跳时按以下清单检查，如果都没有需要关注的事项，回复 HEARTBEAT_OK。

- [ ] 最近的 daily memory 中有没有未完成的事项或待跟进的事情
- [ ] 用户上次提到的 deadline 或计划是否临近
- [ ] 是否超过 3 天没有互动（如果是，轻量问候）
- [ ] 工作区中是否有新增或变动的文件需要更新索引

## 不要做的事
- 不要重复上次已经讨论过的内容
- 不要问固定的问卷问题
- 不要在深夜时段（23:00-08:00）打扰，除非有紧急事项
- 如果用户上次明确说"今天不需要了"，今天就不要再触发
```

用户可以自己编辑这个文件来定制检查内容。

### HEARTBEAT_OK 协议（学 OpenClaw，完整实现）

**检测逻辑**（参考 OpenClaw `stripHeartbeatToken()`）：

```typescript
const HEARTBEAT_TOKEN = 'HEARTBEAT_OK';
const MAX_ACK_CHARS = 300; // ≤300 chars 附带内容也算静默

function stripHeartbeatToken(raw: string): { shouldSkip: boolean; text: string; didStrip: boolean } {
  if (!raw?.trim()) return { shouldSkip: true, text: '', didStrip: false };

  let text = raw.trim();

  // 1. 解包 HTML/Markdown 包装（AI 可能输出 **HEARTBEAT_OK** 或 <b>HEARTBEAT_OK</b>）
  const unwrapped = text
    .replace(/<[^>]*>/g, ' ')        // 去 HTML 标签
    .replace(/^[*`~_]+/, '')         // 去 Markdown 前缀
    .replace(/[*`~_]+$/, '');        // 去 Markdown 后缀

  // 2. 在原始和解包文本中都尝试匹配
  for (const candidate of [text, unwrapped]) {
    if (!candidate.includes(HEARTBEAT_TOKEN)) continue;

    // 从首尾剥离 token（允许尾部最多 4 个非字母字符如 . ! ）
    let stripped = candidate.trim();
    let didStrip = false;

    if (stripped.startsWith(HEARTBEAT_TOKEN)) {
      stripped = stripped.slice(HEARTBEAT_TOKEN.length).trimStart();
      didStrip = true;
    }
    const tailPattern = new RegExp(`${HEARTBEAT_TOKEN}[^\\w]{0,4}$`);
    if (tailPattern.test(stripped)) {
      const idx = stripped.lastIndexOf(HEARTBEAT_TOKEN);
      stripped = stripped.slice(0, idx).trimEnd();
      didStrip = true;
    }

    if (didStrip) {
      // 剩余内容 ≤ 300 chars → 视为无实质内容，跳过投递
      if (!stripped || stripped.length <= MAX_ACK_CHARS) {
        return { shouldSkip: true, text: '', didStrip: true };
      }
      // 剩余内容 > 300 chars → 有实质内容，剥离 token 后投递
      return { shouldSkip: false, text: stripped, didStrip: true };
    }
  }

  // 没有匹配到 token → 正常内容
  return { shouldSkip: false, text, didStrip: false };
}
```

**处理流程：**

```
AI 回复到达
  → stripHeartbeatToken(replyText)
  → shouldSkip === true:
    → 标记 state.lastHeartbeatDate = today
    → 不显示消息（或极简 "✓ 一切正常"）
    → 不触发标题更新
    → 裁剪 transcript（见下方）
  → shouldSkip === false:
    → 正常显示 AI 的消息（stripped text，去掉了 token）
    → 标记 state.lastHeartbeatDate = today
    → 记录 lastHeartbeatText 用于去重
```

### Transcript 裁剪（学 OpenClaw，防上下文污染）

HEARTBEAT_OK 的轮次（用户 prompt + AI 回复）是零信息量的。如果留在对话历史里，会浪费后续的 token 预算。

```
heartbeat 触发前：
  → 记录当前消息数量 preHeartbeatMessageCount

heartbeat 完成 + shouldSkip === true：
  → 从 DB 删除本次 heartbeat 产生的消息（trigger message + AI reply）
  → 或者标记这些消息 isHeartbeatAck = true，在 fallback history 加载时过滤
```

选择第二种方案（标记而非删除），因为用户可能想查看历史心跳记录。`messages` 表加一个 `is_heartbeat_ack` 列。

### 用户消息优先（学 OpenClaw，防 heartbeat 插队）

```
shouldRunHeartbeat() 检查：
  → stream-session-manager 是否有活跃 stream？
    → 有 → return false（用户正在对话，不打断）
  → conversation-registry 是否有该 session 的活跃 SDK 会话？
    → 有且正在处理 → return false

heartbeat 执行中用户发消息：
  → heartbeat 的 stream 不影响用户消息（不同的 stream slot）
  → 但 heartbeat 回复如果是 HEARTBEAT_OK → 静默丢弃，不干扰用户对话流
```

### 空文件检测（学 OpenClaw，正则版）

```typescript
function isHeartbeatContentEmpty(content: string | null | undefined): boolean {
  if (!content?.trim()) return true;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;                          // 空行
    if (/^#+(\s|$)/.test(trimmed)) continue;         // Markdown heading
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) continue;  // 空 checklist 项
    if (trimmed.startsWith('//') || trimmed.startsWith('#!')) continue;  // 注释
    return false;  // 找到实际内容
  }
  return true;  // 全是 heading / 空 checklist / 注释
}
```

用户留了模板 heading 但没写具体检查项 → 不浪费 API 调用。

### 去重（学 OpenClaw）

```typescript
// state 扩展
interface AssistantWorkspaceState {
  // ...
  lastHeartbeatText?: string;      // 上次心跳投递的内容
  lastHeartbeatSentAt?: number;    // 上次心跳投递的时间戳
}

// 投递前检查
if (state.lastHeartbeatText === normalizedReply &&
    state.lastHeartbeatSentAt &&
    Date.now() - state.lastHeartbeatSentAt < 24 * 60 * 60 * 1000) {
  // 24h 内相同内容 → 跳过投递
  return;
}
```

### Active Hours（简单版，像 CoPaw）

```typescript
function isWithinActiveHours(config: WorkspaceConfig): boolean {
  const hours = config.heartbeat?.activeHours;
  if (!hours?.start || !hours?.end) return true;  // 未配置 → 始终允许

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startH, startM] = hours.start.split(':').map(Number);
  const [endH, endM] = hours.end.split(':').map(Number);
  const startMinutes = startH * 60 + (startM || 0);
  const endMinutes = endH * 60 + (endM || 0);

  if (endMinutes > startMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // 跨午夜（如 22:00 - 08:00）
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
```

使用本地时间，不需要跨时区处理（桌面应用直接用系统时间）。

### 轻量 Context 模式

心跳不需要完整 workspace prompt。只注入最小必要上下文：

| 文件 | 正常助理对话 | 心跳模式 | 理由 |
|------|------------|---------|------|
| HEARTBEAT.md | 不加载 | ✅ 加载 | 检查清单 |
| memory/daily（今天+昨天） | ✅ | ✅ | 需要知道最近做了什么 |
| memory.md | ✅ | ✅ | 需要知道长期偏好和待办 |
| soul.md | ✅ | ❌ | 心跳不需要人格 |
| user.md | ✅ | ❌ | 心跳不需要用户画像 |
| claude.md | ✅ | ❌ | 心跳不需要执行规则 |
| README.ai.md / PATH.ai.md | ✅ | ❌ | 心跳不需要目录索引 |
| 检索结果 | ✅ | ❌ | 心跳不做检索 |

估算：正常助理 ~40K chars → 心跳 ~10K chars，省 75% token。

### 心跳 system prompt

```
<assistant-project-task type="heartbeat">
这是一次心跳检查。请按照 HEARTBEAT.md 中的检查清单逐项检查。

规则：
- 如果所有检查项都无需关注，回复中包含 HEARTBEAT_OK
- 如果有需要告诉用户的事情，自然地说出来，不要用问卷格式
- 你可以在对话中更新文件：
  - memory/daily/{今天日期}.md：追加今天的记录
  - memory.md：追加新发现的稳定偏好或事实
  - user.md：更新用户画像（更新后必须告知用户）
  - HEARTBEAT.md：更新检查清单（如果用户要求或你发现需要调整）
- 不要问固定的问卷问题
- 不要重复上次已讨论的内容
</assistant-project-task>
```

### 触发时机

**当前**（无定时任务）：
- 用户打开助理 workspace 会话时检查
- `shouldRunHeartbeat(state, streamManager)`:
  1. `onboardingComplete === true`
  2. `heartbeatEnabled === true`（设置开关）
  3. `lastHeartbeatDate !== today`
  4. `isWithinActiveHours(config)`
  5. 无活跃 stream（用户消息优先）
  6. HEARTBEAT.md 非空

**未来**（有定时任务后）：
- 接入 TaskScheduler，按配置的间隔触发（默认 30m，像 CoPaw）
- 支持多渠道投递（系统通知 / Bridge）
- 可配置 `target: 'last'`（发到最近用的渠道）

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/lib/assistant-workspace.ts` | `shouldRunHeartbeat()` 替代 `needsDailyCheckIn()`；`loadHeartbeatMd()`；`isHeartbeatContentEmpty()`；`initializeWorkspace()` 创建 HEARTBEAT.md 模板 |
| `src/lib/heartbeat.ts` | **新建**：`stripHeartbeatToken()`、`isWithinActiveHours()`、去重逻辑 |
| `src/lib/context-assembler.ts` | 新增 `assembleHeartbeatContext()` 轻量模式；heartbeat system prompt 替代 `buildCheckinInstructions()` |
| `src/lib/checkin-processor.ts` | 废弃（heartbeat 不需要固定的文件生成流程，AI 自主决定写哪里） |
| `src/app/api/workspace/checkin/route.ts` | 简化或废弃，改为通用的 heartbeat 完成回调 |
| `src/components/chat/ChatView.tsx` | heartbeat 触发逻辑；`detectHeartbeatOk()` 替代 `detectAssistantCompletion()` 的 checkin 分支；transcript 裁剪 |
| `src/lib/db.ts` | `messages` 表加 `is_heartbeat_ack` 列；fallback history 过滤 |

### State 变更

```typescript
interface AssistantWorkspaceState {
  onboardingComplete: boolean;
  lastHeartbeatDate: string | null;    // 替代 lastCheckInDate
  lastHeartbeatText?: string;          // 新增：去重用
  lastHeartbeatSentAt?: number;        // 新增：去重用
  heartbeatEnabled: boolean;           // 替代 dailyCheckInEnabled
  schemaVersion: number;               // 升到 5
  hookTriggeredSessionId?: string;
}
```

V4 → V5 迁移：
- `lastCheckInDate` → `lastHeartbeatDate`（值不变）
- `dailyCheckInEnabled` → `heartbeatEnabled`（值不变）
- 新增 `lastHeartbeatText`、`lastHeartbeatSentAt`（初始化为空）

### Workspace Config 扩展

```typescript
// .assistant/config.json 新增
interface HeartbeatConfig {
  activeHours?: {
    start: string;   // "09:00"
    end: string;     // "22:00"
  };
  // 未来扩展：
  // every?: string;        // "30m" — 接入定时任务后生效
  // target?: 'none' | 'last';  // 投递目标
}
```

---

## Phase 3：渐进式文件更新

### 目标

身份文件（soul/user/claude）不再只在 onboarding/checkin 时更新，日常对话中 AI 自主发现并更新。

### 实现

在助理模式的 system prompt（Layer 2 或 Layer 3）追加文件更新指引：

```
## 记忆与文件更新

你可以在对话中随时更新 workspace 文件：

### 身份文件（修改后必须告知用户）
- soul.md：你的风格和行为规则变化时更新
- user.md：用户画像变化时更新
- claude.md：执行规则变化时更新

### 记忆文件（可以静默更新）
- memory.md：追加稳定的事实和偏好（只追加，不覆写）
- memory/daily/{日期}.md：记录今天的工作和决策

### 更新判断标准
- 用户明确要求记住/修改某规则 → 立即更新
- 用户连续 3 次表达同一偏好 → 写入 user.md 或 soul.md
- 重要决策或经验总结 → 写入 memory.md
- 日常工作记录 → 写入 daily memory
- 不确定是否值得记录 → 先不写，多观察

### 禁止
- 不要在身份文件中存储敏感信息（密码、API key）
- 不要覆写 memory.md 已有内容（只追加）
- 不要在没有告知用户的情况下修改 soul/user/claude.md
```

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/lib/context-assembler.ts` | 助理模式 system prompt 追加文件更新指引 |

改动很小——核心是 prompt engineering，不需要新代码。

---

## Phase 4：Memory Flush（压缩前自动写盘）

### 目标

对话接近 token 上限时，在压缩前自动把未写盘的重要信息保存到 daily memory。

### 前提

需要确认 Claude Agent SDK 是否支持：
1. 在 auto-compaction 前插入一轮 hook
2. 或者获取当前 session 的 token 使用量来主动触发

**如果 SDK 不支持**：用消息数量估算（比如超过 30 轮对话后主动触发一次 flush）。

### Flush prompt

```
上下文即将被压缩。请回顾当前对话中尚未写入文件的重要信息，追加到 memory/daily/{今天日期}.md。

规则：
- 只追加，不覆写已有内容
- 只保存值得记住的信息（决策、偏好、重要事实）
- 不保存对话细节或临时讨论
- 不修改 soul.md / user.md / claude.md / memory.md
- 如果没有需要保存的内容，什么都不做
```

### Flush 时的工具约束

只允许 Read + Write/Edit，不允许 Bash / MCP 等。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/lib/claude-client.ts` | 监测 token 使用或消息轮数，触发 flush |
| `src/lib/context-assembler.ts` | flush 专用 system prompt |
| `src/app/api/chat/route.ts` | flush 请求的特殊处理（限制工具） |

---

## 不改的部分

- 六文件结构保留（soul / user / claude / memory / daily / README+PATH）
- 三层记忆架构保留（长期 → 短期 → 归档）
- workspace prompt 预算体系保留（40K chars + 优先级）
- 关键词检索保留（向量检索后续单独做）
- claude.md 永不丢弃的约束保留
- 归档和 promotion 机制保留（但 promotion 不再依赖 check-in 触发，改为心跳时 AI 自主判断）

## 验证计划

### Phase 1 验证
- 新建助理 workspace → 对话式 bootstrap 自然展开
- ≥3 轮对话后说"可以了" → AI 明确结束并生成文件
- 生成的 claude.md 包含内置规则（时间感知、记一下、文档组织等）
- 再次进入不会重复触发 onboarding

### Phase 2 验证
- 打开助理会话 → heartbeat 触发 → AI 检查后回复 HEARTBEAT_OK 或有事要说
- HEARTBEAT_OK 时前端静默处理
- 有事时 AI 自然对话，可以更新文件
- 当天再次打开不重复触发

### Phase 3 验证
- 日常对话中说"以后别用这种语气" → AI 更新 soul.md 并告知
- 提到新的工作方向 → AI 更新 user.md 并告知
- 说"记一下 XXX" → AI 原文写入 daily memory，不加工

### Phase 4 验证
- 长对话（>30 轮）后观察 daily memory 是否有 flush 写入
- flush 写入的内容是有价值的摘要，不是对话原文
- 身份文件未被 flush 修改
