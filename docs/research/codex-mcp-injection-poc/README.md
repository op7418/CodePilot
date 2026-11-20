# Codex MCP 注入 — Phase 0 POC 记录

> 执行计划见 docs/exec-plans/completed/phase-8-codex-mcp-context-injection.md（已归档 2026-05-29）
> 状态：**Phase 0 核心问题已 live 验证通过**（真实 Codex `0.133.0-alpha.1` app-server，隔离 `CODEX_HOME`）。唯一未验证项 = 模型**自主**调用（auth-gated，需 OpenAI 登录）。

本目录是 Phase 8 Phase 0 的 POC 产物，刻意放在 `docs/research/`（不进 `src/`），以免触及 `codex-user-mcp-wiring.test.ts` 的文件清单与产品路径。

## 一句话结论

**Codex 原生 per-thread `config.mcp_servers` 注入是真实可行的**：在隔离环境下，Codex app-server 接受注入、即时启动了一个独立 stdio MCP fixture、并通过 `mcpServer/tool/call` 成功调用了它的工具（含错误路径与 elicitation 往返）；broken server 的启动失败被清晰暴露、且不阻塞 thread。只有「模型自己决定去调」这一步因未登录而 auth-gated。

---

## 快照固定

| 对象 | 版本 / 日期 | 来源 |
|------|------------|------|
| **live Codex 二进制** | `codex-cli 0.133.0-alpha.1`（app-server 上报 cliVersion `0.133.0`） | `/Applications/Codex.app/Contents/Resources/codex`（用户机器现有，未下载新二进制） |
| vendored Codex 源码 | 文件日期 2026-05-13；version 占位 `0.0.0-dev` | openai/codex 本地克隆（不入库） |
| `@modelcontextprotocol/sdk` | 1.29.0 | `package.json` |
| node | v22.22.0（`/opt/homebrew/Cellar/node@22/...`） | 运行环境 |

### schema 核对（live 二进制 vs vendored 快照）

用 `codex app-server generate-ts` 从活二进制导出协议比对：

- ✅ `thread/start` / `thread/resume` / `mcpServerStatus/list` / `mcpServer/tool/call` / `mcpServer/oauth/login` / `mcpServer/resource/read` 仍在 ClientRequest 联合中。
- ✅ live `ThreadStartParams` 与 vendored **逐字一致**（`config?: { [key in string]?: JsonValue } | null`）—— `config.mcp_servers` 注入点未变。
- ⚠️ 漂移（不影响本计划，但要记）：`mcpServer/reload` → `config/mcpServer/reload`；跑一轮提示用 `turn/start`（`{ threadId, input: UserInput[] }`）；新增 `getAuthStatus`（可不读 auth.json 查登录态）；多了 plugins/marketplace/skills/hooks/fs/command 等大量新方法。

> 结论：文档对 schema 的核心引用在 `0.133.0` 上依然成立；vendored 快照虽老，但 thread/MCP 关键面未变。

---

## 二、Live 验证结果（真实 Codex app-server）

驱动脚本 `drive-codex-appserver.mjs`：spawn `codex app-server --listen stdio://`（隔离 `CODEX_HOME=/tmp/codex-mcp-poc/home`，绝不指向真实 `~/.codex`），走 JSON-RPC 2.0 / newline-delimited。完整事件时间线见 `live-run-timeline.json`（35 事件）。

| 验证项 | 结果 | 证据 |
|--------|------|------|
| app-server 在隔离 home 启动 | ✅ | `initialize` 返回 `codexHome=/private/tmp/codex-mcp-poc/home` |
| 登录态（不读 auth.json） | 未登录 | `getAuthStatus` → `{ authMethod:null, authToken:null, requiresOpenaiAuth:true }` |
| `thread/start` 接受 `config.mcp_servers` 注入 | ✅ | thread 创建成功，`model=gpt-5.5`、`modelProvider=openai` |
| 注入 server **即时启动**（非惰性） | ✅ | 通知 `mcpServer/startupStatus/updated`：`starting` → `ready`（thread/start 后立即） |
| `mcpServer/tool/call` 路由到注入 server | ✅ **关键** | `memory_search(query="chinese")` → 返回 `mem-1`「User prefers replies in Chinese…」 |
| 工具错误路径 | ✅ | `fail_always` → `{ isError:true, "intentional fixture failure" }` |
| elicitation 完整往返 + 安全 decline | ✅ | `ask_user` → Codex 发 `mcpServer/elicitation/request`（server→client）→ driver decline → 工具返回 `action=decline`，无挂死 |
| elicitation 期间 thread 状态可见 | ✅ | `thread/status/changed`：`active[waitingOnApproval]` → `idle` |
| broken server 启动失败**被暴露、不静默** | ✅ | 通知 `startupStatus/updated`：`failed`，error `…handshaking with MCP server failed: connection closed: initialize response` |
| broken server 不阻塞 thread | ✅ | 带 broken server 的 `thread/start` 仍成功返回 |
| 模型**自主**调用 memory_search | ⛔ auth-gated | `turn/start` 触发模型 → server-stderr `401 Unauthorized wss://api.openai.com/v1/responses` |

