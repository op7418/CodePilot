# 记忆系统后续增强

> V3/V3.1 已实现：对话式 Onboarding、Heartbeat、渐进式更新、Memory Search MCP、时间衰减、transcript 裁剪
> 本文件记录进一步的增强方向

## 我们相比 OpenClaw 的优势

CodePilot 不应照搬 OpenClaw，而应发挥自身生态优势：

| 优势 | OpenClaw 做不了 | 我们能做 |
|------|----------------|---------|
| Obsidian 生态 | 纯文本搜索，无 frontmatter 感知 | 按 tags/category 过滤，[[wikilink]] 关联发现 |
| 身份层常驻 | 全都不在 prompt | soul/user/claude 常驻保证人格一致性 |
| GUI 界面 | 命令行操作 | 可视化记忆管理、搜索预览、图谱展示 |
| Generative UI | 无 | Widget 展示记忆时间线、关系图谱 |
| Bridge 多渠道 | 各 channel 独立 | 同一 workspace 记忆跨渠道共享 |

## 已实现的 Obsidian 优化（V3.1）

- `codepilot_memory_search` 支持 `tags` 过滤参数（从 frontmatter 提取）
- `codepilot_memory_search` 支持 `file_type` 过滤（daily/longterm/notes）
- `codepilot_memory_get` 提取 [[wikilinks]] 作为关联文件提示
- `codepilot_memory_recent` 工具：首轮自动回顾最近 3 天记忆
- System prompt 强化：首轮必调 `codepilot_memory_recent`，Obsidian 语法感知提示
- 上下文注入 `<memory-hint>` 告知 AI 有哪些 daily memory 可用

## 待做：GUI 记忆管理面板

在设置页 → 助理 → 新增"记忆管理"tab：

- **记忆文件列表**：展示 memory.md + daily memories + 其他 workspace 文件，带文件大小和最后修改时间
- **搜索预览**：输入关键词实时预览 `codepilot_memory_search` 的结果（帮助用户理解 AI 能搜到什么）
- **标签浏览**：从 manifest 提取所有 tags，按标签分组浏览文件
- **记忆编辑**：直接在 GUI 中编辑 memory.md、HEARTBEAT.md 等文件（Monaco 编辑器或简单 textarea）
- **归档管理**：查看和恢复已归档的 daily memories

## 待做：Widget 记忆可视化

利用 Generative UI（show-widget）展示记忆：

- **记忆时间线**：按日期展示 daily memories，显示每天的关键事件
- **标签云**：workspace 中所有标签的热度分布
- **关联图谱**：基于 [[wikilinks]] 的文件关系网络图（可用 D3.js force-directed graph）
- **记忆健康度**：memory.md 大小、daily memory 覆盖率、最后更新时间

## 待做：本地向量搜索

当前搜索是关键词 bigram 匹配。对于个人助理级别（几十到几百文件）已经够用，但规模增大后需要向量搜索：

- **方案**：`@xenova/transformers`（ONNX Runtime，本地 embedding，~60MB 模型）
- **时机**：当 workspace 文件 > 200 个时自动启用
- **混合模式**：BM25 keyword + 向量 similarity，权重可调（参考 OpenClaw 的 0.3/0.7）
- **缓存**：embedding 结果缓存到 SQLite（避免重复计算）
- **优先级低**：关键词搜索对中文的 bigram 支持已经不错

## 待做：Auto Flush（硬 flush）

当前依赖渐进式更新 prompt 让 AI 主动写盘（软 flush）。硬 flush 需要：

- SDK 暴露 compaction 前 hook，或 token 使用量 API
- 在压缩前插入一轮 silent turn，只允许 read+write 工具
- 追加到 daily memory，不修改身份文件
- OpenClaw 的实现参考：`extensions/memory-core/src/flush-plan.ts`

等 Claude Agent SDK 支持后再实现。
