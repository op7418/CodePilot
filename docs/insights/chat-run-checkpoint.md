# Chat Run Checkpoint — 产品思考（Round 1）

> 执行计划见 docs/exec-plans/deferred/chat-run-checkpoint.md

## 用户问题

Chat 页能解释「这次会用什么 Runtime / Model / 权限 / 上下文」（Run 状态面板 + Context chips），但**还没解决"用户发送瞬间到 Agent 实际执行之间的信任空隙"**。

具体场景：
- 用户切到「完全访问」权限 → Agent 可以无确认动文件，用户没看到提醒
- 系统 Runtime 自动降级 → 用户以为还在 Claude Code 跑
- Pinned 默认模型在新 Runtime 下不可达 → 用户发了消息才发现

这些是"该提示但没提示"的瞬间。Run Checkpoint 是 **inline 出现在输入框上方的轻量信任层**，只在异常时出现，否则**完全不打扰**。

## 为什么是 inline banner，不是 modal

Modal 打断流。用户输完正想 Enter 发送，弹出一个 modal，点确认 → 取消 → 再点输入框继续编辑——这是糟糕的中断模式。

inline banner 在输入框上方，用户**继续看着自己的输入**做决定：
- 看到 banner → 点 action 跳到 Settings 修复 → 修复后回来 → 输入还在
- 不看 banner → 直接发送（如果不是阻断态）→ 流走

Modal 强迫用户按它的节奏走，banner 让用户保留主动权。

## 为什么不做"settings 里可关掉的提示"

这是个**原则问题**：Checkpoint 是对用户的保护，不是"功能"。用户不应该有"关掉它"的入口——否则它就退化成 toggle，违背 Chat 页设计原则 #3（**保护用户的硬性规则不要被用户关掉**）。如果将来真的有用户场景需要绕过，应该提升优化触发条件，而不是加个"关闭"按钮。

## 为什么 5 类（计划全量）都进同一个组件

视觉一致 = 用户认知一致。如果 Runtime fallback 长一个样、权限提升长另一个样、上下文成本提升长第三个样——用户每次都要重新理解。

统一进 `<RunCheckpoint>` 后，**只要看到那个 inline banner 形态**，用户就知道："Agent 在等我确认一件事"。Round 1 已经从结构上把 RateLimitBanner / TerminalReasonChip / 新 RunCheckpoint 都用上同一族 `bg-status-*-muted` token，是同一种视觉语言。

## Round 1 为什么先做 Pinned-invalid + Runtime-fallback

三个理由：
1. **数据信号已存在**——`state.defaultInvalid` / `runtimeFallback` 都已经在 `useOverviewData` / `RunCockpit` 里推导出来，不需要新逻辑，代码风险低
2. **场景频度高**——每次刷新切到不可用模型都会触发，覆盖面广
3. **已有零散提示**——chat/page.tsx 早已有一个 ErrorBanner for invalidDefault，Round 1 把它合并进来直接对比"统一前 vs 统一后"的效果

危险工具调用放最后是因为它**触及工具执行链的状态机**——一旦做错可能让 Agent 行为不一致（确认通过了但仍被拦 / 确认失败但仍执行）。等前两轮证明组件抽象 + state gate 模型稳定，再动这块。

## 为什么 noCompatibleProvider 优先并独占

如果根本没有可用服务商，"你 pin 错了"或"Runtime 降级了"都不是用户能立刻处理的事。**先解决最阻断的一件事**——把用户引到 `/settings#providers` 加 provider，处理完后再看其它问题（如果还有的话）。这跟急救分诊一个逻辑：先气道，再呼吸，再循环。

## 与既有 PermissionPrompt 的关系

PermissionPrompt 是**工具调用前的实时确认机制**——Agent 在 streaming 中决定要调 `Bash` / `Edit` / 读敏感目录时弹出。这是 Round 3 dangerous-tool-call 的承载体。

Round 1 不动 PermissionPrompt 的状态机，只是**承认"它跟 RunCheckpoint 是同一种 trust layer 的两个表现"**：
- RunCheckpoint = 发送前 / 配置异常 → inline banner
- PermissionPrompt = 执行中 / 工具调用 → 内嵌确认卡片

将来 Round 3 会让两者共用一份触发协议，但渲染层各自保留——发送前 inline 适合 banner，执行中适合 in-context 确认卡片。

## 为什么不持久化"已确认"

危险操作每次都问。Round 1 的三类（Pinned-invalid / Runtime-fallback / no-provider）严格意义上不是"危险"操作，但它们是**配置异常**——用户得修，不能"以后不再问"。

将来 Round 2 的"权限提升首次发送"会是第一个引入 sessionStorage `已知悉` 的场景（首次提升进入 session 后提示一次，关闭 chat 重置）。但这会单独设计，不影响 Round 1 的简单约束。

## 局限性

- **依赖 useOverviewData 的轮询/订阅频率**——如果用户在 Settings 改了 Runtime 但 overview snapshot 没刷新，banner 不会立刻出现。chat 路由切换会触发 fetch，所以实际场景里几乎无感，但极端情况下会有 1-2s 延迟。
- **OpenAI OAuth 强制 Native 的 hardcode 散落两处**——chat/page.tsx + ChatView.tsx 都有同样的 `providerId === 'openai-oauth'` 分支。Round 2 之前如果有第三个"provider → 强制 runtime"的规则，就值得抽一个 helper。

## 参考

- [Chat 页设计原则](./chat-composer-redesign.md#chat-页设计原则) §3：保护用户的硬性规则不要被用户关掉
- feedback_no_silent_auto_irreversible.md：无 silent auto 操作
- feedback_pinned_default_hard_promise.md：Pinned 是硬约定
