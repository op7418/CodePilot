# Sub-agent 编排竞品补充调研

> 调研日期：2026-07-24
> 状态：调研归档；2026-07-24 根据真实依赖链事故追加 structured workflow 复核，落地事实以 active exec plan 为准
> 承接：[多 Runtime / 多模型 Sub-agent 协作可行性调研](./cross-runtime-multi-agent-orchestration-2026-07-22.md)
> 当前实现事实源：同 Runtime 多模型 Sub-agent MVP 执行计划

## 一、结论

CodePilot 当前“父会话决定主控、子 Agent 每次显式选择模型、三条 Runtime 各自适配”的方向没有走偏。最近反复出现的问题也不主要是“还少接了某个框架”，而是委派执行合同尚未完全产品化。

在排除既有调研已经重点覆盖的 Craft Agents、OpenCode、Claude Code / Codex 原生 Sub-agent 和 AutoGen 后，本轮最值得参考的是：

- **VS Code / GitHub Copilot Subagents**：最接近 CodePilot 的“每次调用可显式指定子模型”方向，并给出了明确的模型解析优先级、当前工具和用量展示。
- **Pydantic AI Harness SubAgents**：在委派预算、超时、失败隔离、共享 usage、子事件流方面最完整。
- **OpenAI Agents SDK**：对 tool call identity、嵌套事件、审批后恢复、最终完成语义和幂等副作用的定义最严谨。
- **Roo Code Boomerang Tasks**：父任务暂停、子任务独立历史、完成后只回传结果、父子任务导航的产品模型最清楚。
- **Gemini CLI Subagents**：证明“继承父工具面”和“子 Agent 不得继续委派”可以同时成立；Agent 身份、模型覆盖和运行限制可以分开配置。
- **Cline Subagents / Agent Teams**：把一次性的轻量并行研究与可跨会话恢复的团队任务拆成两层，而不是用同一种 Sub-agent 承担所有协作。
- **LangGraph / Microsoft Agent Framework**：不建议当前引入其完整工作流框架，但其 checkpoint、恢复和副作用幂等原则应直接进入 CodePilot 的运行合同。

本轮最重要的判断是：

> CodePilot 下一步应优先补“委派运行语义”，而不是继续扩大 Runtime 或模型范围。一个子任务是否可信，取决于 requested/effective route、逻辑任务与物理 attempt、真实终态、结构化产物、预算、恢复和可观察性是否一致，而不是它能否成功拉起一个进程。

## 二、竞品逐项对照

### 2.1 VS Code / GitHub Copilot Subagents

官方文档已经把“同一任务交给不同模型，再比较共识与分歧”作为正式使用模式。子模型解析顺序是：

1. 父 Agent 本次调用显式指定的模型；
2. 自定义 Agent 的默认模型；
3. 父会话模型。

