# 工具调用 UX 竞品调研 — Claude Code / CraftAgent / Opencode / Codex

> 目标：调研四个主流 AI Coding 客户端的工具调用展示与交互设计，提炼 CodePilot 可借鉴的优化方向。
> 关联文档：thinking display 实现方案（原文已删除，见 git 历史）

## 调研对象

| 项目 | 技术栈 | 形态 | 源码位置 |
|------|--------|------|---------|
| Claude Code | TypeScript + Ink (Terminal React) | CLI/TUI | 本地快照（已不保留） |
| CraftAgent | React + Framer Motion | Electron 桌面端 + Web Viewer | craft-agents-oss |
| Opencode | SolidJS + WAAPI 动画 | Web 应用 | opencode |
| Codex | Rust + ratatui | TUI | openai/codex |

---

## 一、思考过程展示

### 1.1 各项目对比

| 维度 | Claude Code | CraftAgent | Opencode | Codex |
|------|------------|------------|----------|-------|
| **数据源** | extended thinking API（有 thinking block 但被静默丢弃） | 不用 extended thinking；工具间的 LLM 文本作为 chain-of-thought | extended thinking reasoning block | reasoning delta |
| **流式展示** | 无（仅占位 shimmer） | spinner + "Thinking..."；完成后显示 stripped markdown 摘要 | 提取第一个 `**粗体**` 标题作为 shimmer 摘要，完整内容可选展开 | 实时提取 `**bold**` 作为状态栏标题（如 "Working > Planning solution"） |
| **持久化** | 无 | 作为 `intermediate` activity 保留在 turn 中 | reasoning block 完整保留，可配置是否显示 | 全文存为 transcript-only cell（主界面不显示，Ctrl+T 查看） |
| **折叠策略** | 无 | activity row 展开可见 | 可折叠，标题始终可见 | 无 bold 的 reasoning 仅出现在 transcript overlay |

### 1.2 关键设计洞察

**Opencode 的标题提取**是最优雅的方案：从 thinking 内容中提取第一个粗体或标题行，折叠状态下作为 shimmer 摘要显示。用户不展开也能一眼看出模型在想什么。

```typescript
// Opencode 标题提取逻辑（session-turn.tsx:110-136）
function heading() {
  // 匹配 ATX heading (#)、setext (==)、HTML <h1>、bold **...**
  // 提取后作为 TextReveal 动画内容
}
```

**Codex 的 reasoning 驱动状态栏**：thinking delta 实时更新状态指示器标题。用户始终能看到当前推理阶段，不需要额外展开操作。

**CraftAgent 的 intermediate text**：不依赖 extended thinking API，利用模型在工具调用间的普通文本输出作为 chain-of-thought 显示。这是一个 fallback 方案——当 thinking 不可用时仍能提供推理可见性。

### 1.3 对 CodePilot 的建议

在现有 thinking display 方案基础上增强：

1. **标题提取**（借鉴 Opencode/Codex）：从 thinking 内容中提取第一个粗体/标题行，折叠时显示为摘要，替代当前的纯时间标签 "Thought for N seconds"
2. **Reasoning 组件流式阶段可用，但完成态需要额外处理**：`src/components/ai-elements/reasoning.tsx` 已有完整的折叠 + 计时 + Streamdown 渲染能力，流式阶段接入数据即可工作。但 **完成态有断裂**：`stream-session-manager.ts:397-415` 的 `finalMessageContent` 只序列化 `text`/`tool_use`/`tool_result` 三种 block，`useStreamSubscription` 消费后生成的临时 assistant message 不含 thinking；`MessageItem.tsx:340` 的 `parseToolBlocks()` 也只解析这三类。如果不持久化 thinking 到 DB，历史消息中永远没有 reasoning 展示。需要决定：要么在 finalMessageContent 中加入 thinking block 并扩展 parseToolBlocks，要么接受 thinking 仅在流式阶段可见
3. **⚠️ Intermediate text 作为 fallback 目前不可行**（借鉴 CraftAgent 的方向对，但现有链路不支持）：当前 `useSSEStream.ts:51` 只有一个单调累积的 `accumulated` 字符串，不知道哪段文本发生在某次 tool_use 前后；`stream-session-manager.ts:277-280` 的 `onText` 也只是整体覆盖 `accumulatedText`。完成态进一步压缩为单个 text block + tool pairs（`stream-session-manager.ts:397-415`），丢失了文本与工具调用的交错顺序。要做到 CraftAgent 的 intermediate text 效果，需要先重构文本累积为分段感知（记录每段文本对应的 tool_use 上下文），这是一个独立的中等改动

