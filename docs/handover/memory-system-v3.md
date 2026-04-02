# 记忆系统 V3 + V3.1 — 交接文档

> 产品思考见 [docs/future/core-system-guardrails.md](../future/core-system-guardrails.md)
> 执行计划见 [docs/exec-plans/active/memory-system-v3.md](../exec-plans/active/memory-system-v3.md)
> 后续增强见 [docs/future/memory-enhancements.md](../future/memory-enhancements.md)
> 助理体验升级见 [docs/future/assistant-ux-upgrade.md](../future/assistant-ux-upgrade.md)

## 概述

V3 重写了助理工作区的记忆系统：Onboarding 从 13 题问卷改为对话式 bootstrap，Check-in 从 3 题问卷改为 HEARTBEAT_OK 心跳协议，新增渐进式文件更新让 AI 在日常对话中自主学习用户偏好。

V3.1 将记忆从 system prompt 移出改为 MCP 按需检索，新增时间衰减、Obsidian frontmatter 感知、transcript 裁剪。

## 架构变更

### 记忆检索：从"全塞"到"按需"

**V2（旧）**：所有记忆文件（memory.md + daily memories + 检索结果 + root docs）塞进 system prompt，~40K chars。

**V3.1（新）**：system prompt 只保留身份层（soul/user/claude.md，~24K chars），记忆通过 MCP 工具按需检索。

```
System Prompt 组成：
  Layer 1: 身份层（soul.md + user.md + claude.md）← 始终注入
  Layer 2: Session prompt + systemPromptAppend
  Layer 3: 助理指令（onboarding / heartbeat / 渐进式更新）
  Layer 4-6: CLI tools / Widget / Dashboard（同 V2，unchanged）

  + <memory-hint> 标签告知 AI 有哪些 daily memory 可用
  + MEMORY_SEARCH_SYSTEM_PROMPT 指引首轮必调 memory_recent
```

### Memory Search MCP（`src/lib/memory-search-mcp.ts`）

助理模式下始终注册（非 keyword-gated），提供 3 个工具：

| 工具 | 用途 |
|------|------|
| `codepilot_memory_search` | 关键词搜索 + 30 天半衰期时间衰减 + tags 过滤 + file_type 过滤 |
| `codepilot_memory_get` | 读取指定文件（path.relative 安全校验 + 3K chars 截断 + wikilink 提取） |
| `codepilot_memory_recent` | 返回最近 3 天 daily memory + 长期记忆摘要（首轮回顾用） |

注册位置：`claude-client.ts`，在 `isAssistantProject` 条件内，先于 keyword-gated MCP 注册。

### 时间衰减

`applyTemporalDecay()` 对搜索结果应用指数衰减：
- 半衰期 30 天（`LAMBDA = ln(2) / 30`）
- 日期文件（`memory/daily/YYYY-MM-DD.md`）按文件名日期衰减
- 常青文件（`memory.md`、`MEMORY.md`、`Memory.md`、无日期文件）不衰减
- 90 天前的笔记只剩 ~12.5% 原始权重

### Obsidian 感知

- `codepilot_memory_search`：`tags` 参数从 YAML frontmatter 提取（通过 workspace-indexer manifest）
- `codepilot_memory_search`：`file_type` 参数区分 daily / longterm / notes
- `codepilot_memory_get`：提取 `[[wikilinks]]` 附在结果末尾作为关联文件提示
- 文件名大小写兼容：`memory.md` / `Memory.md` / `MEMORY.md` 均支持

## Onboarding 重写

### 旧流程（V2）
13 题固定问卷 → AI 逐题提问 → 用户在聊天框打字回答 → `onboarding-complete` JSON fence → 后端 4 个并行 AI 调用生成文件

### 新流程（V3）
3 主题对话式 bootstrap → AI 自然对话（不超过 5 个问题）→ 用户说"可以了"即结束 → 同样的 fence 机制 → 4 个结构化 prompt 生成文件

**关键改进：**
- prompt 强制"不超过 5 个问题"，3 轮后主动询问是否开始设置
- 接受自由格式 JSON（不再要求 q1-q13 固定 key）
- 4 个生成 prompt 全部重写（结构化引导 + 字符限制）
- claude.md 生成时必须包含 5 个系统预设规则区块

### claude.md 系统预设规则

