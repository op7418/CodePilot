# 上下文管理体系优化

> 参考 Claude Code 源码的上下文管理体系，与 CodePilot 对比分析，提炼可借鉴和优化的方向。

## 架构对比总览

| 维度 | 参考项目 (Claude Code) | CodePilot (当前) |
|------|----------------------|-----------------|
| 上下文窗口管理 | 精细的多级 token 预算系统 | 依赖 SDK 自动管理，无显式预算 |
| 压缩策略 | 3 级：Micro → Session Memory → Auto Compact | 无主动压缩，依赖 SDK resume |
| System Prompt | 模块化 section 系统 + 静态/动态分离 | 6 层拼接，append 模式 |
| 记忆系统 | CLAUDE.md 层级发现 + session memory 自动提取 | Workspace 文件 + 每 3 轮自动提取 + MCP 搜索 |
| Token 计数 | 精确计数 + 估算 fallback + 详细分析 | 仅记录 API 返回的 usage |
| 缓存策略 | Prompt cache 精细控制（静态/动态边界） | 依赖 API 自动缓存 |
| 工具上下文 | Microcompact 去重 + token 预算裁剪 | 工具结果 last-wins 去重 |

---

## 可借鉴的关键能力（按优先级排序）

### P0: 主动上下文压缩（当前完全缺失）

**参考项目做法：** 三级压缩体系

1. **Microcompaction** — 每轮自动执行，无需 API 调用
   - 按时间去重旧的工具结果（Read/Bash/Grep 等）
   - 单文件 5K token 上限，技能 25K 总预算，压缩后 50K 上限
   - 自动剥离图片 block
2. **Session Memory Compaction** — 用 session memory 替代完整对话做摘要
   - 保留最近 10K-40K token 的消息
   - 摘要存入 `.claude/MEMORY.md`
3. **Auto Compaction** — 超过阈值时触发完整压缩
   - 阈值 = 有效窗口 - 13K buffer
   - 熔断器：连续 3 次失败后停止

**CodePilot 现状：** 依赖 SDK session resume，resume 失败时 fallback 到最近 50 条消息文本拼接。没有任何主动压缩，长对话会丢失早期上下文。

**建议：**
- 实现 Microcompaction：每轮对工具结果做去重和裁剪，最低成本最高收益
- 实现基于 session memory 的压缩：利用现有 memory-extractor 产出的 daily memory 作为压缩后的上下文骨架
- 设定明确的 token 阈值触发压缩，而不是等到 resume 失败

---

### P1: Token 预算与窗口感知（当前完全缺失）

**参考项目做法：**
- 每个模型有明确的 context window / output token 配置
- `tokenCountWithEstimation()` 在不调用 API 的情况下估算当前 token 用量
- `contextAnalysis.ts` 追踪每类内容（工具请求/结果/人类/助手）的 token 占比
- 重复文件读取检测 + 浪费 token 统计
- 预算倒计时：跟踪 continuation 次数，检测收益递减

**CodePilot 现状：** 只记录 API 返回的 `input_tokens` / `output_tokens`，不做预估，不做预算管理，不知道当前离窗口上限有多远。

**建议：**
- 添加 token 估算函数（4 chars ≈ 1 token 的粗估即可起步）
- 在 stream-session-manager 中维护累积 token 计数
- 前端展示当前 context 使用率（进度条），让用户感知对话"新鲜度"
- 检测重复文件读取并警告

---

### P2: Prompt Cache 精细控制

**参考项目做法：**
- System prompt 分为 **静态段**（跨请求缓存）和 **动态段**（每次变化）
- 静态段在 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记之前，可启用全局 cache scope
- 动态段用 `DANGEROUS_uncachedSystemPromptSection()` 显式标记，强制 cache 失效
- Cache-breaking instrumentation 追踪缓存命中率

**CodePilot 现状：** 6 层 context-assembler 拼接后整体作为 `systemPrompt.append` 传入。每次请求可能因为微小变化（dashboard summary、memory hint 日期）导致整个 prompt 缓存失效。