### 关键事件样本（取自 `live-run-timeline.json`）

注入 server 生命周期（通知流）：

```
mcpServer/startupStatus/updated  {"name":"codepilot_memory_fixture","status":"starting","error":null}
mcpServer/startupStatus/updated  {"name":"codepilot_memory_fixture","status":"ready","error":null}
```

直接工具调用（无需模型）：

```
client→  mcpServer/tool/call {"threadId":"019e6850-…","server":"codepilot_memory_fixture","tool":"memory_search","arguments":{"query":"chinese"}}
server→  result {"content":[{"type":"text","text":"[{ \"id\":\"mem-1\", \"text\":\"User prefers replies in Chinese…\" }]"}]}
```

elicitation 往返：

```
server→REQ  mcpServer/elicitation/request {"serverName":"codepilot_memory_fixture","mode":"form","message":"…what is your name?","requestedSchema":{…}}
client→     {action:"decline",content:null,_meta:null}
server→NOTE serverRequest/resolved {"requestId":0}
```

broken server：

```
mcpServer/startupStatus/updated {"name":"codepilot_broken","status":"failed","error":"MCP client for `codepilot_broken` failed to start: MCP startup failed: handshaking with MCP server failed: connection closed: initialize response"}
```

---

## 三、两处需要纠正 Phase 8 文档的假设（live 发现）

1. **per-thread 注入 server 不进 `mcpServerStatus/list`**。文档 Phase 0 任务写「调 `mcpServerStatus/list` 断言 fixture 已启动且 tools 可见」——但实测该 RPC 对 per-thread 注入 server **始终返回 `data:[]`**（它只反映 config.toml 级 server）。per-thread server 的状态走 **`mcpServer/startupStatus/updated` 通知流**（starting/ready/failed）。
   → Phase 3「状态/事件桥接」必须**订阅该通知**，不能靠轮询 list；Phase 0 任务的断言方式要改。
2. **工具可调用 ≠ 模型自主调用**。`mcpServer/tool/call`（client 主动）无需 auth，已证明注入+wiring 通；但「模型自己决定调」要走 `turn/start` → 模型 → 需 OpenAI 登录。文档「优先验证 Codex 自主调用 Memory MCP」这一项**仍待 auth 后验证**。

---

## 四、Fixture（已交付）

`fixture-memory-mcp.mjs` — 独立 stdio MCP server（用 `@modelcontextprotocol/sdk` 的 `McpServer` + `StdioServerTransport`），即 Codex `config.mcp_servers.<name>={command,args}` 所需形态。**不是** `createSdkMcpServer()` 那种 in-process server（对照 `src/lib/memory-search-mcp.ts:13,43` 与 `src/__tests__/fixtures/fixture-mcp-server.ts:13,16`，二者都不能直接喂 Codex）。

工具：`memory_recent` / `memory_search` / `fail_always` / `ask_user`(elicitation)；`FIXTURE_MODE=broken` 模拟启动失败。

**node_modules 解析观察（已实证）**：Codex 以 `cwd=/tmp/.../ws` spawn fixture，但 fixture 的 `import '@modelcontextprotocol/sdk/...'` 按**文件自身位置**向上解析 node_modules（worktree 根），与 spawn cwd 无关——工具调用成功即证明。这印证 Phase 8 风险应对：wrapper 用绝对 entry 即可，不依赖 cwd。

## 五、Fixture 自测（Codex 无关，协议正确性）

`selftest-fixture.mjs` 用 MCP SDK 自带 stdio client 驱动 fixture，7/7 通过（initialize / tools-list / 带参调用 / 错误 / elicitation-decline / broken-startup）。运行：`node docs/research/codex-mcp-injection-poc/selftest-fixture.mjs`。

---

## 六、Phase 0 Smoke Ledger

