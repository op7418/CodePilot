# 产品思考文档

记录功能设计背后的"为什么"——用户问题、设计理由、外部趋势、已知局限和未来方向。

每份文档对应一个 `docs/handover/` 中的技术交接文档，文件名保持一致，互相反向链接。

## 索引

| 文档 | 对应交接文档 | 主题 |
|------|------------|------|
| [qwen-token-plan-grok-access.md](./qwen-token-plan-grok-access.md) | [handover/qwen-token-plan-grok-access.md](../handover/qwen-token-plan-grok-access.md) | 为什么套餐 identity 不能靠 URL、为什么订阅凭据需要场景 gate、xAI API Key/OAuth 双渠道取舍与真实 OAuth 完成感反馈 |
| [cli-tools.md](./cli-tools.md) | [handover/cli-tools.md](../handover/cli-tools.md) | CLI 工具管理的 MCP 化、Agent-first CLI 趋势、凭证管理痛点 |
| [new-chat-greeting.md](./new-chat-greeting.md) | [handover/new-chat-greeting.md](../handover/new-chat-greeting.md) | 新对话欢迎语为何按时间/场景变化：问候+问句拆分、场景优先级、首屏先中性句再替换的取舍、品牌语气可调 |
| [dashboard-generative-ui.md](./dashboard-generative-ui.md) | [handover/dashboard.md](../handover/dashboard.md) | 生成式 UI 持久化、AI-first 项目看板、系统级渲染层构想、实现后复盘 |
| [buddy-gamification.md](./buddy-gamification.md) | [handover/buddy-gamification.md](../handover/buddy-gamification.md) | Buddy 宠物伙伴设计：从工具到伙伴的用户旅程、稀有度/进化/心跳、视觉体系、审查修复决策 |
| [context-management.md](./context-management.md) | [handover/context-management.md](../handover/context-management.md) | 上下文管理：长对话失忆/PTL 问题、分级压缩策略、Claude Code 参考与取舍、Codex 审计驱动的优先级 |
| [cli-upgrade-proxy.md](./cli-upgrade-proxy.md) | [handover/cli-upgrade-proxy.md](../handover/cli-upgrade-proxy.md) | CLI 升级 + 代理透传：P0 版本问题、分渠道升级策略、系统代理无感透传、Git 依赖引导 |
| [tool-call-ux.md](./tool-call-ux.md) | [handover/tool-call-ux.md](../handover/tool-call-ux.md) | 工具调用 UX：thinking 展示设计决策、注册表 vs if/else、归组阈值、缓冲旁路、竞品对比 |
| [performance-memory.md](./performance-memory.md) | [handover/performance-memory.md](../handover/performance-memory.md) | 内存优化：LRU vs 定期清理、300 条上限 + reconciliation、定时器泄漏、大文件流式读取 |
| [user-audience-analysis.md](./user-audience-analysis.md) | [handover/provider-architecture.md](../handover/provider-architecture.md) | 用户受众分析：画像、需求优先级、竞品格局、品牌定位路线取舍（2026-04-04 数据快照） |
| [agentic-architecture-map.md](./agentic-architecture-map.md) | [handover/agentic-architecture-map.md](../handover/agentic-architecture-map.md) | Agentic 架构图对 CodePilot 重构的启发：工具 vs Agent、Provider 事实地基、Health/Logs 取证、半成品能力分层 |
| [models-provider-experience.md](./models-provider-experience.md) | [handover/models-provider-experience.md](../handover/models-provider-experience.md) | Models / Providers 体验收敛：只保留默认模型、可用模型、添加模型三条主路径，模型刷新和迁移状态降级为高级操作 |
| [decouple-native-runtime.md](./decouple-native-runtime.md) | [handover/decouple-native-runtime.md](../handover/decouple-native-runtime.md) | 脱离 Claude Code：用户痛点（安装门槛/单一锁定）、双 Runtime 设计理由、OpenAI 集成、参考项目对比 |
| [markdown-artifact-overhaul.md](./markdown-artifact-overhaul.md) | [handover/markdown-artifact-overhaul.md](../handover/markdown-artifact-overhaul.md) | Markdown/Artifact 重构：卡片点击 vs 自动弹、升级 DiffSummary、分档 50000 行 + 截断提示、PreviewPanel 编辑即核心能力、单文件 React 产品边界、长图走隐藏窗口复用、两段失败路径复盘 |
| [phase-4-markdown-artifact.md](./phase-4-markdown-artifact.md) | [handover/phase-4-markdown-artifact.md](../handover/phase-4-markdown-artifact.md) | Phase 4 Markdown 数据层 × HTML 表现层：Markdown 是数据 / HTML 是衍生表现、trust 三档而非 binary、同源路由 + path scope 取代 base 注入、CSP 4 轮收紧到禁 URL-shaped exfiltration、Save-HTML deferred 的产品判断、3 段弯路复盘 |
| [chat-composer-redesign.md](./chat-composer-redesign.md) | [handover/chat-composer-redesign.md](../handover/chat-composer-redesign.md) | Chat 页从"工具集合"收敛到"Agent 工作入口"：按钮越少越好、出问题才显示、Run 状态聚合 vs 散落 chip、外部 review 防过拟合、Codex 决策日志 |
| [chat-run-checkpoint.md](./chat-run-checkpoint.md) | [handover/chat-run-checkpoint.md](../handover/chat-run-checkpoint.md) | 发送前信任层 Round 1：为什么 inline banner 而不是 modal、为什么不能"在 settings 里关掉"、统一视觉=统一认知、Round 1 取舍（先做配置异常，最后做危险工具调用） |
| [codex-tool-bridge.md](./codex-tool-bridge.md) | [handover/codex-tool-bridge.md](../handover/codex-tool-bridge.md) | Codex Runtime CodePilot Tool Bridge：为什么换 Runtime 不能丢工具、proxy 内执行 + 侧通道 vs 反向 turn 续接的取舍、模型自创 fallback 反模式（auth.json / npm install / OPENAI_API_KEY）的教训、未来 Runtime 接入模板 |
| [harness-capability-contract.md](./harness-capability-contract.md) | [handover/harness-capability-contract.md](../handover/harness-capability-contract.md) | Harness Capability Contract：为什么不再补 prompt 而是建契约；ClaudeCode 稳/Codex Account 稳/Codex-via-proxy 脆的结构性差异；契约 + 测试 vs live-smoke-driven patching；反模式记录（speculation 当 source-of-truth、同概念三份独立实现、机器读不通的人写示例、错误静默掉）；新 Runtime 接入第四个时的硬性流程 |
| [new-runtime-playbook.md](./new-runtime-playbook.md) | [handover/new-runtime-playbook.md](../handover/new-runtime-playbook.md) | 为什么需要 "New Runtime Playbook"：Codex 三天救火的真实根因是 CodePilot 自己能力散落 + smoke 压力下软建议失效；硬性顺序如何替代经验直觉；7 条反模式来自 slice 1-6 真实事故；Capability vs Provider 边界判断；现有限制（凭据私有性、permission 协议未统一） |
| [icon-system.md](./icon-system.md) | [handover/icon-system.md](../handover/icon-system.md) | 图标体系与表意校准：图标被复用 / 表意不清的用户痛点、为何先建 semantic layer 而非换库、Brain/Lightning/Terminal 冲突裁决（model=Cube / runtime=Chip / memory=Brain / cli≠terminal）、品牌图标保留 LobeHub、eslint guardrail 防回潮、53 个结构性图标兼容层的取舍 |
| [macos-visual-profile.md](./macos-visual-profile.md) | [handover/macos-visual-profile.md](../handover/macos-visual-profile.md) | macOS 平台视觉层：网页感痛点、借鉴 Raycast 原则不抄实现、Apple HIG/Liquid Glass 给"内容区不上玻璃"的官方依据、三层模型、Electron vibrancy 窗口级的诚实纪律、7c"三症状一个病"抽出 CardFrame/CardSurface/ResizeGutter 的复盘、截图证据缺口 |