**建议：**
- 将 system prompt 分为稳定部分（人格 soul.md、基础指令）和易变部分（dashboard summary、memory hint）
- 稳定部分放在 append 的前部，易变部分放后部
- 避免在 system prompt 中注入时间戳等高频变化内容
- 预估：优化后可节省 30-50% 的 input token 费用（缓存命中时 90% 折扣）

---

### P3: 记忆搜索的时间衰减

**参考项目做法：**
```
半衰期 = 30 天
score = relevance × e^(-λ × age_days)
```
- 搜索结果按 相关性 × 时间衰减 排序
- 最近 3 天的记忆在 context hint 中优先展示
- 搜索结果限制 5 条，每条 3000 chars

**CodePilot 现状：** memory-search-mcp 已有类似的限制（3000 chars snippet、200 行上限），但搜索排序未见时间衰减权重。

**建议：**
- 在 memory-search-mcp 的搜索结果排序中加入时间衰减因子
- 效果：避免几个月前的过时记忆排在最前面

---

### P4: 工具上下文的 Microcompaction

**参考项目做法：** 针对不同工具类型有专门的压缩策略
- **Read 工具**：跳过重复读取同一文件
- **Bash 工具**：保留最近执行，旧的只保留命令+摘要
- **Grep/Glob**：合并相似搜索结果
- **Web 工具**：按时间清理旧结果
- 每个文件 5K token 上限，防止单个大文件占满窗口

**CodePilot 现状：** 工具结果用 `tool_use_id` 做 last-wins 去重，但没有跨轮次的清理和裁剪。

**建议：**
- 在构建 history fallback 时，对旧轮次的工具结果做摘要化（保留工具名+关键结论，去掉完整输出）
- 对 Read 工具结果设定单文件 token 上限

---

### P5: Context Window 使用率的前端可视化

**参考项目做法：**
- 警告阈值（窗口 - 20K）：通知用户 context 快满
- 阻塞阈值（窗口 - 3K）：禁止继续对话
- 用户可手动触发 `/compact` 命令

**CodePilot 现状：** 用户对 context 使用情况完全无感知，不知道对话何时会"遗忘"早期内容。

**建议：**
- 在 ChatView 顶部或 MessageInput 附近显示 context 使用率
- 接近上限时提示用户"建议开启新对话"或"已自动压缩"
- 可作为 session 级别的状态展示

---

## CodePilot 已有的优势（无需改动）

| 能力 | 说明 |
|------|------|
| **Keyword-gated MCP** | 按关键词动态注册 MCP，避免不需要的工具描述污染 context — 参考项目没有这个，它的工具始终注册 |
| **Workspace 人格体系** | soul.md / user.md / claude.md 三文件分离身份、用户画像、行为规则 — 比参考项目的单一 CLAUDE.md 更结构化 |
| **Head+Tail 截断** | 大文件保留头部结构+尾部最新内容 — 参考项目的 memory 文件只做行截断 |
| **Memory 自动提取** | 每 3 轮用 Haiku 自动提取记忆 — 参考项目的 session memory 也是后台提取，思路一致 |
| **Workspace 增量索引** | 基于 mtime 的增量索引 + hotset 机制 — 参考项目没有等效的文件索引系统 |

---

## 实施建议路线图

```
Phase 1 (低成本高收益)
├── Token 估算 + 累积计数
├── 前端 context 使用率指示器
└── History fallback 中工具结果裁剪

Phase 2 (核心能力补齐)
├── Microcompaction 引擎
├── System prompt 静态/动态分离
└── Memory 搜索时间衰减

Phase 3 (完整压缩体系)
├── Session memory compaction
├── Auto compaction 触发器 + 熔断
└── /compact 手动命令
```

---

## 总结

CodePilot 在**记忆持久化**和**人格体系**上做得比参考项目更精细，但在**上下文窗口管理**这个核心问题上几乎是空白。参考项目最值得学习的是它的**三级压缩体系**（Micro → Session Memory → Auto Compact）和**token 预算意识**——这两个能力直接决定了长对话的质量上限。建议从 Phase 1 的 token 感知开始，逐步补齐压缩能力。