| Date | 项 | transport | Result | Evidence |
|------|----|-----------|--------|----------|
| 2026-05-27 | fixture 协议自测 | stdio | ✅ 7/7 | 第五节 + `selftest-fixture.mjs` |
| 2026-05-27 | Codex `thread/start` 接受 `config.mcp_servers` 注入 | stdio | ✅ | live-run-timeline.json，thread/start result |
| 2026-05-27 | 注入 server 即时启动（startupStatus starting→ready） | stdio | ✅ | 通知样本（本文档第二节） |
| 2026-05-27 | `mcpServer/tool/call` 调 memory_search 命中 mem-1 | stdio | ✅ | timeline 行 15-16 |
| 2026-05-27 | 工具错误（fail_always → isError） | stdio | ✅ | timeline 行 17-18 |
| 2026-05-27 | elicitation 往返 + 安全 decline，不挂死 | stdio | ✅ | timeline 行 19-25（含 thread/status 切换） |
| 2026-05-27 | broken server 启动失败被暴露、不阻塞 | stdio | ✅ | 通知 `status:failed` + error 文本 |
| 2026-05-27 | 模型**自主**调用（turn/start） | stdio | ⛔ auth-gated | server-stderr `401 Unauthorized` |
| _待跑（需登录）_ | 登录后模型自主调 memory_search | stdio | 📋 | 需用户在临时 CODEX_HOME 授权登录 |
| _待跑_ | `thread/resume` 续聊带同份 MCP config | stdio | 📋 | 下一轮补（resume 路径） |

---

## 七、auth-gated 余项 + 复现

**唯一未验证**：模型自主调用 Memory MCP（`turn/start` 走模型）需 OpenAI 登录。按 Phase 0 边界，**未读取/复制 `~/.codex/auth.json`**，仅用 `getAuthStatus` 记录为未登录。要验证这一步，需用户明确授权在**临时 `CODEX_HOME`** 内登录（`codex login`），不污染真实配置。

复现（隔离）：

```
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex \
CODEX_HOME=/tmp/codex-mcp-poc/home \
node docs/research/codex-mcp-injection-poc/drive-codex-appserver.mjs
```

> 驱动脚本带安全闸：若 `CODEX_HOME` 指向真实 `~/.codex` 会直接拒绝运行。

---

## 八、Phase 1–3 transport 选型 + 集成 smoke（2026-05-27）

Phase 1 选型时验证了 **streamable-HTTP** transport（`poc-streamable-http.mjs`）：Codex 接受 `{ url }`（无 command）注入、startupStatus `starting→ready`、`mcpServer/tool/call` 命中 HTTP fixture。结论：Memory MCP 用 streamable-HTTP route（复用 Next server，dev/打包一致），优于 stdio wrapper（打包态难 spawn TS 子进程）。

`integration-phase-1-3.mjs` 是 Phase 1–3 端到端集成 smoke（无需模型 auth）：真实 Codex 0.133 → 注入 `config.mcp_servers.codepilot_memory = { url: <:3001 dev server route>, http_headers: { x-codepilot-workspace-path } }` → startupStatus ready → `mcpServer/tool/call codepilot_memory_recent` 返回真实记忆文本。

> **路由鉴权（P1 修复）**：Memory MCP route 现在对任意 workspace 返回 **403**，只服务 `getSetting('assistant_workspace_path')` realpath 等值的目录——防止本地任意进程把 header 指向任意路径读文件。实测 live route 对任意 temp 目录返回 `403 "Workspace not authorized for the Memory MCP"`。复现集成 smoke 需把 `WORKSPACE` 设为 dev server 实际配置的 assistant workspace。

| Date | 项 | transport | Result | Evidence |
|------|----|-----------|--------|----------|
| 2026-05-27 | Codex 接受 streamable-HTTP `{url}` 注入 + tool/call | streamable_http | ✅ | `poc-streamable-http.mjs` 输出 |
| 2026-05-27 | E2E：真实 Codex → live Memory MCP route → `codepilot_memory_recent` 返回真实记忆 | streamable_http | ✅ | `integration-phase-1-3.mjs`（startupStatus ready + tool 文本 MEMTEST_LIVE）|
| 2026-05-27 | 全量单测（含 5 个新 Codex MCP 测试文件） | — | ✅ 3009 pass | `npm run test` |

复现集成 smoke（需 :3001 dev server 在跑）：

```
TMPWS=$(mktemp -d); echo "# Long-term\nhello" > "$TMPWS/memory.md"
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex \
CODEX_HOME=/tmp/codex-mcp-poc/home \
MEMORY_URL=http://127.0.0.1:3001/api/codex/mcp/memory \
WORKSPACE="$TMPWS" \
node docs/research/codex-mcp-injection-poc/integration-phase-1-3.mjs
```
