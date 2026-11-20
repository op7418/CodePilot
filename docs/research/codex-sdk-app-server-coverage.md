# Codex 集成路径调研：app-server vs `@openai/codex-sdk`

> 调研型文档。本文不主张迁移；只输出对照结论，给 Phase 5e 收尾确定 Settings 该如何诚实标注 Codex 一侧的能力边界。

**日期**：2026-05-18 · **作者**：Claude Code（产品重构 Worktree）
**触发问题**：Phase 5e Round 8 收尾 — 用户提出 P4 要求 "形成明确结论：哪些 Codex 原生能力可以通过 app-server 当前路径拿到；哪些必须改用 / 补充 `@openai/codex-sdk` 才能稳定拿到；plugins / skills / namespace tools 的事件形态是否能完整映射到 CodePilot UI；如果不能，Settings 里必须诚实标注。"

> **2026-05-21 补充**：本文原结论主要讨论 Codex 原生 plugins / skills 与 CodePilot provider proxy bridge，不等同于“Codex Account 无法注入 CodePilot MCP”。后续调研确认 Codex app-server `thread/start` / `thread/resume` 支持 per-thread `config.mcp_servers` override；因此 CodePilot Memory MCP 在 Codex Runtime 下的正确下一步不是迁移到 `@openai/codex-sdk`，而是新开 Phase 8 Codex MCP / Memory 注入（已归档 2026-05-29）：先 POC `config.mcp_servers`，再补 Memory MCP wrapper、start/resume 注入、status / elicitation bridge 与 Settings capability 翻转。

---

## 1. 当前 app-server 路径已经覆盖什么（事实速览）

下表都是 grep + 读 `src/lib/codex/**` 的硬事实，不是推断。`path:line` 可直接跳转。

| 维度 | 实现位置 | 状态 |
|------|----------|------|
| 进程启动 | `app-server-manager.ts:166` 用 `codex app-server --listen stdio://` 拉起子进程，stdio JSON-RPC 2.0 | 已实现 |
| 客户端握手 | `app-server-client.ts:131-155` initialize，发送 `CODEX_CLIENT_NAME='codex_codepilot'` (`types.ts:208`) + 本机 CodePilot version | 已实现 |
| 通知映射 | `event-mapper.ts:60-134` 共 40+ 已知方法（`item/agentMessage/delta`、`item/started`、`item/completed`、`turn/completed`、`error`、`fs/changed`、`thread/tokenUsage/updated`、approval ...） | 已实现 |
| 通配兜底 | `app-server-client.ts:252` 所有 notification 走 `translateCodexNotification` 转 RuntimeRunEvent，再 emit SSE | 已实现 |
| 版本检测 | **无 runtime 版本闸**。`app-server-manager.ts:256` 只读 CodePilot 自己的 package.json 版本号发给 Codex 作为合规日志标识；`CodexInitializeResponse.userAgent` 缓存但不据此 gating | 缺失 |
| Codex 原生 skills/plugins | `skills/changed` 通知在 `event-mapper.ts:125` 是"已知方法"，但 line 314 显式 `return null` — **transport 层接收但 UI 完全收不到** | **缺失** |
| MCP 工具 | `event-mapper.ts:406-414` `mcpToolCall` → `tool_started/tool_completed`；指 Codex 端配置的 MCP 服务（不是 CodePilot 这一侧的） | 已实现 |
| Namespace tools | `event-mapper.ts:467-471` `dynamicToolCall` → `tool_started/tool_completed` | 已实现 |
| 图片下行 | `event-mapper.ts:804-834` 从 `imageGeneration.savedPath/result` + `imageView.path` 合成 MediaBlock；`media-import.ts` 把外部路径搬到 `~/.codepilot/.codepilot-media/` | 已实现 |
| 图片上行 | `proxy/translate-input.ts:208` `input_image` 块作为 ai-sdk `ImagePart` 走 proxy | 已实现 |
| Thread resume | `runtime.ts:383-400` 命中 session-store + provider binding 匹配走 `thread/resume`，否则 `thread/start` | 已实现 |
| Resume binding 不匹配 | `runtime.ts:401-417` 清理旧 thread + 起新 thread | 已实现 |
| env / config override | `provider-proxy.ts:107-127` `buildCodexThreadParams` 返回 `{ cwd, modelProvider, config, model }`，start 和 resume 都注入 | 已实现 |
| Proxy 注入 | `provider-proxy.ts:73-105` `config.model_providers.codepilot_proxy` + 三个 header（`x-codepilot-target-provider/session-id/workspace-path`） | 已实现 |
| Codex Account 分支 | `provider-proxy.ts:129` 不注入 proxy，用 Codex 原生 OAuth 账号模型直连 | 已实现 |
| 上游 provider proxy | `unified-adapter.ts` 把 Responses 输入输出 ↔ ai-sdk 互转，覆盖所有已配置的 CodePilot providers | 已实现 |

