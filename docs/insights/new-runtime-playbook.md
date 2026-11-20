# 为什么我们需要 "New Runtime Playbook"

>
> 关联：[harness-capability-contract.md](./harness-capability-contract.md)（本 playbook 服务的底座）

> 创建：2026-05-17（Phase 5d Phase 5）

---

## 触发：Codex 三天 ≠ "Codex 很难"

接 Codex Runtime 持续三天才稳，这个数字看起来像是 Codex 协议复杂。其实不是。复盘下来：

1. Codex 协议本身并不比 Claude Code SDK 复杂；多了一层 Responses proxy 翻译，但翻译层的 8 个 hook 写一遍就清楚（见 provider-proxy-bridge.md）。
2. 大部分时间花在**反复发现 CodePilot 自己的能力散落在三处**。比如 widget：MCP 一份 prompt、Native AI SDK ToolSet 一份 prompt、Codex bridge 又一份 prompt——每发现一处漂移就在该处补字段，然后 smoke 又揭露下一处。
3. 救火 30+ 次。每次都是"smoke 失败 → 加日志 → 看模型行为 → 推理可能原因 → 改一处 → 跑下一轮 smoke"。烧的不是 Codex，烧的是这个**循环**。

如果下一次接 Hermes / Gemini Live / OpenClaw 仍然走这个循环，会再花三天。第四个、第五个 Runtime 一样。

所以 Phase 5d 的目标从一开始就**不是修 Codex**——Codex 已经稳了。是把 Codex 救火期间补出来的所有 hack 沉淀成"下一次不用救火"的结构。

Playbook 是这个结构的最终一公里。

---

## 为什么写"硬性顺序"，不写"建议"

第一稿其实写过一份 "Migration guide for new Agent Runtimes"，措辞客气："首先建议……可以考虑……如果时间紧可以先……"。

但是再回头看 Codex 救火过程，每一次"先 smoke 看看再补字段"都是因为软建议没有强约束力。Smoke 压力下，最便宜的动作永远是"再补一个字段重跑"。

软建议在压力下没用。所以本 playbook 用 "禁止 / 必须 / 完成准则" 措辞，把"先 contract，后 smoke"写成结构性强制：

- Step 5 "Contract Tests Gate" 是为了**让"接入新 Runtime"和"开始 live smoke"之间有个测试关卡**。这个关卡不需要任何真实凭据，没有借口跳过。
- Step 1 "Schema Snapshot" 是为了让 fixture 比代码先在 repo 里存在。snapshot 文件存在，下次接入就有事实底座；不存在，下次又开始猜。
- Step 6 固定 9 项 smoke matrix 是为了**消除"smoke 项目自由发挥"**——Codex 救火期间每次的 smoke 集合都不一样，所以每次都漏验某个能力。

这些约束加起来回答一个问题：**下一次接入还会持续三天吗？** 答案应该是不会，因为 fixture / contract / facade / smoke 都已经卡好顺序，不再依赖谁的"经验直觉"。

---

## 反模式来自真实事故

handover 文档里列的 7 条反模式，每一条都是 Codex 期间真实发生的代码模式：

1. **Live-smoke-driven patching**：slice 1-6 整整六次都是先 smoke 再补字段。后来用 capability-contract.ts 一次定下 7 个能力的支持矩阵，slice 7 之后才进入"测试驱动"。
2. **Speculation 当 source-of-truth**：slice 4 之前曾经基于"假设 image_generation 返回 base64"写了三个版本的 MediaBlock 构造逻辑，每个版本都漂在 ai-sdk fixture 之外。直到把真实 SSE fixture 抓下来才知道 GLM 返回的是 url。
3. **同概念三份独立实现**：slice 6 暴露的 widget 三份 prompt drift，是触发整个 Phase 5d 立项的直接原因。
4. **机器读不通的人写示例**：widget 的 `\\\\\"` 双重转义；模型抄过来就 parse 失败，但人眼看不出来。修复是把 HTML 单引号化（slice 7）。
5. **错误静默掉**：slice 5 之前 widget 解析失败的 fence 直接丢弃，用户看到空消息以为是模型问题；其实是 JSON 不合法。修复加了 `MalformedWidgetNotice`，错误必须显式可见。
6. **catalog 用 notes 含糊"部分支持"**：slice 7 第一版的 `tasks_and_notify` 同时挂了 buddy 但 Codex bridge 没真挂 buddy；用 "notes: Codex 未挂载 buddy" 蒙混；review 反馈"`live` 必须严格"——slice 7b 把 buddy 拆成独立 capability，状态从 live 降到 deferred。
7. **越级改 provider proxy translator**：Phase 5d Phase 2 review 时差点把"compiler 应该影响 provider option"的需求塞进 translator；最后改用 `bodyWithBridgePrompt` 在 adapter facade 层 splice 进 `instructions`，没动 translator 主逻辑。

