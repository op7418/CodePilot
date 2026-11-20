# PermissionBoundary Guardrail

> **Status: Active** — 2026-07-20 因 Claude/Codex auto reviewer 接线与旧版本降级完成首次真实填充。
> **为什么先读**：`mutationLevel` + `PERMISSION_SAFE_TOOLS` 是 Phase 5e 修掉的安全洞（`codepilot_*` 权限前缀曾被默认放行）。改一处必须考虑**全部 Runtime**（claude_code / native / codex_proxy）的暴露一致性，否则会绕过权限框。

## 词汇表

- `mutationLevel` — 工具调用的"破坏性等级"分类，决定是否需要用户确认。
- `PERMISSION_SAFE_TOOLS` — 默认免确认的工具白名单。
- `unsupported` — 某 Runtime 不支持某能力的诚实降级标识。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|--------|--------|
| 1 | 任何新工具默认是受保护的（需要确认），明确加入 PERMISSION_SAFE_TOOLS 才放行 | `src/lib/permission/*` |
| 2 | mutationLevel 派生必须基于工具的实际行为（写文件 / 删数据 / 发网络请求），不能用 tool name 前缀猜测 | `src/lib/agent-sdk-capabilities.ts` |
| 3 | 跨 Runtime 暴露必须用 capability contract 表（live=zero unsupported exposures）；不能用 notes-based exceptions（`feedback_no_live_smoke_driven_patching.md`） | `harness-capability-contract.test.ts` |
| 4 | Runtime 的 reviewer 能力必须由该 Runtime 自己的事实源判定；Codex 不得受 Claude SDK 版本探测影响 | `src/lib/permission/profile.ts`、capability route |
| 5 | Codex `auto_review` 需同时通过保守版本门和 thread start/resume 回显；旧版、未知版本、缺少/不一致回显一律降级到 user reviewer，并发 canonical `unavailable` | `src/lib/codex/app-server-manager.ts`、`runtime.ts` |
| 6 | 权限 profile 是 CodePilot 会话事实源：Codex default 显式发送 on-request + user + workspace sandbox，不隐式继承用户全局 config；Plan/full access/auto 各自保持独立语义。read-only/workspace sandbox 的 `networkAccess` 必须为 true，保证父 Agent 与 child 的 Codex 原生 Shell/Fetch 能真实联网；文件写入与审批轴不因此放宽 | `src/lib/codex/permission.ts` |
| 7 | 子 Agent 继承父会话的有效工具与权限 profile；正常模式下写入/Shell 继续走同一审批，full access 只在父会话已明确选择时继承。换模型不能绕过父权限，但也不能被 CodePilot 额外硬裁成只读 | `src/lib/tools/agent.ts` + Runtime adapter |
| 8 | child permission DB row 仍挂真实 parent chat session 外键，但 SSE 必须携带 `agentRunId` / `childSessionId`；批准/拒绝继续以唯一 permissionRequestId 定向 | `agent-tools.ts` + `permission-registry.ts` |
| 9 | same-runtime delegation 只能从 `interactive_chat` 发起，child provider call 必须标 `delegated_interactive`；background / scheduled 不得借 interactive-only 套餐 | `provider-call-policy.ts` + `tools/agent.ts` |
| 10 | Claude Code 精确模型委派必须经 managed MCP 的 server-owned Provider+Model route，合法集合与 picker 未置灰状态同源；child subprocess 继承父 query 的 tools / MCP / permissionMode / canUseTool，并移除 Agent/Task 防递归。`required_capabilities` 只能由真实 Claude built-in surface 证明；“配置了任意 MCP”不等于 read/network/write，Memory MCP 尤其不能证明 live search。原生 Agent 的 prompt-level effective-model 冒充仍由 `PreToolUse` fail closed | `claude-subagent-mcp.ts` + `agent-sdk-agents.ts` + `claude-client.ts` |
| 11 | Codex managed child 的工具、MCP、sandbox、approval 与 elicitation 由 Codex app-server 负责；CodePilot 不按 network/write/shell 等类别再做 capability allowlist。dynamic MCP call 必须透传到 Codex MCP manager，只有递归 spawn 被硬移除。child 必须继承 canonical permission wire，不能把联网字段偷偷降回 false | `codex/subagent.ts` + `codex/dynamic-tool-bridge.ts` + `codex/proxy/builtin-bridge.ts` |
| 12 | Codex `item/permissions/requestApproval` 必须按 app-server 当前 schema 回 `{ permissions, scope }`，批准值只能是原请求的子集，拒绝返回空 permissions；不得复用 command approval 的 `{ decision }`。第三方 Provider 下的 Codex namespace/MCP 工具必须双向转换并恢复原始 `(namespace, name)`，不能只保存 descriptor 却不暴露给模型 | `codex/approval-bridge.ts` + `codex/event-mapper.ts` + `codex/proxy/namespace-tools.ts` |
| 13 | CodePilot Provider proxy 下的精确模型委派只能暴露 `codepilot_spawn_subagent`；Codex 原生 `multi_agent_v1` 会继承另一条 Provider/Model route，不能与 managed bridge 同时暴露。Codex Account 不经过 proxy，继续保留原生 collab | `codex/proxy/namespace-tools.ts` + `codex/proxy/builtin-bridge.ts` |
| 14 | Claude managed child 复用父 `canUseTool` 时必须额外携带唯一 `agentRunId`、实际 child session id 与 `agentName`；权限 UI 显示发起者，批准/拒绝仍由唯一 permissionRequestId 定向。**当前只有 Claude adapter** 能根据必填 `required_capabilities=write_workspace` 识别写任务并按真实 working-directory 串行；Native / Codex 没有等价声明与跨 Runtime 共享锁，不能把本条描述成三 Runtime 通用防护 | `claude-subagent-mcp.ts` + `claude-client.ts` + `PermissionPrompt.tsx` |
| 15 | 破坏性进程重启 recovery 只有在上一 runtime owner 已死亡时才能中止 pending permission / 清理 lock；Next route/module 重复初始化或用户切换聊天不能把仍存活的 child 审批改成 `Process restarted` | `src/lib/db.ts` runtime owner guard |
| 16 | 标为 `safe_read` / `PERMISSION_SAFE_TOOLS` 的工具不得把模型输入拼入 shell 字符串；调用外部只读程序必须使用固定 executable + argv 数组，`shell:false`，并以恶意分号、引号、命令替换反例证明没有副作用 | `src/lib/tools/grep.ts`、`src/lib/tools/glob.ts` |
| 17 | 本地 HTTP 路由只要能安装/卸载软件或启动进程，就必须在解析 body 前要求 loopback Host、同源 `Origin`、`application/json`，并对请求参数采用闭合语法；跨平台兼容不得把未验证参数重新送回 shell。Windows 的固定 `cmd.exe /d /s /c npx.cmd` bridge 会重新解析 argv，其安全性显式依赖当前 `SAFE_PATH_SEGMENT` 闭合语法；任何放宽都必须先补 Windows metachar 反例并重新审查该边界 | `src/lib/skills-marketplace-command.ts` + Skills Marketplace install/remove routes |
| 18 | Composer 的“只读规划”不是样式预设：canonical persistence 必须是 `mode=plan + permission_profile=default`，且 Plan resolver precedence 高于 full access / auto reviewer / global skip | `composer-access-level.ts` + 三 Runtime permission resolver |
| 19 | Composer 加载旧 `ask` row 时只显示保守 default + legacy marker，不自动写库；只有用户显式切档才 canonicalize。未知 mode/profile fail closed 到 default 并保留 breadcrumb | `composer-access-level.ts` + `ChatPermissionSelector.tsx` |
| 20 | UI 切换权限档位必须在一个请求中提交 mode/profile pair；session API 在任何写入前同时校验两个字段。不得用两个独立 PATCH 制造短暂的 `plan+full_access` 或 stale profile 组合 | `ChatPermissionSelector.tsx` + `api/chat/sessions/[id]/route.ts` |
| 21 | Browser 网页权限与 Agent/Runtime permission profile 完全分离。guest 的 permission check/request 当前默认全部拒绝；Composer 的 full access、auto review 或“请求批准”不得改变网页摄像头、定位、通知、剪贴板或下载策略 | Electron browser Session + BrowserPanel |

