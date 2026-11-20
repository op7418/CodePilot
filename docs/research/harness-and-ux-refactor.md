# Harness 思考与交互重构 — 事实输入文档

> **本文档已不再承担排期职责。** 唯一执行入口为 `docs/exec-plans/superseded/agent-trust-ownership-refactor.md`(Agent Trust & Ownership Refactor)。本文剩余内容仅作为该计划 Phase 0-4 的**事实输入**保留:
>
> - §"事实速览" 1-10:Harness 各层代码现状、记忆系统 V3、Hermes 路线图进度——作为 Phase 2 / Phase 4 实施输入
> - §"Google design.md 事实速览":作为 Phase 1 design.md 写作参考
> - §"讨论日志":作为决策溯源
>
> **删除的内容**(2026-04-25 收束):本轮迭代决议、design.md 完整章节清单、一周排期、预警、Gate 待澄清——这些已收束到 Codex 计划。本文不再维护排期类内容。

## 背景

- 起点：用户与 John（Gemini）2026-04-18 的讨论（`~/Downloads/扩展托管代理...md`）+ LangChain《The Anatomy of an Agent Harness》+ 《The Way of Code》。
- 视觉基调：shadcn Style 更换为 **Luma**（CSS token 待贴）。
- 产品名保留 CodePilot；shadcn Style 统一切到 Luma。

## 本轮迭代目标

用户 2026-04-24 明确的三条：

1. **整体视觉和交互一致性 + 易用性**——要有一次可见的提升(不是内部重构,是用户能直接感受到的)。
2. **完成一批半成品功能**——示例:定时任务通知(对应 `docs/exec-plans/superseded/scheduled-tasks-notifications.md`)。其他候选待讨论清点。
3. **核心目标**:把整个 Agent 架构/体系变成一个**整体**,提升稳定性 + 可用性。
   - 手法示例:新增"护栏文件"——`Context.md`、`服务商.md`。作用类似现有 `CLAUDE.md` / `ARCHITECTURE.md`,但针对 Context 管控体系和 Provider 体系,把分散在代码里的隐性约定落到显性文档上。
   - 动机:当前架构的各部件各自都在跑(见下方事实速览),但没有一份能统一解释"这些部件如何协作、边界在哪、新增功能触及哪些约束"的文档。

## 事实速览(2026-04-24 代码扫描,仅事实不带判断)

> 来源:直接读 `ARCHITECTURE.md` + `docs/handover/decouple-native-runtime.md` + 下述 7 个文件。
>
> 覆盖:`src/lib/runtime/*.ts`、`src/lib/agent-loop.ts`、`src/lib/context-assembler.ts`、`src/lib/message-builder.ts`、`src/lib/context-compressor.ts`、`src/lib/agent-system-prompt.ts`。
> 未覆盖(待后续按需补):`claude-client.ts`(2115 行)、`context-pruner.ts`、`agent-tools.ts`、`permission-checker.ts`、`mcp-connection-manager.ts`、前端组件树。

### 1. 后端已有的 Harness 职责分布

Harness 的大部分职责已经存在,只是没有 `harness/` 这个命名/目录把它们收到一起:

| 职责 | 文件 | 行数 | 要点 |
|---|---|---|---|
| Runtime 抽象 | `src/lib/runtime/types.ts` + `registry.ts` + `native-runtime.ts` + `sdk-runtime.ts` | 合计 ~500 | `AgentRuntime.stream(options) → ReadableStream<SSE>` 单一核心方法;双 runtime 并存(Native/AI SDK + Claude Code SDK);17 种 SSE 事件是输出契约 |
| Agent Loop | `src/lib/agent-loop.ts` | 580 | 手动 while 循环(非 AI SDK maxSteps);per-step 权限检查 / doom-loop 检测 / skill-nudge 启发;keep-alive;文件 checkpoint;压缩前置剪枝调用 |
| System Prompt 组装 | `src/lib/agent-system-prompt.ts` | 296 | 6 模块段(Identity/Tasks/Actions/Tools/Tone/Output) + Env + Project instructions(CLAUDE.md/AGENTS.md 四级优先级 user>project>workspace>parent,50KB per file 上限) |
| Context 组装 | `src/lib/context-assembler.ts` | 399 | 7 层注入,**明确区分 STATIC PREFIX(缓存友好) vs VOLATILE SUFFIX**;按 `entryPoint: 'desktop' \| 'bridge'` 参数化;desktop/bridge 共用 |
| Message 历史组装 | `src/lib/message-builder.ts` | 327 | DB → Vercel AI SDK CoreMessage[];附件重建(图片 base64 / 文本文件内联 50KB / 二进制作为引用文字);强制 user/assistant 轮替 |
| Context 压缩 | `src/lib/context-compressor.ts` | 360 | 80% 阈值触发;5 层辅助模型 fallback(env override → main.small → main.haiku → 其他非 sdkProxyOnly provider → main 兜底);`context_summary_boundary_rowid` 防重复汇总;3 次失败熔断;主动+被动两条路径;SSE `context_compressed` 状态事件 |