每条都有具体伤口。playbook 写出来是为了让下次接入的人不用重新挨这些刀。

---

## 取舍：Capability vs Provider 的边界

playbook Step 0 提了一句**"先走 Provider 路径，再升级到 Runtime"**。这是反复犯过的错——曾经把"GLM 通过 Codex Runtime"和"GLM 直接接 OpenAI-compat provider"看作互斥两条路。

事实更朴素：

- Provider 是协议兼容层（OpenAI / Anthropic / 兼容；它自己有 stable wire format）。
- Runtime 是 agent 协议层（请求/事件/工具/permission，整套 agent loop 的形态）。

GLM / Kimi / Qwen 这些自己**没有** agent runtime，它们只是模型 + tool calling 协议；要的是 **provider**。把它们当 Runtime 接是把简单问题搞复杂。

真正属于 Runtime 的：Claude Code SDK（自带 MCP + permission）、Codex（自带 app-server + plugins）、Hermes（如有自己的 agent loop）、Gemini Live（自带 realtime websocket 协议）。

playbook Step 0 写成硬判断："如果只是换 endpoint，走 Provider"。把"我们不需要为它新增一个 Runtime"作为合法答案显式列出来，避免下一次接入的人因为"已经选了走 Runtime 路径"而推不回去。

---

## 局限和未来方向

playbook 不解决的几件事：

1. **真实凭据的私有性**：smoke matrix 跑通需要每个 provider 的凭据。CI 不持有这些凭据；smoke 永远是开发者本地手工跑。短期没有更好答案；长期可以考虑 "synthetic SDK mock" 让 contract test 部分覆盖 smoke 场景，但今天还不在 Phase 5d 范围。
2. **Permission 协议跨 Runtime 不统一**：ClaudeCode SDK 有 hook_callback，Codex 是 approve_command/approve_patch，Hermes 可能又一套。Phase 5d 没有抽象 permission contract（只抽象了 capability + artifact）。下次接 Hermes 时如果 permission 协议大改，需要补 Phase 5e。
3. **Runtime hot-swap**：用户在同一会话中切 Runtime 当前不被支持（thread token 不能跨 Runtime 复用）。Phase 5d 后规则更清晰但没解决体验问题。
4. **Token 估算精度**：compiler 用 char/4 估算，Phase 2 文档允许 ±20%。如果未来某 Runtime 对系统提示长度敏感（比如 context 窗口很小），可能需要引入 tokenizer 依赖。今天不引入。

这些都不影响 playbook 适用；接入新 Runtime 仍然按 7 步走。出现以上某个限制时单独立 follow-up。

---

## 对外参考

- Anthropic Claude Agent SDK 官方文档（MCP 集成方式是 playbook Step 4 fence/SSE/PreviewSource 三分类的灵感来源——SDK 把 artifact 渲染从 tool 边界明确剥开）。
- AI SDK v6 `tool({ inputSchema: jsonSchema(...) })` 合约（Phase 5d Phase 3 facade 输出的 `toolDescriptors` 字段命名沿用了这套术语）。
- Codex / GPT-5 公开协议文档：`provider-proxy-bridge.md` 总结的 8 hook 是直接读 Codex CLI 源码 + ai-sdk 适配源码后整理的。
- 反例库：本仓库 Phase 5c slice 1-6 各 sub-plan 的"失败原因"段落，集中体现了 playbook 反模式的真实形态。

---

## 决策日志

- **2026-05-17**：Phase 5d Phase 5 落地。Playbook 不是"接入文档"——接入文档是 Hermes / Gemini 真接入时各自写的 handover；Playbook 是**接入流程本身**的硬约束。
- **2026-05-17**：Playbook 故意把"硬性顺序"放在文档顶层而不是末尾。Codex 救火期间多次因为"先看完所有 step 再决定从哪步开始"而失去时机；本 playbook 鼓励边读边按顺序走。
- **2026-05-17**：Insights 文档显式列出 7 条反模式 + 真实事故对应关系。这避免 playbook 沦为"规则集合"——规则没有事故支持就会被绕过。