---

## 二、工具调用展示

### 2.1 工具渲染架构

| 项目 | 架构模式 | 核心组件 |
|------|---------|---------|
| **Claude Code** | 每个 Tool 对象自带 4 个渲染方法（`renderToolUseMessage` / `renderToolUseProgressMessage` / `renderToolResultMessage` / `renderGroupedToolUse`），无中央调度 | `Tool.ts` 定义接口，各工具自实现 |
| **CraftAgent** | 中央 `TurnCard` 组件（3100+ 行），内部按 activity type 分发渲染 | `TurnCard.tsx` + `ActivityRow` |
| **Opencode** | **ToolRegistry 注册表模式**，每个工具 `register({ name, render })`，渲染时查表分发 | `message-part.tsx` → `ToolRegistry` |
| **Codex** | `HistoryCell` trait，每个 cell 类型实现 `display_lines()` | `history_cell.rs` + `exec_cell/render.rs` |

**Opencode 的 ToolRegistry** 是最适合 CodePilot 参考的模式——声明式注册，新增工具只需一行 `register()`，比我们当前统一 `ToolCallBlock` 灵活得多，又比 Claude Code 的自包含 Tool 对象更轻量。

**⚠️ 前置依赖：统一 tool view-model**。当前 `ToolActionsGroup`（`tool-actions-group.tsx:24-31`）的 `ToolAction` 接口只有 `id`/`name`/`input`/`result`/`isError`/`media` 这些通用字段，缺乏分类型渲染所需的结构化数据（diff 内容、URL、子任务链接、取消态等）。更关键的是 **`is_error` 在 SSE 到前端的链路中被丢弃**：`claude-client.ts:1139-1142` 发送的 `tool_result` SSE 包含 `is_error` 字段，但 `useSSEStream.ts:73-84` 解析时没有提取它，`ToolResultInfo`（`types/index.ts:953-957`）也没有 `is_error` 字段定义。因此前端目前 **无法区分工具成功和失败**。要做分类型渲染，需要先：
1. 在 `ToolResultInfo` 类型中加入 `is_error?: boolean`
2. 在 `useSSEStream.ts` 的 `tool_result` case 中提取 `is_error`
3. 设计一个扩展的 tool view-model（或保持 ToolAction 但补充必要字段）

### 2.2 工具分类型渲染

**Opencode 的 16 种专属工具渲染器（最细致）：**

| 工具 | 图标 | 变体 | 特殊处理 |
|------|------|------|---------|
| `read` | glasses | row（不可折叠） | 显示文件路径 |
| `bash` | console | panel（可折叠） | spring 动画高度，复制按钮 |
| `edit` | code-lines | panel | **Diff view**（Accordion 展开） |
| `write` | code-lines | panel | 文件内容预览 |
| `glob`/`grep` | magnifying-glass | panel | 搜索结果列表 |
| `webfetch` | window-cursor | row | 可点击 URL |
| `task` | task | row | 链接到子会话 |
| `todowrite` | checklist | panel | 进度分数 |
| `question` | bubble | panel | 已回答摘要 |

**CraftAgent 的差异化处理：**
- MCP 工具：`SourceName · intent · toolSlug · inputSummary`
- Native 工具：`DisplayName · intent/description · inputSummary`
- Edit/Write 工具额外显示 `+N/-N` diff stats badge（绿/红）

**Claude Code 的 4 层渲染回调：**

| 方法 | 时机 | 用途 |
|------|------|------|
| `renderToolUseMessage(input)` | 调用开始（参数边流边显示） | 工具调用头部 |
| `renderToolUseProgressMessage(progress)` | 执行中 | 进度条/spinner |
| `renderToolResultMessage(content)` | 执行完成 | 结果展示 |
| `renderGroupedToolUse(toolUses)` | 并发同类工具 | 折叠展示 "Reading 5 files" |

