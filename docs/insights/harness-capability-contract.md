# Harness Capability Contract — Why

> 相关：[docs/insights/codex-tool-bridge.md](./codex-tool-bridge.md)（Phase 5c bridge 的产品视角）

## 为什么不再是"再补一条 prompt"

Phase 5c 接入 Codex Runtime 的过程暴露了真正的问题：

**ClaudeCode 稳，是因为它原生理解 MCP / tools / permissions。** CodePilot 只要把 in-process MCP server 注入进去，工具调用 / 工具结果 / 权限往返都不经过我们写的二次协议翻译。

**Codex Account 稳，是因为它跑自己的模型 + plugin 栈。** CodePilot 仅消费 `item/completed` 通知，不参与执行决策。

**Codex Runtime + CodePilot provider（GLM / Kimi / openai-oauth 等）这条路就脆**，因为链路是：

```
Codex app-server → Responses proxy → AI SDK streamText → upstream model
                  → Responses SSE → Codex app-server → CodePilot UI
```

每个箭头都是我们自己写的翻译层。每一层都可以独立漂移。然后再把 Memory / Tasks / Widget / Image / Media / Notify 这些 CodePilot 自有能力**在三个地方各写一遍**（MCP factory / Native AI SDK tools / Codex bridge factory），就有了 7 × 3 = 21 个独立维护的工具表面。

slice 6 暴露的就是这种漂移：三份不同措辞的 `WIDGET_SYSTEM_PROMPT`，模型在不同 Runtime 下被告知不同的"什么是合法 widget"，自然就生成不同质量的输出。

## 为什么是契约而不是"再重构一次"

我没有合并 MCP / Native / bridge 三个实现成一份代码。原因：

- 三个 Runtime 调用方式天然不同（SDK MCP 协议 / ai-sdk `tool({execute})` / Codex Responses proxy 内执行）。强行合并会让某一边变难看。
- 现有实现各自成熟，强合并风险大。
- 用户的不变量是"行为一致"，不是"代码一致"。三份实现可以并存，只要它们说的是同一件事、做的是同一件事。

所以 Phase 5d 选择**契约 + 测试**：

- 契约文件用 TypeScript import 声明哪份 prompt 是权威，其它两个 Runtime 通过 `import` 复用。
- drift 测试在 CI 里跑，编辑 prompt 但忘了同步 import 立即红。
- artifact wire-format 例子做 `JSON.parse` round-trip 校验，防止"slice 6 那种自己读起来对、机器读起来错"的反复。

## 为什么必须先契约后 smoke

Phase 5c 实际过程是：写代码 → smoke → 发现 missing case → 写代码 → smoke → 重复。三天里 6 个 slice。每个 slice 都是"差一点"。

成本在于：每个 smoke 都要烧 GLM/Kimi/OpenAI 的 API 配额；每个失败都要回到代码、定位、补丁、再来；用户体感是"看起来快好了又不对"。

如果第一步是契约：

- "namespace" 这种 ToolSpec 变体一开始就会在契约里出现（因为 contract 列了 Codex tool enum 来源）。
- Widget JSON 例子一开始就会被 `JSON.parse` 测过。
- bridge prompt 一开始就被钉住必须是 canonical（不允许自由发挥）。

contract test 跑通才烧 smoke 配额，是 Phase 5d Phase 5 Playbook 的硬要求。

## ClaudeCode / Native / Codex 各自的角色

我现在脑子里清晰的分工：

- **ClaudeCode SDK Runtime** 是"参考实现"。它的 MCP 文件是权威 prompt + 权威 schema 来源。其它 Runtime 漂移就向它对齐。
- **Native Runtime (AI SDK)** 是"本地优化"。它继承 ClaudeCode 的契约语义，但用 AI SDK 的方式实现。短期允许有些 drift，长期收敛。
- **Codex Runtime** 是"新框架适配"。它带来 Codex 自家的能力（shell / namespace / image_gen 内建），同时通过 bridge 复用 CodePilot 自有能力。**关键是：CodePilot 能力的语义不允许在 Codex 路径下变弱**。

未来 Hermes / Gemini / OpenClaw 接入也按同样的分工：原生能力是它们自己的事，CodePilot 能力必须按契约接入。