## 改动检查表

- [ ] 加新工具时确认默认是 unsafe，明确决定是否加入 PERMISSION_SAFE_TOOLS
- [ ] safe_read 工具若调用外部程序，只能固定 executable + argv + `shell:false`；用模型可控 metachar 输入跑副作用反例
- [ ] 新增本地安装/卸载/进程 route 时，先做 loopback Host、同源 JSON 门禁和闭合输入语法，再启动进程；Windows `.cmd` 兼容不得接受任意 shell token，放宽 `SAFE_PATH_SEGMENT` 前必须重跑 Windows metachar 反例
- [ ] 改 mutationLevel 分类时跑 harness-capability-contract.test.ts
- [ ] 新 Runtime 接入时填能力矩阵；不支持的能力标 `unsupported` 不能假装支持
- [ ] 改 reviewer capability 时覆盖 UI route 与运行时 shipping boundary；不得只在下拉框禁用
- [ ] 改 Codex thread/turn 权限字段时同时验证 start、resume、resume fallback 与每 turn 刷新
- [ ] 改 Codex sandbox 时用实际 app-server 生成 schema 核对字段；readOnly/workspaceWrite 的 `networkAccess:true` 必须在父 turn 与 managed child 一致
- [ ] 版本能力未知时 fail closed；禁止把当前开发机版本当作所有用户版本
- [ ] 子 Agent 工具必须来自父会话有效 surface；普通 profile 保留 permission wrapper，full access 必须有父会话显式事实；Agent/spawn 工具硬移除以保持 depth 1
- [ ] permission request 同时保留 parent DB session 与 child run attribution
- [ ] delegation scene 必须是 foreground interactive；父取消要向 child abort 传播
- [ ] Claude managed child 必须 exact 命中 server route，并使用 delegated_interactive + 独立凭据环境 + 父 tools/MCP/permission/canUseTool；原生 Agent 冒充门禁不要只依赖 `canUseTool`
- [ ] Claude capability preflight 必须覆盖 `codepilot-memory + 无 WebSearch/WebFetch` 反例；未知 MCP 可以继承，但不能凭 server 存在自动获得 read/network/write
- [ ] Claude child 权限 request / timeout resolved 都携带同一 run/session 归属，UI 显示 Agent 名；`write_workspace` 并发测试必须证明同目录串行
- [ ] Codex managed child 只做 exact Provider+Model 路由；native tools/MCP/sandbox/approval 交给 app-server，dynamic MCP namespace/tool 不得再做 CodePilot allowlist
- [ ] 改 Codex `item/permissions/requestApproval` 时用当前 app-server 生成 schema 核对 request/response；允许时只回显原请求的 permission subset，拒绝为空集
- [ ] 改 Codex proxy non-function tools 时覆盖 namespace definition → provider function alias → Codex `(namespace, name)` 回包的完整 round trip
- [ ] 改 Codex delegation 工具时覆盖 managed proxy 与 Codex Account 两条反例：proxy 不得暴露 `multi_agent_v1`，Codex Account 不得误删原生 collab
- [ ] 改 DB startup/recovery 时验证 live process 的 pending child permission 与 session lock 在重复模块初始化后仍存在；只有真正进程重启才批量中止
- [ ] 改 Composer 权限 UI 时跑四档 round-trip、plan precedence、legacy ask no-touch、unsupported reviewer degraded 与 invalid fail-closed；不得恢复独立 Mode selector
- [ ] 改 session PATCH 时证明 invalid mode/profile 在任何其它字段写入前返回 400；一个 UI 动作只能提交一组 canonical pair
- [ ] 改 Browser permission/download 时单独跑 guest permission matrix；不得读取或复用 Agent session 的 mode/profile/reviewer/sandbox 字段

