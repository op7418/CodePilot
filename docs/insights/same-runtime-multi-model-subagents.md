# 为什么先做同 Runtime 多模型 Sub-agent

> 技术实现见 handover，研究基线见 [初始调研](../research/cross-runtime-multi-agent-orchestration-2026-07-22.md) 与 [编排对标补充](../research/subagent-orchestration-competitor-followup-2026-07-24.md)。

## 用户真正要的不是固定 Profile

主控应当等于当前会话选择：用户选了哪个 Runtime、Provider、Model，哪个就是父 Agent。委派不能偷偷把父会话改成一个全局“主控模型”。Agent template 可以存在，但它只描述身份、工具和权限；模型应该允许父 Agent按任务逐次选择。

因此本版没有把 `x-researcher = Grok`、`copywriter = DeepSeek` 写成不可变映射。CodePilot Runtime、Claude Code Runtime，以及使用 CodePilot Provider proxy 的 Codex Runtime，都从各自模型选择器未置灰的兼容集合选择精确 Provider+Model route。原生 Claude AgentDefinition 和 Codex spawn 都只能可靠表达各自父 Provider 下的能力，不能拿来冒充 CodePilot 的跨 Provider 路由。

## 为什么切片从 same-runtime 开始

跨 Runtime 看起来只是多一个参数，实际会同时引入三套 tool bridge、凭据归属、上下文转换、取消、usage、权限和审计问题。先在同 Runtime 内换模型，可以先验证产品核心：

- 父 Agent 是否真的会把适合的任务交给另一个模型；
- requested model 是否到达 child request；
- 用户能否看懂父/子边界；
- 换模型是否仍受父权限上限约束。

这个切片不会锁死未来 Broker。UI 用统一 run view，CodePilot/Claude/Codex adapter 都归一到 Agent 卡片；未来跨 Runtime 只需增加真实 route metadata，而不是重做聊天体验。

## 为什么子 Agent 必须直接出现在聊天里

普通 tool call 是 Agent 的动作，默认折叠可以减少噪音；子 Agent 是新的执行主体。把它埋进同一个 collapsed 区域，会让用户误以为只是一次工具调用，也无法理解为什么模型、权限或耗时发生变化。

用户实测后，层级进一步收敛为：

- 聊天正文末尾常驻单行胶囊：模型品牌图标、Agent 名称、真实状态、详情、可选模型名；
- 不展示无操作价值的 Runtime 胶囊，Runtime 信息留在详情；
- running 与终态都可从状态旁打开详情：running 显示任务/等待态，终态补结果与 run ID；
- 完整 child token stream 不铺满主聊天，避免双重对话抢焦点。

左侧品牌图标表达实际请求/生效的模型家族，Agent 名称表达身份；拿不到模型来源时才使用通用 model 图标，不猜品牌。

## “请求模型”与“实际模型”必须分开

某些 Runtime 会把未知/不可用 model fallback 到继承模型。UI 如果只读 tool input 就写“由 B 完成”，会把请求意图冒充执行事实。

本版的规则是：

- tool input 只能证明 requested；
- Runtime result/status 明确回报才能证明 effective；
- 拿不到就显示 requested 或继承，不补假 effective；
- usage 同理，缺失就不显示假 0。

CodePilot Runtime 由本地 exact route 和实际传入 child loop 的 Provider+Model 形成可验证 breadcrumb；Claude managed child 读取 SDK init/terminal，Codex managed child读取独立 thread/turn 事实。Codex Account 原生 collab 拿不到模型时仍保持保守。

## 权限应该继承 Runtime，而不是由 CodePilot 再阉割一次

首版曾把 managed child 固定为只读，希望缩小 POC 风险，但用户复测指出这与 Claude Code / Codex 的产品心智冲突：两套 Runtime 已经有工具审批与 sandbox，CodePilot 再把 child 裁成 Read/Glob/Grep，只会让联网、Shell 和写入无故失效。

修正后的边界是：

- child 继承父会话实际可用的 built-ins、MCP 与 permission profile；
- 普通模式下，写入/Shell 继续走同一个审批或 sandbox；只有父会话已选 full access 才可无提示继承；
- Codex read-only/workspace sandbox 必须保留真实网络访问；联网不等于文件 full access，不能为了保守把 Qwen 等没有 hosted search 的第三方模型变成“有 Shell 但必然 DNS 失败”；
- `Agent` / spawn 工具仍硬移除，depth 1 与并发 2 保持清晰上界；
- Claude managed subprocess 的 `required_capabilities` 只用来发现“父 query 工具确实不存在”，不再充当 CodePilot 自设的功能阉割开关；Codex child 连这个声明层也不需要，native tools/MCP/sandbox/approval 直接以 app-server 为准。

## 依赖编排必须由 CodePilot 拥有，不能赌 Runtime 的 tool 顺序

真实会话 `3f0085c5fc664deca85005d70b1abfca` 暴露了 one-shot 合同的上限：父模型会在同一 assistant 批次一次性生成 Qwen、DeepSeek、Kimi 三个 tool input。SDK 即使按顺序执行，这些 input 也已经冻结；Qwen 后来产出的结果不会自动进入 DeepSeek 的旧 prompt。“串行执行”因此不等于“结果依赖”。

参考项目给出的共同方向更稳定：

