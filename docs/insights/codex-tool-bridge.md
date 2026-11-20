# CodePilot Tool Bridge — Why

## 问题信号

2026-05-16 真实 smoke：

- **Codex Account + GPT-Image-2.0**：原生路径稳定可用。
- **GLM-5 Turbo / Kimi（CodePilot provider）+ Codex Runtime + GPT-Image-2.0**：进入一条复杂的异常路径：
  1. 读 `imagegen` Skill 说明
  2. 猜应该调用 `image_gen`
  3. 发现内置 `image_gen` 不可用
  4. 尝试 CLI fallback
  5. 查 `OPENAI_API_KEY`
  6. 尝试读取 `~/.codex/auth.json`
  7. 尝试 `npm install openai`
  8. generation stopped

这不是 GPT-Image 单点。同一轮里 `codepilot_memory_recent` / `codepilot_list_tasks` 也没有被调用——模型只能用 Codex 自带的 Bash / file 工具假装回答。

## 用户底线

- 每个 Agent 框架可以保留自己的特色能力。
- **CodePilot 自有的核心能力不能因为换 Runtime 就消失。** Widget、助理 Memory、定时任务、图片 / 媒体、Dashboard、CLI tools——这些是 CodePilot 产品层，不是某个 Runtime 的 plugin。
- 模型不能"为了让自己能干活"自己拼凑 fallback：碰 `auth.json`、装 `openai` 包、跑 `scripts/image_gen.py`、找 `OPENAI_API_KEY`。这些都不是 CodePilot 真实路径。

## 关键判断

### 桥的位置

三种位置都被考虑过：

1. **Codex CLI 反调 CodePilot HTTP API**：模型生成 Bash 命令调内部端点。被否：绕开 schema、permission、origin session、media serve、delivery log 等所有产品约束。
2. **让 Codex 把 function_call 转发回 CodexRuntime，由 CodePilot 端执行后 turn 续接**：Codex 协议没有 server-side execute 槽，要新增 `turn/continue` 中转加状态同步，工程成本远超本期。
3. **proxy 内执行 + 侧通道 SSE**（采用）：ai-sdk v6 `streamText({ stopWhen })` 天然支持 server-side tool execute + 多步续聊；Codex 看不到 function_call，但 CodePilot UI 通过 sessionId 侧通道直收事件。

### 桥的颗粒度

不另写一套工具实现。**直接复用 `generateSingleImage` / `importFileToLibrary` / `searchWorkspace` / `getGuidelines` / `sendNotification` / `/api/tasks/*`**。MCP / `builtin-tools/` / Codex 桥共享同一个底层 handler。桥只负责：（1）AI SDK 形状的 schema 包装；（2）`tool_started` / `tool_completed` 事件 emit；（3）MediaBlock 构造；（4）失败路径的结构化文案。

### 不做的事

- 不重新写工具描述清单——`BUILTIN_MCP_CATALOG` 是单一来源。
- 不为 Codex 原生 shell / apply_patch 在 proxy 路径上做反向桥——需要时单独立项。
- 不静默丢弃未识别的 Codex tool type——`parse-request.ts` 现在返回结构化 `unsupported_tool_kind` 让用户能看见。
- 不把 memory / dashboard 大段内容塞进 system prompt——继续走工具按需调用，避免上下文污染。

## 为什么这个改动属于产品层而不是 plugin

CodePilot 的产品定位是"多模型 Agent 桌面客户端"。一个用户买 Kimi 套餐 + 用 Codex Runtime 套着用，期望是"我习惯的 CodePilot 能力都在"。如果换 Runtime 就丢一半工具，等于告诉用户"换框架=换产品"。这违反多模型多 Runtime 的基本承诺。

Phase 5c 的修复**不是给 Codex 加 plugin**，是把 CodePilot 自己已经存在的能力，桥到 Codex Runtime 的执行管线里。从用户视角看：一个产品；从工程视角看：多了一条 adapter 而非多了一个新功能。

## 反模式与教训

模型在缺少明确工具时的"recovery 创造力"非常危险——它不会停下来报错，会按训练数据里见过的 OpenAI 接入指南拼凑 fallback。`auth.json` / `npm install openai` / `OPENAI_API_KEY` 这些都不是从 CodePilot 代码里来的，是模型自创的。

**对策**：
1. 工具必须真实可调用，而不是只在 prompt 里"提及"。
2. 工具失败时返回**结构化、具体**的错误（"Image generation succeeded but no image was returned"），而不是泛泛的"tool failed"——前者抑制模型继续猜下一步。
3. CI 用 source-grep 把这四条 anti-pattern 关键词锁死在禁用列表，再出现就红。

## 未来方向

- **能力族健康卡**：Settings → Runtime 里给 Codex 卡加一个"CodePilot tool bridge"健康状态，把当前哪些工具挂载、哪些跳过、为什么跳过暴露出来（pre-Phase-5c smoke 失败之所以难诊断，部分原因是工具桥状态对用户不可见）。
- **Codex 原生工具反向接入**：当用户在 Codex Runtime 下选 CodePilot provider 时，让 Codex 自己的 `apply_patch` / `shell` 也能跑——需要 proxy 把这些 function_call 委托给 CodePilot 的 Native Runtime tool 实现。本期不做。
- **Bridge as template for future Runtimes**：Gemini / OpenClaw / Hermes 等接入时复用同一套契约——`ProviderProxyBridge`（八个 hook） + `CodePilotToolBridge`（工具挂载） + 侧通道事件总线（UI 可见性）。Phase 5c 是这套模式的第一个落地参考。
- **Dashboard / CLI tools 工具族**：写类工具需要走 permission 协议。本期 deferred，下一轮专门设计 Codex Runtime 下的 permission round-trip。
