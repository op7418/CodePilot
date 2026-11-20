# 上下文管理系统 — 产品思考

## 解决了什么问题

长对话是 AI 编程助手的核心使用场景。用户在一个 session 里调试 bug、重构代码、讨论架构，往往需要几十甚至上百轮对话。但 LLM 的上下文窗口是有限的，超出后要么报错（PTL），要么丢失早期上下文导致 AI "失忆"。

用户面临的具体痛点：

1. **对话突然断裂** — 聊了很久后 API 返回 prompt_too_long 错误，用户不知道发生了什么，只能新建对话重新开始
2. **AI 遗忘早期讨论** — SDK resume 失败后 fallback 只取最近消息，前面讨论的架构决策、文件路径、需求背景全部丢失
3. **上下文使用量不透明** — 用户不知道离上限还有多远，无法做出"是否该新建对话"的判断
4. **工具调用结果占满窗口** — 一次 `Read` 返回几千行代码、一次 `Bash` 返回大量日志，这些低信息密度的内容挤占了高价值的对话空间

## 为什么这样设计

### 为什么不直接增大上下文窗口

部分模型已支持 1M context，但：
- 大窗口意味着更高的费用（按 input token 计费）
- 更长的首 token 延迟
- 模型对超长上下文中间部分的注意力下降（"lost in the middle"现象）
- 第三方 provider 的窗口大小不可控

正确的做法是：在有限窗口内最大化信息密度，而非追求无限窗口。

### 为什么先做本地 Microcompaction 再做 LLM 压缩

Microcompaction 是零成本的——不调用 API，不增加延迟，每轮都能执行。它处理的是"确定性的低价值内容"：

- 30 轮之前的工具调用结果 → 从 5000 字符截到 1000 字符
- `<!--files:...-->` 元数据 → 完全剥离
- 工具调用的 JSON 输入 → 截断到 80 字符摘要

这些操作不需要 AI 判断，规则明确，效果立竿见影。实测一个工具密集的 50 轮对话，仅 microcompaction 就能减少 40-60% 的 token 量。

LLM 压缩是重操作——需要额外 API 调用（用小模型），有延迟，有失败风险。把它留给真正需要语义理解的场景（将 30 条对话浓缩成一段摘要）。

先 micro 后 macro 的分级策略让大多数对话永远不需要触发 LLM 压缩。

### 为什么压缩阈值是 80% 而非更激进

Claude Code 用的是 `window - 13K` 作为阈值，接近 95%。这对 CLI 环境合理（用户能看到 warning 并手动 `/compact`）。

CodePilot 是 GUI，用户没有 `/compact` 命令（虽然我们也实现了），也不会主动关注上下文用量。80% 是一个安全余量——给压缩操作本身留出足够的"跑道"，也给下一轮对话留出空间。

如果设太高（如 95%），压缩操作本身可能因为剩余空间不够而失败，形成死锁。

## 参考：Claude Code 的做法

Claude Code 有完整的四级压缩体系（Micro → Session Memory → Auto Compact → Context Collapse）。我们参考了其中三级：

**吸收的：**
- Microcompaction 的分级截断思路（按年龄和类型差异化处理）
- Auto Compact 的阈值触发 + 熔断器模式
- PTL reactive compact（API 报错后自动压缩重试）
- `roughTokenCountEstimation` 的 4B/tok 粗估方法

**没有吸收的：**
- **Session Memory Compaction** — Claude Code 用 session memory 做中间级压缩。CodePilot 的 memory-extractor 已经每 3 轮提取记忆到 workspace，功能重叠
- **Context Collapse**（实验性功能）— 涉及 commit context / spawn 控制等 CLI 专属概念，GUI 场景不适用
- **Compact 后文件/技能恢复** — 需要维护"最近读取的文件"列表，增加复杂度。CodePilot 的 SDK resume 路径已有完整上下文；fallback 路径用 summary + 最近消息足够
- **Prompt cache 精细控制** — SDK 的 preset append 模式不暴露 `cache_control` API。我们用静态/动态分离来提高命中概率，但无法做到 Claude Code 那样的精确标记
- **精确 token 计数** — 需要额外 API 调用，增加延迟和费用。粗估对"是否需要压缩"的判断已足够准确

## 决策驱动

### Codex 交叉审计的发现

第三轮 Codex 审计指出了关键优先级问题：

> 第一优先级不是做 fancy 的压缩，而是先把"上下文测量"补起来。不知道上下文有多满，做压缩也是盲打。

这直接决定了我们的实施顺序：先建测量能力（estimator + ContextUsageIndicator），再建压缩能力。

审计还发现了几个具体问题：
- Fallback history 的 `<!--files:...-->` 元数据泄漏 — 模型看到了不应该看到的内部标记
- ContextUsageIndicator 只显示"上一轮消耗"而非"下一轮预估" — 两个完全不同的指标被混为一谈
- `model-context.ts` 对 `context_1m` 不感知 — UI 进度条始终按 200K 算

这些都在 Phase 0（止血）中修复。

### SDK subprocess 选择

压缩器的 LLM 调用最初用 `@ai-sdk/anthropic` 的 `generateText`。在测试第三方 provider（GLM、Kimi 等）时发现：这些 provider 通过代理 URL 连接，`@ai-sdk/anthropic` 不走代理，导致压缩对第三方用户完全不可用。

改用 SDK subprocess 后，LLM 调用自动继承用户配置的 transport 层，所有 provider 统一可用。代价是多一个进程开销，但这是一次性操作（一次对话最多触发几次压缩），可以接受。

## 明确不做的事项

1. **Blocking 阈值** — 不阻止用户发送消息。GUI 场景下阻止发送的体验很差（用户会困惑"为什么输入框灰了"）。用 warning 提示 + 自动压缩来处理
2. **精确 token 计数 API** — 增加 200-500ms 延迟，对用户无感知价值
3. **Context 使用分析（按类型分布）** — 开发者调试工具，不影响普通用户体验
4. **Cached microcompact** — 需要 SDK 的 `cache_edits` API 支持，当前不可用
5. **压缩质量评估** — 无法自动判断摘要是否"好"，依赖小模型的生成质量

## 未来方向

1. **多语言 token 估算校正** — 中文内容的 bytes/token 比率与英文差异较大，可以按语言检测调整系数
2. **摘要质量信号** — 追踪压缩后用户是否需要重复之前说过的话，作为摘要质量的间接指标
3. **渐进式上下文恢复** — compact 后根据当前话题自动恢复相关的旧消息片段（而非恢复全部）
4. **跨 session 摘要复用** — 同一项目的多个 session 可以共享项目级上下文摘要
5. **前端手动 compact 入口** — 在 ContextUsageIndicator 的 HoverCard 中添加"压缩"按钮，让高级用户主动触发