## 常见坑

- `codepilot_*` 工具名前缀曾被当作"内部工具自动放行"——这是 Phase 5e 修的真实安全洞，不要再引入类似的"按 prefix 放行"逻辑。
- “只读工具”只是产品语义，不会自动让实现安全。Grep/Glob 曾把模型 pattern 拼入 `execSync`，因此能在免审批 surface 上执行任意命令；shell 字符串与 `safe_read` 分类绝不能共存。
- `spawn(command, args, { shell: true })` 不会因为参数放在数组里就安全，Node 仍会把它们交给 shell。Marketplace 这类进程 route 还必须防跨源 simple POST，不能只修引号转义。
- live smoke 前必须先过 contract test；不要用 live smoke 驱动逐个补丁（Phase 5b round 6 教训）。
- 不要用 Claude Agent SDK 的版本或 MCP 探测结果判断 Codex reviewer；两者没有依赖关系。
- 仅依赖“请求没有报错”不能证明 Codex 接受 reviewer 字段；旧 app-server 可能忽略未知字段，必须检查响应回显。
- 不要把 parent sessionId 当作 child 的唯一身份；多个并发 child 会导致 UI 串台或批准错 run。
- 不要把“存在任意 MCP server”当作三种 capability 全部成立。MCP 配置只证明 transport 配置，不能同步证明连接成功、工具清单或副作用；`codepilot-memory_search` 的“search”是本地记忆检索，不是 live network search。
- 不要把父 `canUseTool` 原函数裸传给独立 child subprocess；这样生成的权限事件只有父 session 身份，UI 无法告诉用户是哪个 child 在申请。
- 并发上限 2 不是写冲突防线；声明 `write_workspace` 的 managed Claude child 必须按 realpath 工作目录排队。Native / Codex child 以及跨 Runtime child 目前没有共享写锁，在 tech-debt #58 收口前不得宣称“所有写 child 已串行”。
- 不要把 `interactive_chat` 直接复用于 child provider call；必须用 `delegated_interactive` 让套餐政策可审计。
- 不要把 AgentDefinition.model 的 `string` 类型误读成“Claude Code 可路由任意 Provider 模型”：它仍复用父 subprocess endpoint。也不要反向误读成“Claude Code 只能跑 Anthropic 模型”；CodePilot managed child 可为 picker 未置灰的 Kimi/GLM/DeepSeek 等 Provider 创建独立 subprocess。
- 不要让父模型通过 `required_capabilities` 替 Codex Runtime 判定 child 的工具。Codex 的工具可用性、sandbox、审批与 elicitation 以 app-server 为准；CodePilot 只做 transport 与路由。
- 不要把“继承父 sandbox”写进工具说明，却在 canonical parent wire 里把 `networkAccess` 固定成 false。第三方 Provider 没有 hosted search 时，这会让所有 Codex 原生联网尝试必然失败。
- 不要把 `item/permissions/requestApproval` 当成普通 command approval 回 `{ decision }`。app-server 要求 `{ permissions, scope }`；错误 response shape 会让用户已经批准的网络/文件权限仍被 Codex 拒绝。
- 不要只在 parser 里“接受” namespace/tool_search 等 non-function descriptor 就宣称工具已接入。对第三方 Provider，namespace 的每个 MCP member 必须成为模型可调用的 function，并在回包时恢复 namespace，否则工具在请求里存在但模型永远不可用。
- 不要把所有 namespace 无差别展开。`multi_agent_v1` 与 `codepilot_spawn_subagent` 同时出现时，父模型会同时创建原生 inherited-model worker 和 exact-route managed child；每个 `spawn/wait` 控制动作还会产生额外胶囊，并可能把父模型 worker 冒充成用户指定模型。
- 不要把“某个 route 首次 import DB 模块”当成“应用刚重启”。活进程内执行 restart sweep 会静默拒绝 Sub-agent 正在等待的审批，并破坏 run/session owner。
- 不要把 Composer “完全访问”理解成网页 full access。Browser guest 是不受 Agent 授权继承的独立不可信 origin；网页权限必须按自己的 origin/session 产品合同开放。