### 2.3 上下文工具归组

这是 Opencode 和 Codex 的共同亮点——把连续的"信息收集"工具调用折叠为一组。

**Opencode**：`read`、`glob`、`grep`、`list` 自动归为 **"Gathering context"** 组：
- 执行中：显示 `ContextToolRollingResults`——滚动窗口实时展示正在读取的文件名
- 完成后：折叠为 "Gathered context" + `AnimatedCountList` 摘要
- 用户可展开查看每个工具的详细结果

**Codex**："Exploring" 模式把多个读操作合并为树状缩进：
```
• Exploring
  └ Read  src/lib/db.ts
  └ Search  "migration" in src/
  └ List  src/components/
```

**Claude Code**：`renderGroupedToolUse` 方法支持同类工具折叠渲染，但需要工具自行实现。

**对 CodePilot 的建议**：实现上下文工具归组，当连续出现 3+ 个 Read/Glob/Grep 时自动折叠为"收集上下文"组，保留展开查看详情的能力。

---

## 三、工具执行进度与动画

### 3.1 进度指示

| 项目 | 执行中指示 | 完成指示 | 错误指示 |
|------|-----------|---------|---------|
| **Claude Code** | 自定义 `onProgress` 回调，MCP 支持进度条 | 工具自定义结果渲染 | `<tool_use_error>` 包裹，截断 10 行 |
| **CraftAgent** | status icon crossfade 动画（pending→spinner→✓），Framer Motion | 绿色 CheckCircle2 或工具特定 icon | 红色 XCircle + tooltip |
| **Opencode** | **TextShimmer** 标题闪烁 + RollingResults 滚动窗口 | shimmer 停止，icon 变化 | Card variant="error" + circle-ban-sign |
| **Codex** | cosine 波 shimmer 动画，计时器（Xs / Xm XXs） | bullet 变绿 | bullet 变红 + exit status |

### 3.2 流式输出控制

**CraftAgent 的智能内容缓冲（最精巧）：**

```typescript
const BUFFER_CONFIG = {
  MIN_WORDS_STANDARD: 40,    // 普通文本 40 词才显示
  MIN_WORDS_CODE: 15,        // 代码块 15 词就显示
  MIN_WORDS_LIST: 20,        // 列表 20 词
  MIN_WORDS_QUESTION: 8,     // 问题最快，8 词
  MIN_BUFFER_MS: 500,        // 至少等 500ms
  MAX_BUFFER_MS: 2500,       // 最多等 2.5s
  CONTENT_THROTTLE_MS: 300,  // DOM 更新节流
}
```

缓冲期间显示 "Preparing response..."，等内容足够有意义才 fade in。避免流式前几个字符的"抽搐"感。

**⚠️ 不能直接套用到 CodePilot**：`StreamingMessage.tsx:267-448` 依赖原始增量文本实时识别 `show-widget`（部分 fence 解析）、`batch-plan`（Image Agent 批处理模式）、`image-gen-request`（图像生成确认卡）等结构化块，并据此提前渲染 widget 预览和确认卡。如果全局缓冲 500ms/40 词，这些结构化块的检测会明显变慢，半成品预览（如 show-widget 的 partial JSON 实时渲染）会失效。**正确做法**：缓冲仅应用于纯文本流，结构化块检测逻辑需要旁路绕过缓冲直接处理。

**Codex 的自适应两档变速：**

- **Smooth 模式**：每 tick 渲染 1 行，平滑动画
- **CatchUp 模式**：队列 ≥8 行或最老行 ≥120ms 时全量释放
- 退出 CatchUp 有 250ms 滞后防抖，防抖期间不会来回切换
- 严重积压（≥64 行或 ≥300ms）无视防抖直接进 CatchUp

**Opencode 的内容节流：**
- `createThrottledValue` 100ms 间隔去抖
- `GrowBox` 用 spring 物理动画驱动高度变化，流式内容增长时容器平滑扩展

### 3.3 Bash 工具的流式输出

**Opencode** 的 `ShellRollingResults` 是最佳参考：
- 执行中：5 行高的滚动视窗，新行 wipe-in 动画入场
- 命令预览：`$ <first-line>` 作为 header
- 完成后：滚动视窗折叠，替换为完整可滚动代码块
- 全程 spring 动画驱动透明度和模糊度