### 2. Context 组装的 7 层详情(`context-assembler.ts`)

按 prompt 缓存命中率设计:

**STATIC PREFIX**(在一次会话内稳定,有助于 prompt 缓存):
1. Widget system prompt(generative UI 开启时;compile-time 常量)
2. `session.system_prompt`(会话创建时设定)
3. Workspace identity 文件(soul/user/claude.md——Assistant Workspace 启用时)

**VOLATILE SUFFIX**(每轮可能变):
4. Memory hint(按日变化——最近 5 天的 daily memories 列表)
5. Assistant project instructions(onboarding / heartbeat / progressive / no-buddy / buddy personality 多分支)
6. Dashboard 摘要(desktop only;当前 widgets 列表,500 字截断)
7. `systemPromptAppend`(per-request,例如 image agent mode、skill 注入)

### 3. Runtime 选择决策树(`runtime/registry.ts`)

`resolveRuntime()` 优先级:
- 0. `cli_enabled=false` → 强制 Native(最高优先级约束)
- 1. 显式 override(function arg 或 per-session setting)
- 2. 全局设置 `agent_runtime`
- 3. Auto:CLI binary 存在 → SDK,否则 Native

特殊:`providerId === 'openai-oauth'` → 强制 Native(`claude-client.ts` 拦截)。

`predictNativeRuntime()` 是同步版,用于 chat route + bridge 预判 MCP 配置。

### 4. Agent Loop 内置的"Harness 观察/干预"机制(`agent-loop.ts`)

| 机制 | 行为 |
|---|---|
| DOOM_LOOP_THRESHOLD = 3 | 同工具连续 3 次调用视为死循环(当前只是检测,执行 break 的代码 TODO) |
| KEEPALIVE_INTERVAL = 15s | 空闲时发 `keep_alive` SSE 保活 |
| Context pruning per step | 每步调 `pruneOldToolResults` 裁剪旧 tool_result,降 token |
| Skill nudge | ≥8 步 + ≥3 种工具 → SSE 建议"保存为 Skill",web + bridge 双通道消费 |
| Rewind point emission | 仅为 prompt-level user 消息发射,跳过 autoTrigger / tool_result |
| File checkpoint | rewind point 创建时 snapshot 文件(内存中,避免 git checkout 丢未提交改动) |
| `repairToolCall` | 无效 tool call 交回模型自己修复(AI SDK feature) |
| MCP sync 前置 | 进入 loop 前 `await syncMcpConnections`,避免 race |

### 5. Runtime 接口的 escape hatch

`RuntimeStreamOptions.runtimeOptions: Record<string, unknown>` 是未类型化字段,承载:
- SDK runtime 读:`sdkSessionId`、`files`、`conversationHistory`、`agents`、`agent`、`enableFileCheckpointing`、`outputFormat`、`generativeUI` 等
- Native runtime 读:`maxSteps` 等

类型安全丢在各 runtime 实现里自行 cast。

### 6. 前端目录结构(来自 `ARCHITECTURE.md`)

传统多面板结构,每个子目录是独立入口:

```
src/components/
├── ui/           # Radix 基础组件(Button/Dialog/Tabs/...)
├── chat/         # MessageList / CodeBlock / ImageThumbnail
├── ai-elements/  # artifact / reasoning / tool / task 渲染
├── layout/       # AppShell / Header / NavRail / ChatListPanel
├── plugins/      # 插件管理 UI
├── settings/     # 设置面板
├── bridge/       # Bridge 设置 UI
├── skills/       # 技能市场
├── project/      # 项目文件树
└── gallery/      # 画廊视图
```