---

## 2. `@openai/codex-sdk` 能提供什么（外部事实）

> **外部事实层**：本节内容来自外部 npm 包描述 + 项目无人引用，未在本仓库代码中 grep 验证（仓库未安装该包；`package.json` 无相关 dep）。来源是 `@openai/codex-sdk` 的对外文档 + Codex CLI 仓库 README。读时按"外部口径"对待，迁移前需要单跑 POC 校对。

SDK 高层 API（按文档说明）：

- **`runStreamed(prompt, opts)`** — 高层流式 API。封装 spawn + stdio JSON-RPC + 事件回调，开发者写回调而不是自己解 newline-delimited JSON。
- **Thread / resume** — 支持把上一次 thread id 传进来续 turn；和当前 `thread/resume` 语义一致。
- **Images** — `runStreamed` 入参支持 `images`，SDK 内部把本地路径或 buffer 转成 Codex 能接的输入。
- **Env / config override** — `opts.env`、`opts.config` 直接透传给底层 codex 子进程。
- **Plugin / skill 事件** — SDK 把 `skills/changed`、`plugins/changed`、namespace tool 列表都暴露为回调 / 事件流（这一点是本调研最关心的）。
- **版本探测** — 文档措辞暗示 SDK 启动时会做一次 Codex CLI 版本/能力探测；**具体形态（是否内嵌已知最低版本清单、是抛 typed error 还是仅返回降级 capability）需要 POC 确认**，未在仓库代码中或 SDK 源码中实测过。

---

## 3. 对比分析：哪些能力 SDK 能补、哪些 SDK 也补不了

| 能力 | 当前 app-server 路径 | `@openai/codex-sdk` 是否补足 | 结论 |
|------|---------------------|---------------------------|------|
| 模型流式回复（text/delta） | ✅ 已实现 | ✅ 一样 | **持平**。当前 `event-mapper.ts:170` `agentMessage/delta` 已 emit；不必迁。 |
| Thread resume | ✅ 已实现 | ✅ 一样 | **持平**。`runtime.ts:383-400` 已实现，未来若 SDK 提供更强的 binding hint，再评估。 |
| 上行 / 下行图片 | ✅ 已实现 | ✅ 一样（SDK 包了路径→buffer 转换） | **持平**。`proxy/translate-input.ts:208` 已覆盖；当前 `media-import.ts` 搬运也已落地。 |
| Env / config override | ✅ 已实现 | ✅ 一样 | **持平**。`provider-proxy.ts:107-127` 已用，且我们额外有 proxy 注入逻辑 SDK 默认不会做。 |
| Codex CLI 版本检测 | ❌ 缺失 | ⚠️ 文档暗示 SDK 启动会做版本探测，**具体形态需 POC 确认**（未实测） | **即便 SDK 能补，CodePilot 这一侧也可以 1 行加 spawn 时的 `codex --version` parse → typed error，不必引整个 SDK。优先级低。** |
| Codex 端 MCP / namespace tools | ✅ 已实现 | ✅ 一样 | **持平**。`event-mapper.ts:406-471` 已映射成 tool_started/completed。 |
| **Codex 原生 plugins / skills（`skills/changed`、`plugins/changed`）** | ❌ **transport 层收到但 UI 永远收不到**（`event-mapper.ts:314` 显式 return null） | ✅ SDK 暴露独立事件流 | **唯一 SDK 真能加分的维度**。即便如此，光"收到事件"不等于"能在 CodePilot UI 渲染"——我们这一侧没有 plugin / skill 的事件类型 + 渲染分支。 |
| Approval round-trip | ✅ 已实现 | ✅ 一样 | **持平**。`event-mapper.ts:60-134` approval 方法已映射。 |
| fs/changed、token usage updated | ✅ 已实现 | ✅ 一样 | **持平**。 |

---

## 4. 结论

### 4.1 「Codex 原生 plugin / skills 在 CodePilot UI 渲染」是个**双层缺口**，不是 SDK 单独能填的