## 测试覆盖

| 契约 | 测试文件 |
|------|----------|
| 跨 Runtime exposure | `harness-capability-contract.test.ts` |
| Runtime-specific auto reviewer gate | `permission-runtime-capability.test.ts` |
| Codex profile mapping、版本门、thread 回显与运行时消费 | `codex-permission-wire.test.ts`、`codex-binary-discovery.test.ts` |
| Codex child 原生工具/MCP 所有权与 bridge 抑制 | `codex-dynamic-tool-bridge.test.ts`、`codex-builtin-bridge.test.ts`、`codex-builtin-stream-suppression.test.ts` |
| Codex permissions response 与第三方 Provider namespace round trip | `codex-approval-bridge.test.ts`、`codex-event-mapper.test.ts`、`codex-proxy-namespace-tool.test.ts` |
| Codex proxy managed/native delegation 互斥 | `codex-proxy-namespace-tool.test.ts`、`codex-builtin-bridge.test.ts` |
| delegated scene、模型白名单、child attribution | `provider-call-policy.test.ts`、`subagent-orchestration.test.ts` |
| Claude Memory MCP capability 反例、permission attribution、同目录写串行 | `subagent-orchestration.test.ts` |
| live process 重复初始化不终止 pending child permission | `collect-owner-gate.test.ts` |
| Native Grep/Glob 模型输入不会产生 shell 副作用 | `native-search-tools-security.test.ts` |
| Skills Marketplace loopback + 同源 JSON、闭合输入和 shell-free argv | `skills-marketplace-security.test.ts` |
| Composer 四档映射、legacy ask 与 capability degraded | `composer-access-level.test.ts` |
| Browser 网页权限与 Agent 权限隔离、默认拒绝 source pin | `browser-surface-security.test.ts` + `electron-main-security.test.ts` |