---

## 四、工具并发与执行架构

### 4.1 并发模型

**Claude Code 的双层并发（最成熟）：**

| 层级 | 机制 | 说明 |
|------|------|------|
| 传统模式 | `partitionToolCalls` 分批 | 连续只读工具合并为并发批次，写入工具独占串行批次 |
| 流式模式 | `StreamingToolExecutor` | 模型还在生成时就开始执行完整的 tool_use block |

分批规则：
```
[read1, read2, read3, write1, read4, read5]
→ Batch1: {concurrent, [read1, read2, read3]}  // Promise.all, 上限 10
→ Batch2: {serial, [write1]}
→ Batch3: {concurrent, [read4, read5]}
```

**StreamingToolExecutor 关键行为：**
- 工具参数 JSON 完整后立即入队执行，不等整个 assistant message 结束
- Bash 出错会级联取消同批次兄弟工具（`siblingAbortController.abort`）
- `contextModifier` 队列按原始顺序应用，防止并发竞态

### 4.2 对 CodePilot 的启示

CodePilot 通过 SDK 调用工具，并发由 SDK 内部管理。但在前端展示层可以：
1. 识别并发执行的工具组，用 grouped rendering 折叠展示
2. 某个工具出错时，视觉上标记同批次的其他工具被取消

---

## 五、权限与审批

### 5.1 各项目对比

| 项目 | 审批模式 | 特色 |
|------|---------|------|
| **Claude Code** | 6 层权限管道（deny → ask → tool-check → safety → bypass → allow），Bash 分类器竞速自动批准 | 受保护路径（.git/ 等）即使 bypass 模式也拦截；分类器 2s 内返回高置信度匹配则免手动确认 |
| **CraftAgent** | Accept Plan 流程（Accept / Accept & Compact） | Plan 响应独立处理，支持压缩上下文后再执行 |
| **Opencode** | Dock 底部弹出权限面板：Deny / Allow Always / Allow Once | 三选按钮，简洁直接 |
| **Codex** | Overlay 弹窗：Yes(y) / Yes always(s) / No(n) + 单字母快捷键 | 键盘快捷键驱动，Ctrl+A 全屏查看 |

### 5.2 对 CodePilot 的建议

如果后续需要实现工具审批：
- 参考 Opencode 的三选按钮设计（最简洁）
- 借鉴 Claude Code 的分类器竞速机制（已知安全命令自动放行）

---

## 六、Turn 级折叠与会话结构

### 6.1 CraftAgent 的 Turn 折叠

每个 assistant turn（多个 activity + 最终 response）可折叠：

- **折叠态**：`[▸] 8 steps  Preview text...` + 操作菜单
- **展开态**：activities 带 staggered slide-in 动画（每项延迟 30ms，上限 10 项）
- 超过 15 个 activity 自动变滚动容器（`maxHeight = 15 × 24px`）
- 用户手动展开后自动滚到 activity 列表底部

### 6.2 Opencode 的 Turn 结构

每个 turn 结束后显示：
- **Handoff bar**：model 名称 + 耗时 + 复制按钮
- **Diff summary**：折叠的 "Modified N files"，展开为 Accordion diff view
- **Timeline staging**：旧 turn 分批渲染（初始 1 个，后续每批 3 个），避免首屏阻塞

### 6.3 对 CodePilot 的建议

Turn 级折叠是长对话可读性的关键——当一次回复包含 10+ 个工具调用时，折叠为 "8 steps" 摘要能大幅减少滚动距离。建议作为 P2 优化。

---

## 七、综合优化建议（按优先级排序）

### P0 — 核心体验提升

| 改动 | 参考 | 预期效果 |
|------|------|---------|
| 实现 thinking display + 标题提取 | 现有方案 + Opencode/Codex 标题提取 | 用户能看到模型推理过程，折叠时也有摘要 |
| 上下文工具归组（Read/Glob/Grep 折叠） | Opencode ContextToolGroup | 减少连续读文件时的视觉噪音 |

### P1 — 差异化体验