配套:52 个 REST API 端点、12 张 DB 表(`chat_sessions`、`messages`、`settings`、`tasks`、`api_providers`、`media_*` 4 张、`channel_bindings`、`channel_offsets`)。

### 7. 入口编排现状

`src/app/api/chat/*` 的 route handler 同时承担:
- HTTP 请求解析
- 调用 `assembleContext`(Context 组装)
- 调用 `streamClaude`(claude-client.ts)——内含 runtime 选择、压缩重试、错误分类
- 流 SSE 回前端

——即:**route 既是 HTTP 壳也是 Harness 编排者**,没有独立的 Harness 外观(façade)。

### 8. 记忆系统现状补充(2026-04-24 读 V3 交接文档后)

记忆系统已经是 **V3/V3.1**(已上线),不是我上一节笼统说的"还没做到自动蒸馏":

- **记忆从 system prompt 移出到 MCP 按需查**——V2 时 40K chars 全塞,V3.1 降到 24K(只保留身份层),记忆通过 3 个 MCP 工具按需检索:`codepilot_memory_search` / `_get` / `_recent`
- **时间衰减已接线**:日期文件 30 天半衰期,memory.md / MEMORY.md 常青不衰减(`applyTemporalDecay` in `memory-search-mcp.ts`)
- **Obsidian 感知**:frontmatter 标签过滤、`[[wikilink]]` 关联发现、文件类型过滤(daily / longterm / notes)
- **心跳协议(HEARTBEAT_OK)**:AI 每天自主检查一次,无事静默,有事自然说出;严格限定助理 workspace
- **渐进式文件更新**:日常对话中 AI 自主判断要不要更新 memory.md / daily
- **Onboarding**:从 13 题固定问卷改成 5 问以内的对话式 bootstrap,完成时 fence 格式触发后端自动生成身份档案

**对比 Karpathy wiki 模式,真正没做到的是两件事**(其他基本都有对应):
- **按主题分页的百科结构**——当前仍是"长期记忆 1 份 + daily 按日期分",没有 `topics/压缩策略.md` / `topics/用户偏好.md` 这类主题分页
- **自动体检/lint**——矛盾检测、过期检测、孤儿检测没有实现

### 9. hermes 调研落地进度(2026-04-24 读 `hermes-agent-analysis.md` 后)

hermes 调研给出的 P0-P2 六项路线图,当前进度:

| 项 | 状态 | 说明 |
|---|---|---|
| 3.1 并行安全调度器 | 未做 | AI SDK 默认并行但无安全判定 |
| 3.2 辅助模型路由 + 兜底 | **已做** | `context-compressor.ts` 的 5 层 fallback + main-floor 兜底就来自这条路线 |
| 3.3 渐进式子目录 hint | 未做 | 当前 `agent-system-prompt.ts` 的发现层级只有 user / project / parent 三级,没有随 tool call 轨迹做祖先上溯 |
| 3.4 Session 历史搜索 | 未做 | messages 表存在但没有暴露给模型的搜索工具 |
| 3.5 LLM 驱动上下文压缩(主动+被动) | **已做** | `context-compressor.ts` 的 80% 阈值主动压缩 + 反应式重试已经在跑 |
| 3.6 Skill 自动创建 nudge | 已做 | `agent-loop.ts` 的 `shouldSuggestSkill` 启发式(≥8 步 + ≥3 工具) |

**结论**:记忆/压缩/路由这条链子,**从调研到实施走了一半**——3.1 / 3.3 / 3.4 是三条明确的"调研有、代码没"的候选项,本轮是否吃下它们需要决策。

### 10. 现有 exec-plans 中与本讨论相关的

位于 `docs/exec-plans/active/`:
- `agent-runtime-abstraction-revision.md` — Runtime 抽象迭代
- `agent-sdk-0-2-111-adoption.md` — SDK 版本采纳
- `context-storage-migration.md` — Context 存储迁移
- `decouple-claude-code.md` — 脱离 Claude Code CLI
- `decouple-test-plan.md` — 解耦测试
- `memory-system-v3.md` — 记忆系统 v3
- `provider-governance.md` + `provider-resolver-refactor.md` — Provider 治理
- `scheduled-tasks-notifications.md` — **定时任务通知(用户点名的半成品之一)**
- `unified-context-layer.md` — 统一上下文层