`initializeWorkspace()` 和 `processOnboarding()` 生成的 claude.md 包含以下固定区块：

1. **时间感知**：先 `date` 确认时间
2. **记忆规则**："记一下"保留原文、memory.md 只追加、修改身份文件须告知
3. **文档组织**：`[[双向链接]]`、`#标签`、YAML frontmatter、少文件夹多标签
4. **写作约束**：不用空泛修饰词、不用对比句式
5. **操作安全**：身份文件修改通知、不存密码

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/lib/context-assembler.ts` | `buildOnboardingInstructions()` 重写 |
| `src/lib/onboarding-processor.ts` | 4 个 prompt 重写 + 自由 JSON + schema v5 |
| `src/lib/assistant-workspace.ts` | claude.md 模板含系统预设规则 |
| `src/i18n/en.ts` / `zh.ts` | 删除 Q1-Q13 共 26 个 key |

## Heartbeat 系统

### 旧流程（V2 Check-in）
3 题固定问卷 → `checkin-complete` JSON fence → 后端 3 个并行 AI 调用（daily memory + promotion + user update）

### 新流程（V3 Heartbeat）
读 HEARTBEAT.md 检查清单 → AI 自主判断有没有事 → HEARTBEAT_OK 静默 / 有事自然说出 → AI 自主决定写哪个文件

### 触发条件

`shouldRunHeartbeat(state, config)` — 所有条件为 true 才触发：
1. `state.onboardingComplete === true`
2. `state.heartbeatEnabled === true`
3. `state.lastHeartbeatDate !== today`
4. `isWithinActiveHours(config.heartbeat?.activeHours)`
5. 无活跃 stream（用户消息优先）
6. HEARTBEAT.md 内容非空（`isHeartbeatContentEmpty()` 检测）

### HEARTBEAT_OK 协议（`src/lib/heartbeat.ts`）

`stripHeartbeatToken(raw)` 检测逻辑：
1. 解包 HTML/Markdown 包装（`<b>HEARTBEAT_OK</b>` / `**HEARTBEAT_OK**`）
2. 从首尾剥离 token（允许尾部 4 个非字母字符）
3. 剩余内容 ≤300 chars → `shouldSkip: true`（视为静默）
4. 剩余内容 >300 chars → `shouldSkip: false`（有实质内容，剥离 token 后展示）

### Heartbeat 完成后的 state 更新（`route.ts` finally 块）

严格限定为 heartbeat turn（`isHeartbeatTurn = autoTrigger && content.includes('心跳检查')`）：
- **成功 + 非空回复**：写 `lastHeartbeatDate`，清 `hookTriggeredSessionId`
- **shouldSkip（纯 OK）**：额外调 `updateMessageHeartbeatAck(msgId, true)` 标记消息
- **失败 / 空回复**：不写 `lastHeartbeatDate`，当天可重试

### Transcript 裁剪

`messages` 表新增 `is_heartbeat_ack` 列（INTEGER DEFAULT 0）。

HEARTBEAT_OK 消息被标记后：
- `getMessages(sessionId, { excludeHeartbeatAck: true })` 过滤
- `GET /api/chat/sessions/[id]/messages` 默认过滤
- Fallback history（50 条）过滤
- Bridge conversation-engine 过滤

### 去重

`state.lastHeartbeatText` + `state.lastHeartbeatSentAt`：24h 内相同内容不重复展示。

### Active Hours

`isWithinActiveHours({ start, end })` — 本地时间 HH:MM 解析，支持跨午夜（如 22:00-08:00）。

### Telegram 通知静默

auto-trigger turns（onboarding + heartbeat）的所有 5 条 Telegram 出口全部静默：

| 出口 | 位置 | 守卫 |
|------|------|------|
| `notifySessionStart` | route.ts POST handler | `if (!autoTrigger)` |
| `notifySessionComplete` | collectStreamResponse finally | `if (!opts?.suppressNotifications)` |
| `notifySessionError` | collectStreamResponse finally | `if (!opts?.suppressNotifications)` |
| `notifyGeneric` (result error) | claude-client.ts result handler | `if (!autoTrigger)` |
| `notifyGeneric` (task_notification) | claude-client.ts system msg | `if (!autoTrigger)` |
| `notifyPermissionRequest` | claude-client.ts permission | `if (!autoTrigger)` |

### 作用域边界

心跳只对助理 workspace 生效（`session.working_directory === assistant_workspace_path`）。非助理项目走定时任务系统（尚未实现）。

### 涉及文件

| 文件 | 改动 |
|------|------|
| `src/lib/heartbeat.ts` | **新建**：stripHeartbeatToken + isHeartbeatContentEmpty + isWithinActiveHours + shouldSkipDuplicate + HEARTBEAT_TEMPLATE |
| `src/lib/context-assembler.ts` | `buildHeartbeatInstructions()` + `buildProgressiveUpdateInstructions()` + `assembleHeartbeatContext()` |
| `src/lib/assistant-workspace.ts` | `shouldRunHeartbeat()` + `loadHeartbeatMd()` + HEARTBEAT.md 创建 + V4→V5 迁移 |
| `src/hooks/useAssistantTrigger.ts` | heartbeat 触发条件 + 消息文案 |
| `src/app/api/chat/route.ts` | heartbeat state 更新 + ack 标记 + Telegram 静默 |
| `src/lib/claude-client.ts` | Telegram 旁路静默（3 处） |
| `src/lib/db.ts` | `is_heartbeat_ack` 列 + `updateMessageHeartbeatAck()` + `getMessages` 过滤 |
| `src/app/api/chat/sessions/[id]/messages/route.ts` | `excludeHeartbeatAck: true` |
| `src/lib/bridge/conversation-engine.ts` | fallback history 过滤 |

## 渐进式文件更新（Phase 3）

`buildProgressiveUpdateInstructions()` 在 onboarding 完成后的日常助理对话中注入，指引 AI 自主更新 workspace 文件：

- **身份文件**（soul/user/claude.md）：修改后必须告知用户
- **记忆文件**（memory.md / daily）：可静默更新
- **判断标准**：用户明确要求→立即更新；连续表达同一偏好→写入；不确定→先不写

## State 变更（V4 → V5）

```typescript
interface AssistantWorkspaceState {
  onboardingComplete: boolean;
  lastHeartbeatDate: string | null;      // 替代 lastCheckInDate
  lastHeartbeatText?: string;            // 去重
  lastHeartbeatSentAt?: number;          // 去重
  heartbeatEnabled: boolean;             // 替代 dailyCheckInEnabled
  schemaVersion: number;                 // 5
  hookTriggeredSessionId?: string;
  hookTriggeredAt?: string;
  // deprecated（保留兼容）
  lastCheckInDate?: string | null;
  dailyCheckInEnabled?: boolean;
}
```

`migrateStateV4ToV5()` 自动迁移：旧字段值复制到新字段，schema 升到 5。

## 关键约束

- `claude.md` 永不丢弃（overflow 时强制保留）
- `memory.md` 只追加不覆写
- heartbeat state 更新严格限定为 heartbeat turn（`autoTrigger && content.includes('心跳检查')`）
- heartbeat 失败/空回复不写 `lastHeartbeatDate`（当天可重试）
- auto-trigger turns 完全不发 Telegram 通知（5 条出口全部守卫）
- Memory MCP 路径校验用 `path.relative` 判断（不用 `startsWith`，兼容根目录 workspace）
- 文件名大小写兼容（memory.md / Memory.md / MEMORY.md）
- 心跳只对助理 workspace 生效，非助理项目不触发

## 质量保障改进（同期完成）

- ESLint error：48 → 0（47 个 no-explicit-any + 1 个 setState-in-effect）
- CI lint：去掉 `continue-on-error`，lint 失败阻塞 build/release
- Smoke 测试进 CI：`smoke-test` job 接入 build/release 依赖链
- E2E 断言修复：品牌 Claude → CodePilot
- 外链行为：`shell.openExternal` 打开系统浏览器

## 未实现（后续）

- **定时任务系统**：心跳目前只在打开会话时触发，定时调度需要 TaskScheduler（见 `docs/future/scheduled-tasks-and-notifications.md`）
- **Auto Flush**：压缩前自动写盘需要 SDK compaction hook（当前用渐进式更新 prompt 替代）
- **向量搜索**：当前是关键词 bigram，向量搜索需要 embedding 基础设施
- **GUI 记忆管理**：设置页可视化记忆面板
- **Onboarding Wizard**：前端组件替代 AI 对话式（见 `docs/future/assistant-ux-upgrade.md`）