| 改动 | 参考 | 前置依赖 | 预期效果 |
|------|------|---------|---------|
| 修复 `is_error` 丢失 + 扩展 tool view-model | Claude Code `is_error` 传递链 | 无 | 工具错误态能正确展示，为分类型渲染打基础 |
| 工具注册表 + 分类型渲染 | Opencode ToolRegistry | ↑ tool view-model 就绪 | Bash→终端风格、Edit→diff view、Read→语法高亮 |
| 工具状态动画（shimmer / crossfade） | Opencode TextShimmer + CraftAgent status icon | 无 | 更有"正在工作"的感觉 |
| 纯文本流智能缓冲 | CraftAgent BUFFER_CONFIG | 需旁路结构化块（show-widget/batch-plan/image-gen） | 避免纯文本流式前几字符抖动 |

### P2 — 深度优化

| 改动 | 参考 | 前置依赖 | 预期效果 |
|------|------|---------|---------|
| Turn 级折叠 | CraftAgent TurnCard | 无 | 长对话可读性大幅提升 |
| 自适应流式节奏 | Codex 两档变速 | 无 | 快速输出不卡顿，慢速输出有节奏 |
| Bash 输出滚动窗口 | Opencode ShellRollingResults | ToolRegistry | 执行中实时看到输出，完成后折叠 |

### P3 — 锦上添花

| 改动 | 参考 | 前置依赖 | 预期效果 |
|------|------|---------|---------|
| Turn 完成后 diff 摘要 | Opencode diff summary | 无 | 一眼看到本轮修改了哪些文件 |
| Intermediate text 作为 thinking fallback | CraftAgent | **需先重构文本累积为分段感知**（见 1.3 分析） | 无 extended thinking 时也有推理可见性 |
| 工具审批 UI（如需要） | Opencode 三选按钮 | 无 | 简洁的权限确认交互 |

---

## 八、CodePilot 现有链路缺陷（需优先修复）

> 以下问题在实现任何优化方案前需要先解决，否则会影响上层功能的正确性。

### 8.1 `is_error` 在 SSE 链路中被丢弃

**问题**：`claude-client.ts:1139-1142` 发送的 `tool_result` SSE payload 包含 `is_error` 字段，但 `useSSEStream.ts:72-84` 解析时没有提取，`ToolResultInfo`（`types/index.ts:953-957`）类型定义中也没有该字段。前端无法区分工具成功/失败。

**影响**：工具错误态渲染不完整；分类型渲染无法区分成功/失败样式。

**修复**：
1. `types/index.ts` 的 `ToolResultInfo` 加 `is_error?: boolean`
2. `useSSEStream.ts` 的 `tool_result` case 提取 `resultData.is_error`
3. `stream-session-manager.ts` 透传到 snapshot
4. `tool-actions-group.tsx` 的 `ToolAction.isError` 已存在，只需上游传入

### 8.2 `finalMessageContent` 不含 thinking block

**问题**：`stream-session-manager.ts:397-415` 构建完成态消息时只序列化 `text`/`tool_use`/`tool_result`，thinking 内容在流式→完成态转换时丢失。`MessageItem.tsx:340` 的 `parseToolBlocks()` 也只解析这三类。

**影响**：thinking display 即使流式阶段实现了，完成后也会立即消失，直到 DB 回填（如果不持久化则永远不可见）。

**决策点**：
- A. 在 `finalMessageContent` 中加入 thinking block + 扩展 `parseToolBlocks` → thinking 在历史消息中始终可见，但增加存储
- B. 接受 thinking 仅流式可见 → 实现最简单，但用户翻阅历史时看不到推理过程
- C. 流式阶段持久化到 session 级缓存（非 DB）→ 当前会话可回看，新会话不可见

### 8.3 文本累积缺乏分段感知

**问题**：`useSSEStream.ts:51-54` 的 `onText` 把所有文本 delta 累积为单个字符串，不记录文本与 tool_use 的交错关系。完成态进一步压缩为单个 text block（`stream-session-manager.ts:400-401`）。

**影响**：无法实现 CraftAgent 的 "intermediate text"（工具调用间的推理文本独立展示），也无法实现精确的"第 N 个工具调用前的文本"定位。

**当前不阻塞 P0/P1 优化**，但若要做 intermediate text 功能需要先重构此处。