## 反模式记录

Phase 5c 三天里出现过的反模式，契约 + 测试都要防：

1. **Speculation 当 source-of-truth**。Phase 5c slice 1 我把 `KNOWN_NON_FUNCTION_TYPES` 写成"看起来 OpenAI Responses 应该有的字段"，结果 Codex 真实发的 `namespace` 没在列表里。Slice 5 修：直接读 `资料/codex/codex-rs/tools/src/tool_spec.rs` 的 `#[serde(tag = "type")]` enum，列表就是 enum 字面值。新 Runtime 接入第一步必须 snapshot 协议来源。

2. **同一概念三份独立实现**。Widget prompt 在 widget-guidelines.ts、builtin-tools/widget-guidelines.ts、builtin-bridge.ts 都有；memory prompt 在 memory-search-mcp.ts 和 builtin-tools/memory-search.ts 都有；notify 同理。契约设一份权威，其它 re-export。

3. **机器读不通的人写示例**。Widget `show-widget` 例子 slice 6 写成 `\\\"`（视觉上像 JSON 内嵌双引号），但 `JSON.parse` 实际解开会断在 `\"`。Slice 7 修：HTML 属性优先用单引号，根本不需要在 JSON 内嵌双引号；如果非用双引号，必须**单**反斜杠（`\"`），不能两个（`\\\"`）。契约 `canonicalJson` 字段必须 round-trip 校验。

4. **错误静默掉**。Slice 6 之前，malformed `show-widget` fence 在前端被 parser 静默丢掉，用户看不到任何反馈，以为模型没生成。Slice 6 加 `malformed_widget` segment + UI 可见 notice。契约 `uiRenderPath` 必须明确异常路径。

5. **Live-smoke-driven patching**。本身就是反模式 —— 它把生产模型变成开发测试基础设施。Playbook 强制：契约 + 测试通过才烧 smoke 配额。

## 接入第四个 Runtime 时不该发生什么

下次接 Hermes / Gemini / OpenClaw 的人不应当：

- 在 chat composer 里硬编码新 Runtime 的特殊字段
- 在 `MessageItem.tsx` 里写"如果是 Hermes 就这样渲染"
- 直接在新 Runtime adapter 里 paraphrase Widget prompt（写"差不多的话"）
- 先开 picker 给用户用、出问题再补

应当：

- 在 `src/lib/harness/capability-contract.ts` 的每个 capability `exposure` map 加一个 `hermes` runtime key
- 实现 capability adapter（不复制 prompt，只决定怎么在 Hermes 协议下挂这个能力）
- 跑 `harness-capability-contract.test.ts` 直到全绿
- 跑 smoke matrix（图片 / Widget / memory / tasks 各一条）
- 全过才开 picker

如果 Hermes 不支持某个 capability（例如它的协议无法承载 MediaBlock），就在 contract `exposure` 里标 `unsupported` 加 reason。模型会被告知，不会幻觉出"试着 shell 调用 CodePilot HTTP API"这种 fallback。

## 未来方向

短期（slice 8）：

- 把 Native Runtime 的 memory / tasks / notify prompts 同样改成 re-export 权威，消灭剩余 drift。
- 把 image_generation 在 Native 路径下也产出真实 MediaBlock（不再依赖 MEDIA_RESULT_MARKER 文本协议）。
- 给 cli_tools 提取 `CLI_TOOLS_SYSTEM_PROMPT` export，契约的 `systemPromptFragment` 不再是空字符串。

中期（Phase 5d Phase 2+）：

- Context Compiler — 把"注入什么"从各 Runtime 实现里拆出来，让 prompt 拼装是一个跨 Runtime 的 pure function，输入是 (capability registry + session state + token budget)，输出是 (system prompt fragments + tool set + MCP server list)。
- Artifact Contract — 把 widget / media / markdown / html / diff / json / table / error 八种 in-chat block 的前后端协议都钉成契约。

长期（Phase 5d Phase 5）：

- 每个 Agent Runtime 都按 Playbook 接入。
- CodePilot 自身能力像 "OS" 一样保持稳定，Runtime 是可替换的执行后端。
- 用户不需要关心今天的工具运行在哪个 Runtime 上，只需要知道工具是不是可用。