聊天 UI 会显示子 Agent 名称、当前正在使用的工具，展开后可以看 prompt、全部工具调用和返回结果，悬停还可查看子 Agent 的 AI credits。[官方文档](https://code.visualstudio.com/docs/agents/subagents)

**值得借鉴**

- CodePilot 未来即使重新引入 Agent Template，也应采用同样的“调用参数 > 模板默认值 > 继承父会话”优先级。模板不应重新变成固定 Profile。
- “多模型共识”可以做成受支持的编排模式：同一输入、不同模型、独立上下文，父 Agent 必须显式整理一致结论、冲突结论和证据差异。
- 胶囊或详情面板应在运行中显示 `current tool / elapsed / tokens / cost`，但 cost 只能在 Provider 返回可信 usage 时展示。

**不应照搬**

- VS Code 在子模型超过父模型成本层级时会回退到父模型。CodePilot 已经有 requested/effective route 诚实展示要求，**显式指定的子模型不可静默回退**；应在启动前失败并询问用户，或把可接受 fallback 作为用户明确选项。
- VS Code 默认把子 Agent 折叠为 tool call；CodePilot 已有用户裁决，应继续用聊天流中的单行胶囊，不退回折叠卡片。

### 2.2 Pydantic AI Harness SubAgents

Pydantic AI 的 SubAgents 使用单一 `delegate_task(agent_name, task)` 工具，每个 child 获得独立上下文。它允许共享父子 usage，给每个 delegate 设置 `usage_limits`、`timeout_seconds`、`max_calls` 和失败策略，并能把 child event stream 传回调用方；委派工具本身会从继承工具中排除，避免递归。[SubAgents 文档](https://pydantic.dev/docs/ai/harness/subagents/) [多 Agent 模式](https://pydantic.dev/docs/ai/guides/multi-agent-applications/)

**值得借鉴**

- CodePilot 不能只靠 `depth=1`、`concurrency=2` 和墙钟 timeout 控制运行。每个 run 还应支持：
  - `maxTurns`
  - `maxToolCalls`
  - `maxProviderRequests`
  - `idleTimeout`
  - `hardTimeout`
  - 可获得时的 token / cost budget
- 父子 usage 应能聚合，但不同 Provider 的“费用”不能伪装成统一精确值。应先可靠保存 requests、tokens、tool calls，金额只显示真实返回值。
- Pydantic 把这些限制定义为 **soft limits**：delegate 返回转向消息后，父 Agent 仍可能继续。CodePilot 的 foreground one-shot 合同选择“受控终止并尽量保留部分结果”是产品适配，不是 Pydantic 的原始语义；是否把 budget exhausted 从 failed 改为 partial 仍需单独决策。
- child event stream 应作为 UI 当前活动与审计历史的数据源，而不是从最终文本猜测进度。

**不应照搬**

- Pydantic 的静态 named-agent registry 很适合服务端应用，但 CodePilot 的模型目录是用户配置且动态变化的。应继续让 route 可由本次调用选择，模板只提供身份和策略默认值。

### 2.3 OpenAI Agents SDK

OpenAI Agents SDK 把 manager + agents-as-tools 与 handoff 明确区分。CodePilot 当前属于前者：父 Agent 保持对话控制权，child 只完成一段工作。Agent tool 支持传递嵌套运行事件；`toolCallId` 是回传结果和恢复审批的路由标识，官方同时强调副作用应按 call ID 幂等。[多 Agent 编排](https://openai.github.io/openai-agents-js/guides/multi-agent/) [工具](https://openai.github.io/openai-agents-js/guides/tools/)

其 streaming result 还有一个重要语义：只有 run 与回调全部完成后，`completed` 才会 resolve；取消后可能没有 final output，需要从可序列化状态恢复，而不是伪造一条新消息继续。[结果与 streaming](https://openai.github.io/openai-agents-js/guides/results/) [会话](https://openai.github.io/openai-agents-js/guides/sessions/)

**值得借鉴**

- `agent_name` 只用于展示，不能作为运行路由键。数据库、SSE、权限请求、取消和重试都必须使用不可变的 `logical_run_id / attempt_id / tool_call_id`。
- “模型结束输出”不等于“任务已完成”。结果 checkpoint、artifact 持久化、权限回执和必要的 post-processing 全部结束后，run 才能进入 terminal completed。
- effective route、usage、run identity 等 UI 元数据应走 app-only metadata，不应混入模型可见的 tool result 再污染上下文。
- 审批恢复应恢复原 run state；不能把批准后的继续执行建成一个没有关联的新子任务。

### 2.4 Roo Code Boomerang Tasks

Roo Code 为每个子任务创建独立历史。父任务暂停，child 完成后通过明确的 completion result 回传，父任务再恢复；UI 可以在父子任务之间导航，并展示层级。向下传递的是明确任务，向上返回的是完成结果，而不是 fork 整段父历史。[官方文档](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)

**值得借鉴**

- 把 context contract 写成双向合同：
  - down：目标、必要上下文、route、工具/权限、预算；
  - up：状态、summary、sources、artifacts、warnings、usage、provenance。
- 详情侧栏应支持父任务与当前 child 的明确导航；不能只展示一段临时文本。
- 顺序依赖的子任务应表达为显式依赖，而不是让父模型靠自然语言记住“等 A 完成再启动 B”。

**不应照搬**

- Roo 默认在创建和完成时都要求批准，对日常 CodePilot 使用过于打断。只有 route、成本或权限边界发生实质变化时才需要启动审批。
- Roo 把 child completion summary 作为父任务主要事实源。CodePilot 不能只信自由文本 summary；状态、来源、产物和真实路由必须由应用层结构化字段承载。

### 2.5 Gemini CLI Subagents

Gemini CLI 把每个 subagent 暴露成父 Agent 的工具。Generalist 可以继承父 Agent 的工具与配置，但运行在独立上下文；专用 Agent 可以覆盖模型、max turns、工具和会话策略。即使工具配置使用通配符，subagent 也不能继续调用 subagent。[官方文档](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md)

**值得借鉴**

- “继承 Runtime 原生工具”与“禁止递归委派”不是二选一。CodePilot 应继续继承该 Runtime 本身支持的工具面，再在最后一步硬排除 delegation tool。
- Agent 身份、模型、工具、预算应是独立字段。一个“研究员”可以本次用 Kimi、下次用 DeepSeek，而不是身份名称隐含 route。
- 未来可提供用户直接点名 Agent 的入口，但 direct invocation 与父模型自动委派应共用同一运行合同。

### 2.6 Cline Subagents 与 Agent Teams

Cline 的轻量 Subagents 只用于同一会话内的并行研究，每个 child 有独立上下文、token budget、工具调用/费用统计；若未开启自动批准，启动前会展示计划发送的 prompts。[Subagents 文档](https://docs.cline.bot/features/subagents)

Cline Agent Teams 则是另一层：协调者、共享任务板、inter-agent mailbox、mission log，并把团队状态持久化以支持跨会话恢复。[Agent Teams 文档](https://docs.cline.bot/cli/agent-teams)

**值得借鉴**

- CodePilot 当前的 foreground Sub-agent 只应解决一次委派。共享任务板、Agent 互发消息、长期恢复属于未来的“Agent Team / Workflow”，不应继续塞进当前单个胶囊。
- 当启动需要用户批准时，批准面板可展示将发送给各 child 的任务摘要与真实 route。
- 详情面板可增加每个 run 的工具调用数、token、可信费用和执行时间。
- 如果未来做跨窗口、跨客户端或后台长期任务，应把协调和执行与 UI 进程解耦；Cline 的 hub-spoke 设计就是为 session 存活、多客户端和进程隔离服务。[Hub-Spoke 架构](https://docs.cline.bot/sdk/architecture/hub-spoke)

**不应照搬**

- Cline 轻量 Subagents 固定只读、不可联网或使用 MCP，与 CodePilot 已确定的“继承 Runtime 本身支持的工具”不一致。
- 当前阶段不应直接做 team mailbox 或任务看板；这会把尚未稳定的一次委派语义放大成更难恢复的分布式状态。

### 2.7 LangGraph 与 Microsoft Agent Framework

两者都把 durable execution 建立在 step / superstep checkpoint 上。恢复时可能重跑当前 step，因此外部副作用必须幂等；已完成的调用结果应被 checkpoint，恢复后不应重复执行。[LangGraph persistence / time travel](https://langchain-ai.github.io/langgraph/concepts/time-travel/) [Microsoft durable agents](https://learn.microsoft.com/en-us/azure/durable-task/sdks/durable-agents-microsoft-agent-framework)

**值得借鉴**

- CodePilot 应区分：
  - logical delegation：用户眼中的一个子任务；
  - physical attempt：一次 Provider / Runtime 执行；
  - step / tool call：可能产生副作用的最小恢复单元。
- 重试应创建新 attempt，但 UI 默认只展示一个逻辑胶囊，并在详情中说明“第 2 次尝试”。
- 写文件、命令、外部 API 等副作用需要稳定 idempotency key；否则“恢复运行”可能重复执行。

**不应照搬**

- 当前无需引入 Temporal、LangGraph 或完整 workflow runtime。先在本地数据库和现有 Runtime adapter 上建立相同语义，再决定是否需要外部工作流引擎。

### 2.8 Structured workflow 复核：Google ADK / AutoGen GraphFlow / LangGraph / Pydantic

真实会话 `3f0085c5fc664deca85005d70b1abfca` 暴露了 one-shot 提示词合同解决不了的结构问题：父模型在同一 assistant turn 里同时生成 Qwen research 与 DeepSeek copy 两个 tool input；SDK 虽然串行执行它们，但 DeepSeek 的 prompt 已在 Qwen 输出产生前被冻结，因此不可能自动获得 Qwen 结果。父模型甚至把 DeepSeek prompt 写成“目前处于等待状态”，导致一个本应由编排器表达的依赖被伪装成已启动的 Agent。

四个参考实现给出的共同解法很一致：

- **Google ADK**：workflow agent 负责顺序/并行；LlmAgent 用 `output_key` 把最终文本写入 session state，下游 instruction 从 state 注入。官方并行研究示例让三个 researcher 各写独立 `output_key`，再由后续 merger 消费，而不是提前生成 merger 的输入。[ADK state / output_key](https://adk-labs.github.io/adk-docs/sessions/state/) [ADK ParallelAgent 示例](https://adk-labs.github.io/adk-docs/agents/workflow-agents/parallel-agents/)
- **AutoGen GraphFlow**：node 是 Agent、edge 是允许的执行路径；顺序、parallel fan-out、join、condition 都由 `DiGraph` 控制。官方明确建议：当执行顺序或分支需要严格控制时，应从 ad-hoc group chat 切到 structured workflow。[GraphFlow](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/graph-flow.html)
- **LangGraph**：共享 `State` 是快照，node 返回 state update，edge 决定下一 node；checkpointer 在 super-step 边界持久化。它还明确要求可重跑 node 的副作用必须幂等。[Graph API / state and edges](https://langchain-ai.github.io/langgraph/how-tos/state-reducers/) [Agent Server run lifecycle](https://langchain-ai.github.io/langgraph/concepts/langgraph_server/)
- **Pydantic AI Harness**：`delegate_task` 适合自包含的一次委派，父 deps/usage 与 child event 可统一传递；当任务需要跨重启、长运行或 human-in-the-loop 时，官方另用 Temporal / DBOS / Prefect / Restate durable integration，而不是让 delegate 自由文本承担恢复。[Harness SubAgents](https://pydantic.dev/docs/ai/harness/subagents/) [Durable execution](https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/)

**CodePilot 取舍**

- 不引入上述框架依赖；三条 Runtime 继续只是 worker backend。
- 在 CodePilot 自己的 durable orchestration layer 增加 `workflow_id + task_key + depends_on`。Adapter 先写 queued run，应用层只从 `sqlite.subagent_runs` 读取上游 terminal result，并在真正启动下游 Runtime 时编译 child prompt。
- `tool_use arrived`、`schema accepted`、`durable queued`、`Runtime executing`、`terminal` 是不同事实。managed 胶囊只为 durable row 展示；参数/route 预检错误不冒充 Agent。
- 依赖 task 失败或没有 durable result 时，下游不启动 Provider；未声明依赖的 wait/stand-by placeholder 在应用层拒绝。
- 调用方按拓扑顺序先创建 upstream；缺失上游仅保留短暂并行创建宽限，随后 fail-fast，避免 serial tool executor 因 dependent-first 顺序长期阻塞。
- 这一步先支持轻量 DAG edge，不扩成完整 workflow engine。应用层会拒绝 self/indirect cycle；真正的循环节点、条件分支、跨进程 worker、恢复后副作用重放仍属于后续层。

## 三、调研识别的问题与 P0 落地状态

以下条目保留当时的设计判断，同时补充 2026-07-24 P0 已落地的事实。执行状态、验证证据与未结项以 active exec plan 为准，不能用 research 文档代替。

### 3.1 逻辑任务与物理调用没有完全分层

用户说“启动三个 Sub-agent”，产品应显示三个逻辑任务。某个任务因 403、timeout 或用户允许 fallback 而重试，可以产生多个 physical attempts，但不应再增加同级胶囊。

建议的数据关系：

```text
parent turn
  └─ logical delegation run
       ├─ attempt 1 → failed / AUTH_FORBIDDEN
       └─ attempt 2 → completed
            └─ tool calls / artifacts / usage
```

关联必须来自显式、不可变的 ID，不能靠 `agent_name`、prompt、模型或时间接近程度猜测：

- 首次调用省略 `logical_run_id`，应用层生成 logical run，并把该 ID 返回给调用方。
- 父 Agent 只有在重试**同一个任务**时，才复用上一 attempt 返回的 `logicalRunId`；每次 Provider / Runtime 执行仍生成新的 `attempt_id` 与递增 `attempt_number`。
- 未来若增加胶囊上的“重试”按钮，应由应用层直接携带原 `logical_run_id`，这是比依赖模型记忆更可靠的入口。
- **缺省行为必须保守并优先保留审计事实**：没有显式 retry 关联时创建新的 logical run、平铺为另一枚胶囊；宁可让用户看到两次调用，也不得按名称或相似文本静默合并。
- 显式 ID 也不是无条件通行证：最新 attempt 仍在 running/settling 时拒绝为 `LOGICAL_RUN_STILL_RUNNING`；已经 completed 时拒绝为 `LOGICAL_RUN_ALREADY_COMPLETED`。只有 failed/partial/timed_out/cancelled 等 terminal 结局允许追加 attempt。

P0 已按上述规则落地；历史 physical-only 行保守回填为各自独立的 logical run / attempt 1，没有推测旧调用之间的重试关系。上述 active/completed 应用层守卫由 Claude P2 复核补入，拒绝发生在 Provider 启动与 physical row 插入之前。

### 3.2 模型解析和 fallback 尚未成为不可变合同

建议固定为：

```text
explicit per-call route
  > editable template default route
  > inherit parent route
```

- 本次调用显式指定 route 后，任何不可访问、未授权或 Runtime 不支持都必须 fail-closed。
- 只有用户或父 Agent 在工具参数里提前声明允许的 fallback 才能重试。
- 每个 attempt 都保存 requested route 与 effective route；二者不同必须产生显式 warning。

P0 同时收紧了既有 capability gate：Claude 路径不再因“存在任意 MCP server”就推断具有 read / network / write 能力；`network_search` 只由真实工具面证明。Runtime 上报的模型与请求 route 不一致时，当前 attempt 以 `ROUTE_MISMATCH` 失败，不接受静默 fallback。

### 3.3 terminal completed 仍可能早于“用户真正拿到结果”

建议内部增加 `settling` 语义，即使不直接显示给用户：

```text
running
  → settling (模型终止；等待结果、artifact、usage 和回调落盘)
  → completed / partial / failed / timed_out / cancelled
```

只有结构化结果与用户可见内容已经 durable 后才写 terminal。否则刷新后仍会出现“数据库完成，但内容或文件没保存”的假完成。

实现落点不能直接扩展 `subagent_runs.status`：该列有 terminal 状态的 `CHECK` 闭集。P0 采用独立的 `phase IN ('running', 'settling', 'terminal')` 列，`status` 继续表达用户可见执行结局；additive migration、legacy backfill 和原子 terminal transaction 已进入执行计划与回归测试。

### 3.4 结果仍缺统一的结构化来源

建议父 Runtime 最终接收统一结果：

```ts
interface DelegatedAgentResult {
  status: 'completed' | 'partial' | 'failed' | 'timed_out' | 'cancelled'
  summary?: string
  error?: { code: string; httpStatus?: number; retryable?: boolean }
  sources: Array<{ title?: string; uri?: string; trust: 'external' | 'workspace' | 'runtime' }>
  artifacts: Array<{ kind: string; pathOrId: string; persisted: boolean }>
  warnings: Array<{ code: string; message: string }>
  usage?: {
    requests?: number
    inputTokens?: number
    outputTokens?: number
    toolCalls?: number
    costUsd?: number
    measurementSource?: 'provider' | 'runtime'
  }
  provenance: {
    logicalRunId: string
    attemptId: string
    attemptNumber: number
    requestedProviderId?: string
    requestedModel?: string
    effectiveProviderId?: string
    effectiveModel?: string
  }
}
```

`trust`、route 和 persisted 状态应由应用层填写，不能让 child 模型自报。

P0 已保留 top-level structured `error`，并用 `costUsd` 明确货币；缺失 usage 不显示假 0。`measurementSource` 尚未持久化，属于 P1 provenance 补强：在它落地前，只有 Adapter 从真实 Provider / Runtime 响应取得的金额才允许展示。

### 3.5 budget 只有粗上界，没有“整棵树”的真实核算

并发数和深度只解决失控扩张，不解决单个 child 长时间烧 token 或重复调用工具。预算既要 per-attempt，也要聚合到 parent turn。Provider 没有 usage 时应显示“不可用”，不能显示 0。

### 3.6 UI 有状态，但缺运行中事实

单行胶囊方向正确；下一步不是重新做卡片，而是补少量可信信息：

- 当前工具或阶段；
- 已运行时间；
- attempt 次数；
- partial / waiting approval / settling；
- token、工具调用和费用（有真实数据时）；
- 详情面板中的 prompt、route、事件、来源、产物和错误。

### 3.7 批准、取消、重试仍可能命中错误对象

两个同名 Agent 并行时，名字不能参与路由。所有用户动作都必须带稳定的 run / attempt / call ID。取消一个 attempt 不应取消 sibling 或父回合；父回合 Stop 则必须向下传播。

权限请求也遵守同一规则。P0 前的 child `canUseTool` 裸透传会让审批弹窗看起来属于父会话；现已由 wrapper 注入 run / session / agent transport metadata，并记录 `permission_requested / permission_resolved` lifecycle event。真实凭据下的审批归属和定向批准仍保留在 Smoke Ledger，不能用合同测试冒充。

### 3.8 恢复语义尚未覆盖副作用幂等

保存正文和 run 状态只是第一步。若 child 写文件后进程退出、但 terminal 尚未落盘，恢复不能无条件重跑写操作。至少需要为可恢复 tool call 保存输入摘要、call ID、状态和结果引用。

### 3.9 一次性 Sub-agent 与长期 Agent Team 需要产品分层

当前胶囊代表 foreground delegation。未来只有在需要共享任务板、Agent 间通信、后台持续运行和跨会话恢复时，才引入 Team / Workflow 概念。否则用户会无法判断一个胶囊究竟是一次调用、一个长期 worker，还是一个可继续对话的 session。

## 四、落地状态与后续优先级

### P0：可信运行合同（2026-07-24 已完成代码与定向验证）

1. 引入 `logical_run_id` 与 `attempt_id` 分层；只有显式 retry 关联才复用逻辑胶囊。
2. 固化 route 优先级与 fail-closed，禁止任何静默模型回退。
3. terminal 写入晚于结果、artifact、usage 和 post-processing 持久化；以独立 `phase` 列支持 `settling`。
4. 统一结构化 result / error / provenance，应用层标注 trust 和 requested/effective route。
5. child lifecycle 使用 typed event，至少包含 current tool、activity time、permission、partial result 和 terminal。

上述五项已经进入 active exec plan、定向回归与 Dev UI smoke；真实 Provider route report、retry ×N、审批和长任务切换聊天仍按 Smoke Ledger 待测。

### P1：补预算、观察性和常用编排

1. per-attempt 与 parent-tree 的 turns / requests / tool calls / timeout / token 预算；usage 增加 measurement source。
2. 胶囊和详情面板增加真实 elapsed、attempt、tool、usage；无数据不造值。
3. ~~顺序、并行与依赖关系成为显式字段，不让父模型只靠提示词维持。~~ 2026-07-24 已进入 exec plan Phase 6：三 Runtime 共用 `workflow_id/task_key/depends_on`、queued dispatch state 与 app-side result handoff compiler；真实三模型链 smoke 待跑。
4. 增加“多模型共识”编排模板：同题独立运行，父 Agent 输出 agreement / disagreement / evidence。
5. 用户可直接点名 Agent 身份，但身份选择与模型 route 选择保持独立。

### P2：再做恢复和长期协作

1. 审批后从原 run state 恢复。
2. tool-call checkpoint 与副作用幂等。
3. 确有需求后再设计后台 Team / Workflow、任务板和 inter-agent mailbox。
4. 跨 Runtime Broker 在以上合同稳定后进入，不提前放大状态复杂度。

## 五、建议补入的验收矩阵

| 场景 | 必须成立 |
|---|---|
| 一个逻辑 Agent 首次 403、用户通过重试按钮或父 Agent 显式复用 `logical_run_id` 换模型重试 | UI 仍是一枚胶囊；详情有两个 attempts；requested/effective route 分别可见 |
| 两次调用未声明 retry 关联，即使 Agent 名称、prompt 或模型相同 | 保留两个 logical runs / 两枚胶囊；不静默推断和合并 |
| 复用仍在 running/settling 的 logical ID | Provider 不启动、不新增 attempt；返回 `LOGICAL_RUN_STILL_RUNNING` 并引导等待/读取当前 run |
| 复用已 completed 的 logical ID | Provider 不启动、不新增 attempt、不遮蔽成功结果；返回 `LOGICAL_RUN_ALREADY_COMPLETED`，新工作必须使用新 logical run |
| 显式模型不可访问 | 不继承父模型、不静默换模型；返回结构化失败并询问用户 |
| child 已生成正文，但 artifact 持久化失败 | 不得显示 completed；保留 partial 与明确 warning |
| child 模型结束，回调仍在落盘 | 保持 running/settling；刷新后不会提前 completed |
| 两个同名 Agent 并行 | 权限、事件、详情、取消按 ID 隔离，不按名字串台 |
| 取消 sibling A | A cancelled，B 继续；父回合可继续收 B |
| 父回合显式 Stop | 所有 active child 收到取消并进入终态 |
| max turns 触顶（当前行为） | 返回 partial，保留正文、来源、artifact 和已用 usage |
| budget 触顶（当前行为） | 返回 failed + `MAX_BUDGET`；若 P1 决定改为 partial，必须作为显式行为变更并补迁移/回归，不能当成当前验收 |
| 写文件后、terminal 前进程退出 | 恢复不得重复同一副作用；记录 interrupted/可恢复状态 |
| Provider 实际路由与请求路由不一致 | 不把 attempt 伪装为成功命中目标模型；产生 route mismatch warning |
| 外部内容含伪造 completion marker | 应用层状态不受外部文本影响；external source 保持 untrusted |
| 切换聊天或刷新 | 运行继续，胶囊从 durable event 恢复；最终结果不丢、不重复 |
| 父模型在同一 turn 声明 `research → copy → implementation` | 三个 durable task；copy 启动时 prompt 含 research terminal result，implementation 含其声明的全部上游结果 |
| tool input 因 schema/capability 格式错误被拒 | 不创建 `subagent_runs`，不显示幽灵 Agent 胶囊；父 Agent 收到结构化错误并修正 |
| downstream prompt 写“等待 Agent 结果”但未声明依赖 | Provider 不启动，返回 `DEPENDENCY_DECLARATION_REQUIRED` |
| 同 workflow 重复 task_key | 不创建第二个 logical Agent；只有显式复用失败 logical run 才能成为 retry attempt |
| A depends B、B depends A | closing task 在 durable insert / Provider 启动前返回 `INVALID_DEPENDENCY_SPEC`，不得等待到超时 |

## 六、建议暂时明确不做

- 不因竞品保守而重新把 child 限制成只读；继续遵守用户已经确认的 Runtime 工具继承语义。
- 不开放任意深度递归；当前 depth 1 保持。
- 不复制 VS Code 的静默成本层级回退。
- 不把 child 的自由文本 summary 当 terminal 或来源事实。
- 不立即引入完整 workflow engine、team mailbox 或跨进程 daemon。
- 不让 Profile / Template 再次成为调用子模型的必选前置。

## 七、参考资料

- [VS Code: Subagents](https://code.visualstudio.com/docs/agents/subagents)
- [Pydantic AI: Multi-Agent Patterns](https://pydantic.dev/docs/ai/guides/multi-agent-applications/)
- [Pydantic AI Harness: SubAgents](https://pydantic.dev/docs/ai/harness/subagents/)
- [Pydantic AI: Durable Execution](https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/)
- [OpenAI Agents SDK: Agent Orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/)
- [OpenAI Agents SDK: Tools](https://openai.github.io/openai-agents-js/guides/tools/)
- [OpenAI Agents SDK: Results](https://openai.github.io/openai-agents-js/guides/results/)
- [OpenAI Agents SDK: Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
- [Roo Code: Boomerang Tasks](https://roocodeinc.github.io/Roo-Code/features/boomerang-tasks/)
- [Gemini CLI: Subagents](https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md)
- [Cline: Subagents](https://docs.cline.bot/features/subagents)
- [Cline: Agent Teams](https://docs.cline.bot/cli/agent-teams)
- [Cline SDK: Hub-Spoke Architecture](https://docs.cline.bot/sdk/architecture/hub-spoke)
- [LangGraph: Time Travel / Checkpoint](https://langchain-ai.github.io/langgraph/concepts/time-travel/)
- [LangGraph: Graph API / State and Edges](https://langchain-ai.github.io/langgraph/how-tos/state-reducers/)
- [LangGraph: Agent Server Run Lifecycle](https://langchain-ai.github.io/langgraph/concepts/langgraph_server/)
- [Google ADK: Session State and output_key](https://adk-labs.github.io/adk-docs/sessions/state/)
- [Google ADK: Parallel Workflow](https://adk-labs.github.io/adk-docs/agents/workflow-agents/parallel-agents/)
- [AutoGen: GraphFlow](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/graph-flow.html)
- [Microsoft Agent Framework: Durable Agents](https://learn.microsoft.com/en-us/azure/durable-task/sdks/durable-agents-microsoft-agent-framework)
