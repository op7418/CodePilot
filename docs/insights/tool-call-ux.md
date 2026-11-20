# 工具调用 UX 优化 — 产品思考

## 解决了什么用户问题

### 1. "AI 在干嘛我不知道"

工具调用期间用户只看到一个 "Thinking..." 闪烁文字，无法了解模型的推理过程。这在长时间工具调用链（30s+）时尤其焦虑——用户不知道模型是在正确方向上工作，还是已经跑偏了。

**方案**：将 Claude 的 extended thinking 内容以可折叠行的形式嵌入工具调用列表。流式过程中默认展开，完成后折叠。从 thinking 内容中提取第一个粗体/标题行作为折叠态摘要。

**设计决策**：thinking 作为工具调用列表的第一行（同级），而非独立区域。这避免了双层嵌套（Turn 折叠 + 工具折叠），用户一次展开就能看到全部内容。

### 2. "满屏都是 Read Read Read"

模型经常连续读 5-10 个文件，工具列表变成一堆重复的 Read 行，有效信息密度很低。

**方案**：3 个以上连续的信息收集工具自动归组为 "Gathering context (N)"。阈值选 3 而非 2，是因为刻意的双文件对比（如对比两个实现）不应被折叠。

**参考**：Opencode 的 ContextToolGroup + Codex 的 "Exploring" 模式。

### 3. "工具出错了我看不出来"

is_error 字段在 SSE 链路中被静默丢弃，成功和失败看起来完全一样。用户遇到问题时不知道哪个步骤出了错，只能翻工具输出文本找线索。

**方案**：修复全链路 is_error 传递，错误工具显示红色图标。

### 4. "文字一个一个蹦出来"

流式输出前几个字符时，DOM 更新频率很高，文字"抽搐"。尤其在中文回复时（每个字都是一次 delta）更明显。

**方案**：双重优化——前端 40 词/2.5s 智能缓冲 + 后端 100ms 文本节流。缓冲对结构化块（widget/plan/image）旁路直通，不影响即时预览。

## 为什么这样设计

### Thinking 作为工具行而非独立面板

最初实现了独立的 `Reasoning` 面板（在工具列表上方），但实际使用时发现两个问题：
1. 双层折叠——Turn 折叠和工具折叠嵌套，用户要点两次
2. 展开 thinking 时触发对话自动滚动，视觉跳动

改为将 thinking 作为工具列表的第一行后，结构扁平化，交互统一。Brain 图标 → hover 变箭头的设计参考了用户提供的 ChatGPT 截图中 "思考" 行的交互模式。

### 注册表模式而非 if/else 分类

原来的 `getToolCategory` / `getToolIcon` / `getToolSummary` 是硬编码的 if/else 链，新增工具类型需要改三个函数。ToolRegistry 模式让每种工具自描述（icon + summary + renderDetail），新增工具只需 `registerToolRenderer()` 一行。

参考了 Opencode 的 `ToolRegistry.register({ name, render })` 模式，但比它更轻——不需要独立文件，一个数组即可。

### 缓冲 + 节流而非纯节流

纯节流只解决更新频率，不解决"前几个字闪烁"。缓冲的核心价值是让首屏从"逐字出现"变为"一段话出现"，体感差异明显。但缓冲对结构化块是危险的（widget 半成品预览、image-gen 确认卡都依赖增量检测），所以必须有旁路。

## 竞品参考

| 功能 | 主要参考 | 取舍 |
|------|---------|------|
| Thinking 摘要提取 | Opencode（提取 `**bold**`/`# heading`）、Codex（reasoning 驱动状态栏） | 采用 Opencode 方案，Codex 的状态栏模式不适合 GUI |
| 上下文归组 | Opencode（ContextToolGroup）、Codex（Exploring 模式） | 采用 Opencode 方案，阈值从 2 改为 3 |
| 工具注册表 | Opencode（ToolRegistry） | 简化为数组 + match 函数，不需要独立文件 |
| 状态动画 | CraftAgent（Framer Motion crossfade） | 采用，spring scale 弹入效果 |
| 智能缓冲 | CraftAgent（BUFFER_CONFIG） | 简化配置（只留 word count + max ms），加结构化块旁路 |
| 文本节流 | Opencode（createThrottledValue 100ms） | 在 stream-session-manager 层实现，而非组件层 |

## 未来方向

- **Intermediate text**：CraftAgent 的工具调用间推理文本展示，需要先重构 `useSSEStream` 的文本累积为分段感知（目前单一字符串，无法区分 tool 前后的文本），改动量较大
- **Diff viewer**：当前只有文件名列表，没有行级 diff 预览。项目里没有 diff 组件（Git 页面也是 `<pre>` 裸文本），需要引入 diff 渲染库
- **工具审批 UI**：目前 CodePilot 没有工具审批流程，如果未来需要可参考 Opencode 的三选按钮（Deny / Allow Always / Allow Once）

## 已知局限

- Thinking 展开时调用 `stopScroll()` 会脱离自动滚动，流式过程中展开后新内容不会自动追到底部
- 历史消息中 bash renderDetail 始终展开，长输出占空间，可能需要加折叠
- Phase 分隔用 `---` 硬编码，如果 thinking 内容本身包含 `---` 会产生混淆（概率极低）