| 层 | 现状 | SDK 能填？ | CodePilot 还需做什么 |
|----|------|-----------|---------------------|
| Transport 层接收 plugins/skills 事件 | 已接收（`skills/changed` 是已知 method） | 持平 | 无 |
| 事件 → RuntimeRunEvent 映射 | 显式 return null | SDK 提供原始事件 | 需要在 `event-mapper.ts` 新增 `plugin_*` / `skill_*` event type + 翻译 |
| UI 渲染 | 无 plugin / skill UI 分支 | SDK 不管 UI | 需要在聊天侧/Settings 侧加渲染分支 |

**也就是说：即使引入 SDK，Codex 原生 plugins / skills 也不会自动在 CodePilot 里"长出来"。**真正缺的是 CodePilot 这一侧的事件映射 + UI 渲染（两件事都不在 SDK 范围）。

### 4.2 这一轮的 Settings 标注口径（直接落到 user-facing copy）

`docs/exec-plans/completed/phase-5e-runtime-harness-architecture.md` round 8 已经实施并归档的口径，与本调研结论一致——下面是与本调研对齐的部分原文：

- **CodePilot Harness 内置能力**（widget / memory / tasks / image / media / dashboard / cli_tools / assistant_buddy）— 走的是 CodePilot 自己的 Native 工具桥 / MCP Server / 用户 provider proxy，**与 Codex 原生 plugins/skills 是两套独立系统**。
- **Codex Account** 路径：`codex_account` 不注入 CodePilot proxy（`provider-proxy.ts:129`），所以 CodePilot 这一侧的 Harness 不会被注入；Codex 自己的 plugins / skills 由 Codex 自己管。Settings 已经通过 `CODEX_ACCOUNT_HEADER_NOTE` 双语显式说明，**不假装 CodePilot 能调用 Codex 这一侧**。
- **Codex Runtime + CodePilot provider proxy**（非 codex_account）：CodePilot 内置工具中已经桥接到 Codex 的（widget / memory / tasks_and_notify / image_generation / media_import）显示为可调用；尚未桥接的（dashboard / cli_tools / assistant_buddy）显示为 perception_only 并明确告诉用户切到 Claude Code 或 CodePilot。
- **Codex 端的 plugins / Skills**：本仓库 UI 暂不渲染（`event-mapper.ts:314` return null）。Settings 文案不声称 CodePilot 这一侧能用到这些；Codex Account 下的"插件 / Skills 由 Codex 自己管理"已是诚实兜底。

### 4.3 是否要引入 `@openai/codex-sdk`？这一轮的判断

**这一轮：不引入。**理由：

1. SDK 真正能补的唯一维度是「Codex 原生 plugins / skills 的事件流」，但 CodePilot UI 这一侧并没有对应的渲染分支，光收到事件没有产品价值。
2. 当前 app-server 路径的稳定性（事件类型 40+、resume、proxy 注入、Codex Account 分流、图像双向、approval）经过 Round 1-7 多轮 review，已经 ship。换 SDK 等于把"已稳定"换成"未验证"。
3. 即便 SDK 真的包了 `codex --version` minimum gating（**待 POC 确认**），CodePilot 这边也可以 1 行加（spawn 前先 `--version`，不达标 typed error），不必为这一项引整个 SDK。
4. 如果**未来**要做"在 CodePilot 里展示 Codex 原生 plugin / skill 列表 + 调用 / 状态"这件事，那时候 SDK 加上 CodePilot UI 这一层渲染分支才是有意义的组合。

### 4.4 立即可做的小补丁（本调研不要求落地，列出来给后续 slice 参考）

- 在 `app-server-manager.ts:166` spawn 前 `codex --version` 跑一次，解析失败 / 低于已知 minimum 版本时抛 typed error（Settings 已经有 `codexAvailability.kind` 状态机，错误归到 `too_old`）。**理由**：当前用户安装了过旧 Codex CLI 时，CodePilot 会在 spawn 后超时或 JSON-RPC 解析失败，错误回流不够明确。
- 在 `event-mapper.ts:125` `skills/changed` 旁边新增 TODO 注释指向本调研，说明"如果未来要渲染 Codex 原生 skills，要在这里补 event type + 在 UI 端加分支"。

---

## 5. 反向链接

- 技术实现：`docs/handover/codex-runtime.md`（如存在）
- 归档执行计划：`docs/exec-plans/completed/phase-5e-runtime-harness-architecture.md`（Round 8 已采纳本调研的 Settings 诚实标注结论）
- 相关用户层 copy：`src/lib/harness/capability-display-text.ts` `CODEX_ACCOUNT_HEADER_NOTE` + `USER_EXTENSIONS_SUMMARY.codex_runtime`