(未逐一读内容,仅列入作为"已有的相关工作线")。

## 讨论日志

| 日期 | 讨论了什么 | 结论 |
|---|---|---|
| 2026-04-24 | 文档创建 + 前置决策 | 保留 CodePilot;半成品处置作为本讨论的子集,不单开文档 |
| 2026-04-24 | 讨论节奏纠偏 | 先讨论再记录,不提前铺大纲/原则/决策框架;允许预填的只有事实性扫描 |
| 2026-04-24 | 本轮迭代目标(用户明确) | 三条:视觉/交互一致性 + 易用性可见提升;完成半成品(定时任务通知等);Agent 架构体系整体化(含"护栏文件"如 Context.md/服务商.md) |
| 2026-04-24 | 事实侧代码扫描 | 落在"事实速览"节,7 个核心文件的现状 |
| 2026-04-25 | 记忆系统重新认知 | V3/V3.1 已上线,Karpathy 比喻已做八成;真缺只有"主题分页 + 自动体检" |
| 2026-04-25 | hermes 路线图盘点 | P0/P1 已落 3.2 / 3.5 / 3.6;3.1 并行安全 / 3.3 子目录 hint / 3.4 session 搜索 仍未做 |
| 2026-04-25 | 护栏文件定位 | dev-time schema(给开发 AI 看),不注入运行时;CLAUDE.md 加索引,改哪查哪 |
| 2026-04-25 | 服务商体系 5 点事实接续 | 接 issue tracker B-001/B-004/B-006/B-008/B-013/B-019;localStorage 随机端口是默认模型重置根因(B-004 待 v0.50.2 验证)|
| 2026-04-25 | 交互 3 点事实接续 | Markdown/Artifact follow-up 6 项已盘清;Gate 在代码里 grep 不到待澄清;工具调用稳定性 B-F13 已修但 B-008 / Sentry 8T 仍 🔴 |
| 2026-04-25 | Google design.md 仓库调研 | 不是 Material Design,是 google-labs-code/design.md(7514 stars,Apache-2.0);AI 可读的设计系统格式 spec |
| 2026-04-25 | 本轮范围最终拍板 | **整个重构一周内做完**,含视觉 + 交互 + 服务商 + 半成品 + 稳定性 + 5 份护栏 + design.md 完整版;不分步、不精简 |
| 2026-04-25 | "动能"澄清 | 错字,实为"动哪个模块改哪个模块"——但用户随后明确这是模块化原则,**不**改变本周一次性大重构的范围 |
| 2026-04-25 | shadcn Style 更正 | 不是泛泛"v7/shadcn 主题",而是将 shadcn Style 更换为 **Luma** |

## Google design.md 事实速览(2026-04-25)

仓库 `google-labs-code/design.md`(7514 stars / Apache-2.0 / 创建 2026-04-10 / 更新 2026-04-25)。

**不是 Material Design**——是 Google Labs(配 Stitch AI 设计工具)开源的"AI 编码代理可读的设计系统格式规范"。

核心做法:
- **YAML front matter**:机器可读 token(colors / typography / rounded / spacing / components)
- **Markdown body**:人/AI 可读 rationale(为什么、什么时候用、Do's and Don'ts)
- 配套 CLI:`npx @google/design.md lint`(检查 token 引用 / WCAG 对比度 / 孤儿 token / 章节顺序)、`diff`、`export --format tailwind|dtcg`、`spec`
- 标准章节顺序:Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts
- 7 条 lint 规则:`broken-ref`(error)、`missing-primary`、`contrast-ratio`、`orphaned-tokens`(warning)、`token-summary`、`missing-sections`(info)、`section-order`(warning)

**对 CodePilot 的意义**:
- design.md Part A 直接沿用此 spec 作骨架
- 配套 CLI 可以纳入 pre-commit hook 做视觉一致性检查
- `export --format tailwind` 可以反向校验我们的 shadcn token

**spec 不覆盖的部分**:Interaction / Flow / Information Architecture / Motion / Harness Visualization——这些 Part B 自己扩。

---

<!-- 本文剩余内容停留在事实层。新增决议进 agent-trust-ownership-refactor.md。 -->