- Google ADK 让 Agent 用 `output_key` 把结果写入 session state，再由后续节点读取；
- AutoGen GraphFlow 与 LangGraph 都把顺序、分支和状态传递表达为图上的边，不靠模型自然语言说“等一下”；
- Pydantic AI 把 delegate 的预算/事件与 durable execution 分开，说明 worker SDK 和工作流耐久性是两层问题。

CodePilot 不需要为了这一步引入完整框架，但需要采用同样的分层：父 Agent 声明 `workflow_id/task_key/depends_on`；应用先持久化 DAG 边和 queued 状态；共享 resolver 等待上游 durable terminal；共享 compiler 在目标 Runtime 真正启动前注入结果。Claude、Native、Codex 只做 Adapter，不再各自理解“等待”“完成”和“把 A 的结果交给 B”。

这个取舍还有一个 UI 含义：tool-use arrival 只能证明模型尝试调用，不能证明应用接受了 Agent。参数校验或路由预检失败且没有 durable row 时，不画胶囊；否则一个 malformed call 也会被用户误认为真实 Sub-agent。

## 实现后复盘

UI smoke 暴露了一个很典型的问题：历史工具原先把真实 tool ID 改成 `hist-N`。普通折叠工具无感，但 Agent 侧栏需要稳定 run identity；这次改为保留真实 tool_use_id。agent-run tab 仍不落 localStorage，避免增加敏感内容副本；Claude/Native 从 chat tool blocks 重建。

Codex managed bridge 是例外：为防止 proxy 已执行的工具再次回传 app-server 触发 `unsupported call`，其 function_call/tool-result 会被抑制，只有当前回合的瞬时 side-channel。真实会话证明下一回合会因此丢失 child 事实，父模型甚至拿聊天前已存在的文件猜进展。这里不能继续坚持“聊天 transcript 一定是 durable source”，所以新增 `subagent_runs` 与 `subagent_run_events`：每次真实 physical attempt 都保留，显式 retry 通过 logical run 聚合；running/settling/terminal 与当前工具来自 lifecycle，后续回合只读取每个 logical task 的最新 attempt，prompt/result 只在显式查询时作为不可信数据返回。

进一步的对标和事故复盘说明，“一个工具调用 = 一个用户可见 Agent”并不成立。限流、鉴权修复或用户确认后的重试都应当是新的物理调用，但不是新的用户任务。因此 UI 只显示一个 logical capsule，详情保留 attempt 1..N；这既避免六胶囊噪音，也不靠假去重删除审计事实。同理，child 停止输出与结果 durable 之间需要 settling 屏障，Runtime 回报的实际模型与 requested route 不一致时必须直接失败，不能用 fallback 模型“完成”原任务。

Codex 最初只完成“可见性”，用户复测因此正确地得到“调不了”。后续没有用 prompt 强迫原生 collab 冒充换模：对 CodePilot Provider 会话，复用现有 proxy bridge 创建显式 Provider+Model 的独立 child thread；对绕过 proxy 的 Codex Account，仍只承诺原生 collab 可见性。

后续真实会话还证明“只补联网工具”仍然是错的抽象：Codex child 本来就有原生工具、MCP、sandbox 和 approval。CodePilot 只应切 Provider+Model 并转发协议，不能再按 network/write/shell 画一套 capability 边界。最终删除 Codex capability 声明与 Memory-only MCP allowlist，只保留 depth 1。

但“继承”也必须继承一份真的能工作的父配置。会话 `1ff7d214c15e2ed2ba590b3183fe1293` 暴露出 canonical Codex wire 将网络固定为 false：官方 hosted search 可掩盖这个问题，Qwen Token Plan 则只能通过 Shell 联网，于是稳定得到 DNS 失败。产品语义调整为：read-only/workspace sandbox 控制本地写入范围，`networkAccess:true` 独立保证原生联网能力；审批 reviewer 仍按用户所选 profile 执行。

同一个会话还说明“模型回合结束”和“用户任务完成”是两种状态。Qwen 完整地回答了“我无法完成”，所以 app-server 合理地把 turn 标为 completed，但产品不能据此把新闻搜集标成完成。child 现在显式报告任务 outcome；正文与 completed 声明冲突时宁可显示失败，也不制造成功假象。

用户首轮真实测试还暴露了“完成”的定义错误：Claude background Agent 会先返回 `async_launched`，那只是任务已进入后台，不是子 Agent 已完成。产品状态必须跟随 child lifecycle 的终态通知，而不是跟随父 Agent 是否已经把任务发出去。

另一个更隐蔽的问题是：父模型可能不填写非法的 `model=Grok`，而是实际启动 Sonnet，再把 child prompt 写成“你是 Grok 专家”。只校验 model 字段挡不住这种假切模。因此正确边界需要同时覆盖 route 字段和显式角色伪装：Grok 在 Claude Code Agent schema 中不可路由时，必须明确失败并询问用户下一步，不能把 inherit、Sonnet 或普通主模型回答包装成 Grok 成功。

## 下一步判断门槛

只有在三类真实复测完成后，才决定下一步优先级：

- 如果父 Agent 不稳定选择 model，先做可选 template / picker hints；
- 如果三条 same-runtime managed route 已稳定但用户需要跨 Runtime，再做 Broker；
- 如果并发使用频繁，先补 individual cancel；logical-run/attempt 聚合已在三条 managed Runtime 共用；
- 如果 Codex Account 的 app-server 原生协作暴露明确 per-child Provider contract，再扩大原生能力；在此之前不做 prompt 注入冒充。