## 设计决策日志

- 2026-05-18 — Phase 5e：`codepilot_*` 前缀洞改为 mutationLevel 派生；Native image/media 走 MediaBlock side-channel；live=zero unsupported exposures（详见 `completed/phase-5e-runtime-harness-architecture.md`）。
- 2026-07-20 — Codex auto reviewer 不再依赖 Claude SDK capability；最低已验证版本保守钉为 `0.145.0-alpha.18`，并以 thread start/resume 的 `approvalsReviewer` 回显作为最终事实源。
- 2026-07-20 — 接受 CodePilot profile 覆盖用户 Codex 全局默认的产品语义：会话选择必须可预测，default 显式使用 user reviewer + workspace sandbox；这可能比用户全局配置更保守，但不会静默放宽。
- 2026-08-25 — 独立 Code/Plan 控件从 Composer 移除，但 Plan 硬边界没有删除：它成为 Permission 菜单中的“只读规划”。四档 UI 只复用既有 mode/profile schema；旧 ask row no-touch，显式切档才 canonicalize。
- 2026-07-22 — same-runtime delegation 首版固定 foreground/read-only/depth 1/concurrency 2；权限行挂 parent DB session，但 transport 额外携带 agentRunId/childSessionId，避免并发归属歧义。
- 2026-07-22 — 用户真实复测证明 Claude Code 无法按 Agent override 路由 Grok；增加模型门禁、prompt-level 角色冒充检测、双语 warning 和父 Agent 恢复指引，禁止把失败/继承冒充 Grok 已执行。
- 2026-07-22 — 后续复测确认 AgentDefinition 不能切 Provider；精确模型委派改为 `codepilot_spawn_subagent` 独立 SDK child。最初按 safe_read 把 child 固定为只读，次日用户反馈证明这是过度限制，已由下一条决策取代。
- 2026-07-23 — 用户否决“CodePilot 额外固定只读”的产品限制。`codepilot_spawn_subagent` 仍可按 spawn 动作本身归为 safe_read，但 child 改为继承父工具与权限；所有写入/Shell 继续由父 profile 的审批/sandbox 决定，递归委派仍硬移除。
- 2026-08-26 — 内置 Browser guest 权限与 Agent 权限正式拆域：网页 permission check/request 默认拒绝，Composer 档位无论多宽都不能放宽网页权限；下载在独立产品 UI 完成前由 Main 阻断。
- 2026-07-23 — 用户进一步明确 Codex child 不应只有“联网工具特例”，而应完整保留 Codex 原生工具系统。删除 Codex `required_capabilities` gate 与 Memory-only dynamic MCP allowlist；所有 namespaced MCP call 经 Codex MCP manager 执行，sandbox/approval/elicitation 继续由 app-server 决定。CodePilot 唯一硬裁剪是 depth 1。
- 2026-07-23 — 真实会话 `1ff7d214c15e2ed2ba590b3183fe1293` 证明只做“继承”仍不够：canonical Codex wire 把 default/auto/plan 的 `networkAccess` 全固定为 false，Qwen 等无 hosted search 的第三方 Provider 因此只能得到必失败的 Shell 网络。以当前 app-server `0.145.0-alpha.27` 的生成 `SandboxPolicy`（字段为 boolean）为协议依据，将 readOnly/workspaceWrite 的网络改为 true；写入 sandbox、审批 reviewer 与 full-access 语义保持不变。
- 2026-07-23 — 真实会话 `7fc82cb65f2dbb40a10856feac84595e` 证明 `networkAccess:true` 仍不足：CodePilot 把 `item/permissions/requestApproval` 误回成 `{ decision }`，实际批准无法生效；同时第三方 Provider proxy 保存了 namespace descriptor 却未把嵌套 MCP member 暴露给模型。按当前 app-server 生成 schema 改为 permissions subset + scope，并补 namespace 双向 round trip。Shell/文件仍由 app-server 执行，不在 CodePilot 复制一套工具权限系统。
- 2026-07-23 — 会话 `0b385950a86ec7fbeff5bb44508ec76c` 暴露 namespace 全展开的冲突：proxied 父模型同时调用 managed bridge 与 `multi_agent_v1.spawn_agent/wait_agent`，三个原生 worker 继承父 route，却被正文冒充成 Qwen/DeepSeek/Kimi；UI 又把每个 collab 控制调用显示成 “Codex worker” 胶囊。proxy 现移除原生 collab namespace，并在 tool/system instruction 双重声明 managed entry point 唯一性；Codex Account native path 不变。
- 2026-07-23 — Claude review 发现 capability preflight 用 `hasMcp` 同时授予 read/network/write，导致常驻 `codepilot-memory` 让 live research 永远通过；同时 managed child 裸复用父 approval callback、两个写 child 可并发改同一工作树。修复为 built-in surface 逐能力证明、MCP 仅继承不作能力证明、权限事件增加 run/session/name 归属、`write_workspace` 按 realpath 串行。
- 2026-07-23 — 会话 `ba4855b4c4d272afc85f3a70bbb5b5f4` 的两个 child permission 在创建两秒后被写成 `Process restarted`，但 Electron/Next 主进程并未退出。原因是 route/module 重复 `initDb()` 执行了 restart sweep。现由数据库路径级进程 owner 隔离 schema init 与 recovery；live owner 下 permission/lock/checkpoint 保持不变。
- 2026-08-02 — Claude 收尾审查发现 Native `safe_read` Grep/Glob 用 `execSync` 拼接模型 pattern，可绕过 Bash 审批执行命令；Skills Marketplace install/remove 同时以 `shell:true` 消费本地 POST 参数。搜索工具改为固定 `rg`/`grep`/`find` argv，Marketplace 增加 loopback Host、同源 JSON + GitHub source/skill id 闭合语法，Unix 直启 `npx`、Windows 只用固定 `cmd.exe → npx.cmd` bridge，外层始终 `shell:false`；恶意 metachar 行为测试钉住零副作用。
