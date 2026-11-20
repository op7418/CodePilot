# Browser Surface MVP：安全内置浏览器与 Workspace 隔离

> 创建时间：2026-08-25
> 最后更新：2026-08-26
> 状态：🟡 **Code complete / macOS dev smoke passed**；packaged、Windows/Linux、下载与 tab 恢复仍待执行
> 风险等级：Tier 2（Electron Main / 远端内容 / 权限 / IPC / 下载 / 持久化 session）
> 事实基线：[T3 Code 模型输入区、统一侧边栏与内置浏览器专项调研](../../research/t3code-composer-sidebar-browser-ux-2026-08-25.md)
> 上游依赖：[Workspace Surface Sidebar](workspace-surface-sidebar-pin-and-inspector.md) Phase 1；Browser WebContentsView POC 保留为被路线取代的研究证据

## 用户问题与争议

用户希望把浏览器作为 Files、Git 等项目模块的一等 Surface，避免在 CodePilot 外部来回切换，并可直接查看本地应用或 URL。T3 的完整浏览器证明了产品价值，但它使用 `<webview>`、persistent partition、CDP 和自动化 runtime；这些实现不能原样搬入 CodePilot。

CodePilot 的主窗口有 transparent/vibrancy、Renderer overlay、三 Runtime 权限边界和 workspace/thread 两级状态。如果把远端网页当普通 React DOM，或给 Renderer 通用 `webContents`/CDP 能力，会同时放大凭据隔离、导航、下载和权限风险。

原计划优先采用 Main-owned `WebContentsView`，但隔离 POC 被当前 macOS Electron ready/safeStorage 环境卡在 view 创建前，既没有证明该路线可用，也没有证明它不可用。2026-08-26 用户明确要求实现而不是继续等待；路线因此显式改为 T3 已生产使用的 Renderer-owned `<webview>`，同时把 partition 签发、guest hardening、URL/permission/download policy 留在 Main。Renderer preload 只得到固定 config 与低权限事件，不得到 Main `WebContents`、Session 或 CDP bridge；但 DOM `<webview>` 本身仍是 host Renderer 的控制面，因此本轮安全边界是“恶意 guest 不能进入 host”，不是“host Renderer compromise 后仍保护 Browser 数据”。后者需要 Main-owned view 路线，不能由类型隐藏冒充解决。

## 状态

| Phase | 内容 | 状态 | 用户能看到什么 |
|-------|------|------|----------------|
| Phase 0 | 路线裁决与安全合同 | ✅ 完成 | 显式记录 `<webview>` 取代 `WebContentsView`，不伪造 POC GO |
| Phase 1 | Main/Preload guest 安全桥 | ✅ Code complete | workspace partition、attach gate、默认拒绝权限和窄 IPC 已接通 |
| Phase 2 | Browser surface、地址栏与 Sidebar 接入 | ✅ macOS dev smoke | 一个 Sidebar tab 对应一个页面；加载条、地址栏、前进后退、刷新与系统浏览器入口可用 |
| Phase 3 | Tabs、session、workspace partition 与状态恢复 | 🟡 部分完成 | 顶层多 Browser tab 与 persistent partition 已完成；页面 tab 列表跨重启恢复未做 |
| Phase 4 | 导航、权限、下载、localhost 与故障恢复 | 🟡 部分完成 | HTTPS/loopback、阻断态与 crash 恢复 UI 已完成；下载明确阻断 |
| Phase 5 | Tier 2 回归、packaged smoke 与文档收口 | 🟡 进行中 | typecheck、Browser contracts、web E2E 与 macOS dev smoke 已通过；packaged 与 Windows/Linux 未执行 |

## 决策日志

- 2026-08-25：MVP 不与 POC 并行；只有 POC decision log 为 `GO`、P1/P2 清零且用户接受剩余限制，Phase 0 才能改为待开始。
- 2026-08-25：使用 Main-owned `WebContentsView`；不启用 `<webviewTag>`，不使用已废弃 `BrowserView`。
- 2026-08-25：Browser 作为 `SurfaceRegistry` 中的一等 surface 接入 Primary + Inspector，不新增第二套侧边栏。
- 2026-08-25：workspace identity 只消费 Sidebar 输出的 versioned opaque `canonicalWorkspaceKey`，不得在 Browser 内复制 Git/path 探测。
- 2026-08-25：首版 `browserProfileId = default`，partition 为 `persist:codepilot-browser-<hash(canonicalWorkspaceKey + browserProfileId)>`；多 profile 以后另立计划。
- 2026-08-25：Agent automation、annotation、recording、React grab、通用 CDP/`executeJavaScript` 均不属于 MVP。
- 2026-08-25：native overlay coordinator、IME、bounds、zoom、crash 和音频策略是发布门禁，不是上线后 polish。
- 2026-08-25：上游 POC 首轮 `SIGTRAP` 证据因非 canonical reload 序列失效；修订 harness 又停在 `app.whenReady()` 前，当前为 `BLOCKED / INCONCLUSIVE`，没有形成启动所需的 `GO`。本计划未启动、未新增 Main/Renderer browser 产品代码；统一 Sidebar 中的 Browser 入口继续显示禁用说明。证据见 [POC README](../../research/browser-webcontentsview-poc/README.md)。
- 2026-08-26：用户明确要求停止等待并实现 Browser；该指令取代“不得偷偷切换”的旧前置，但不把 WebContentsView POC 改写成 GO。MVP 显式采用 hardened `<webview>`：主窗 `sandbox/contextIsolation`、`webviewTag:true`，Main 签发 workspace partition 并在 `will-attach-webview` 二次强制 guest flags；无 preload、无 Node、无 CDP。
- 2026-08-26：当前交付是可浏览 MVP，不冒充完整发布态。Tabs 仅当前挂载期存在；下载默认阻断；网页权限默认全部拒绝；Windows/Linux、packaged、IME/overlay/zoom/certificate/download 均保留为未执行门禁。`<webview>` 解决 guest→host 隔离，但不提供 host Renderer compromise 后的 Browser-data 隔离；该残余风险保留为未来 Main-owned view 路线的安全理由。
- 2026-08-26：用户明确要求一个 Workspace Sidebar tab 就是一个浏览器页面；BrowserPanel 的内层 tab bar 被删除，“+”重复选择 Browser 时创建同层页面 tab。Sidebar 内 shell-level X 同时删除，整个右栏只由页面右上角既有 toggle 收起。加载条由 navigation request / `did-start-loading` 与 stop/fail/block 终态驱动，只表达“正在加载”，不伪造资源百分比。
- 2026-08-26：单独打开 Artifact/网页预览时，Inspector 必须使用 `standalone` 布局，不渲染仅用于 Primary + Inspector 并排态的分隔线或窄屏“返回 Primary”行。复审发现 `right-rail-mutex.test.ts` 仍只接受 `peek | split` 两态；已把契约更新为 `standalone | peek | split`，并新增“standalone 不回退到 Git Primary”的源码合同与真实页面 E2E，随后对最终代码重新跑全量测试。
- 2026-08-26：Preview 与看板/Files/Git 已是顶部同级 Tab；即使 Primary 同时存在，窄宽度 Inspector 也不再渲染“← 看板/Git/Files”来源栏。内容区直接从 Preview 工具栏开始，返回 Primary 统一使用顶部 Tab。

## 硬前置与退出条件

原 WebContentsView 硬前置已由 2026-08-26 用户路线裁决替代。当前发布退出条件仍必须满足：

- Sidebar Phase 1 已实现并测试 `canonicalWorkspaceKey`，同一 repository 的 worktrees 共享、独立 clone 不共享；旧项目迁移可观察且 fail closed。
- hardened `<webview>` threat model、attach gate、partition、导航、权限与下载默认拒绝没有未关闭 P1/P2。
- overlay、DPI、IME、快捷键、zoom、crash 与 guest security 在目标平台有真实证据。
- 当前 Electron 版本和 packaged 环境行为已锁定，禁止用 dev-only 成功代替正式包证据。

不得再把旧 WebContentsView POC 的 `BLOCKED / INCONCLUSIVE` 写成当前 MVP 的 GO；路线变化只能以本决策日志和用户指令解释。

## 状态所有权

| 状态 | 作用域 | Owner | 持久化 |
|------|--------|-------|--------|
| Browser 是否被 pin | canonical workspace | Sidebar plan / workspace surface preference | 是 |
| Inspector 宽度与展开 | canonical workspace | Sidebar layout | 是 |
| 当前 surface | thread | Workspace Sidebar state | 是 |
| Browser tab 身份与 active tab | Workspace Sidebar dynamic state | 当前仅 renderer 内存；Pin/线程恢复只生成一个空白 Browser tab |
| 单页 URL/history/title/loading | 对应 `BrowserPanel` / guest | 当前仅挂载期内存；关闭 tab/重启后不恢复 |
| Cookie/localStorage/cache | canonical workspace + browser profile | Electron `session.fromPartition` | persistent partition |
| 临时焦点、loading、crash generation | window/runtime | `BrowserPanel` / guest | 否 |

禁止把完整浏览历史、网页表单内容、cookie 或下载 token 写进普通 workspace JSON、日志、Sentry breadcrumb 或 Renderer store。

## Phase 0：消费 POC 决议并冻结合同

### 用户结果 / 验收入口 / 明确不做

- 用户结果：暂无 UI 变化；实施者能从一份冻结合同判断哪些能力可交付、哪些限制必须显示给用户。
- 验收入口：本计划的 POC decision 链接、风险矩阵、MVP scope 和测试映射。
- 明确不做：不创建产品 Browser 入口，不先写“以后再补”的安全空壳，不把 `CONDITIONAL GO` 静默改成 `GO`。

### 执行清单

- [ ] 引用 POC 最终 commit、OS/Electron 矩阵、Smoke Ledger 和 decision log；逐条搬入限制与 workaround。
- [ ] 冻结 Browser tab/surface state schema、Main/Renderer IPC schema、partition contract 与清理语义。
- [ ] 为 POC 中每个 P1/P2 建立“修复 commit + test + evidence”映射；缺一项即阻塞。
- [ ] 明确 overlay coordinator 最终策略、快捷键仲裁、guest zoom、音频隐藏与 crash budget。
- [ ] Threat model 覆盖恶意页面、恶意 URL、compromised guest、错误 sender/view id、跨 workspace 数据读取和下载路径。
- [ ] 记录不做项：多 profile、书签同步、账号同步、扩展、DevTools 产品入口、网页 Agent 自动化。

## Phase 1：Hardened `<webview>` 与窄 Main/Preload bridge

### 用户结果 / 验收入口 / 明确不做

- 用户结果：还没有正式 Browser UI；内部可以按 window/workspace/thread scope 安全管理 view 生命周期。
- 验收入口：固定 fixture 的 integration tests，覆盖 create/attach/setBounds/show/hide/destroy 与 window teardown。
- 明确不做：Renderer 不获得 `WebContents`、Electron `Session` 或任意代码执行能力；不开放通用 CDP。

### Main 合同

- Workspace Sidebar 拥有 Browser tab 身份，单个 `BrowserPanel` 只拥有对应 guest 生命周期；卸载 `<webview>` 即销毁 guest，不存在 Renderer 可持有的 Main handle。
- Renderer 只向 Main 请求 `workspaceId → { partition, fixed webPreferences }`，以及经过 HTTP(S) 校验的系统浏览器打开；不开放 create/destroy/navigate/CDP/executeJavaScript IPC。
- 所有 browser IPC 校验 trusted main-frame sender 与 canonical 64-hex workspace id；unknown sender/frame/workspace fail closed。
- guest 默认为 `sandbox:true`、`nodeIntegration:false`、`contextIsolation:true`、`webSecurity:true`；无必要不设置 preload。
- 若 POC 证明必须用 preload，只暴露固定、闭合 schema API；禁止桥接 CodePilot preload、文件系统、provider secrets 或任意 IPC invoke。
- `will-attach-webview` 必须核对 Main 已签发 partition 与初始 URL，并删除 preload、强制 sandbox/contextIsolation/webSecurity、关闭 Node 与 subframe Node。

### 测试

- [ ] Manager lifecycle/state-machine 单测：重复 create/destroy、快速 tab 切换、window close、workspace switch、renderer crash。
- [ ] IPC 恶意反例：未知 sender/frame、NaN/极端 bounds、伪造 id、跨 workspace tab、错误 schema。
- [ ] guest compromise fixture 不能访问 Node、CodePilot preload、环境变量、文件系统、Provider secret 或主窗 IPC。
- [ ] unresponsive/renderer-process-gone 有界退避；超过预算显示可恢复错误，不无限重建。

## Phase 2：Browser Surface 与 Primary + Inspector 接入

### 用户结果 / 验收入口 / 明确不做

- 用户结果：用户可从未 pin 的 Surface launcher 卡片或已 pin 的 Browser 模块打开浏览器；可在 Primary 对话旁的 Inspector 中查看页面。
- 验收入口：Workspace 打开 → Surface launcher/Browser pin → 输入 localhost 或 HTTPS URL → 调宽 Inspector → 返回对话。
- 明确不做：不新增独立浏览器侧栏，不删除 v13 Files + preview 并存路径，不实现完整桌面浏览器菜单。

### MVP Chrome

- 地址栏：当前 URL、输入/提交、loading/security/error 状态；展示的 URL 必须来自实际 navigation event，不用乐观假值。
- 操作：back、forward、reload/stop、open in system browser；新建/关闭页面只走 Workspace Sidebar 顶层“+”和 tab own close，不在 BrowserPanel 内重复一套 tabs。
- Loading：只在实际 guest `did-start-loading` 到 stop/fail/block 生命周期内展示无伪百分比的进度条；完成或失败必须隐藏。
- Surface：空态、loading、certificate/navigation error、crashed/unresponsive、offline/connection refused 均有诚实状态和恢复动作。
- Inspector 窄屏：消费 Sidebar 已验收的退化合同；空间不足时切换而不是挤成不可用双栏。
- `<webview>` 走 DOM surface，不再需要 WebContentsView bounds/overlay coordinator；nested overlay、焦点、音频与快捷键仍需 packaged smoke 证明。

### 测试

- [ ] URL bar 与实际 navigation/redirect 同步；失败不显示已成功加载。
- [ ] launcher、pin、Primary/Inspector、resize、fullscreen、hide/show、dark/light、DPI 和 app zoom。
- [ ] 中文 IME、复制粘贴、context menu、Tab focus、Cmd/Ctrl+L/K/R/W 等快捷键仲裁。
- [ ] nested overlays、快速开关、surface 切换和 view attach race。

## Phase 3：Tabs、Session、Partition 与状态恢复

### 用户结果 / 验收入口 / 明确不做

- 用户结果：一个线程可保留自己的标签页；同一 repository 的 worktrees 共享站点登录，独立 clone 不共享。
- 验收入口：创建 tabs → 重启项目/切换 worktree/打开独立 clone → 核对 tab 恢复和 fixture cookie/localStorage scope。
- 明确不做：不跨 repository 同步浏览器数据，不提供多 profile UI，不从系统浏览器导入 cookie/history。

### Partition 与恢复

产品 partition：

`persist:codepilot-browser-<hash(canonicalWorkspaceKey + browserProfileId)>`

- 哈希算法、输入编码和版本由 workspace identity 合同固定；日志只记 version + 短 hash，不记 canonical path 或 cookie。
- 默认 `browserProfileId = default`；未来 profile 变更必须迁移或显式新 partition，不能 silently mix。
- tab state 使用版本化 schema，恢复时先显示 skeleton，再由 Main 校验 URL 并创建 view；坏记录丢弃单 tab，不阻塞整个 workspace。
- history/tab 数量有上限和淘汰策略；只存 URL、title、timestamp、favicon reference 等必要元数据，不存网页正文或表单。
- “清除当前项目浏览数据”只清当前 workspace/profile partition，并明确会影响同 repository 的其他 worktree。

> 当前缺口：上述 tab 持久化、历史上限和“清除项目浏览数据”尚未实现；本轮只完成当前挂载期最多 8 个 tab 与 workspace persistent partition。

### 测试

- [ ] 相同 repository worktrees 的 partition 相同；独立 clone、非 Git workspace、identity version 变化的行为符合 Sidebar 合同。
- [ ] 多 window/thread 的 tab owner 不串线；关闭一个 thread 不误销毁另一个仍引用的 session。
- [ ] crash/restart、坏 schema、部分 tab 失败、migration rollback 均可恢复。
- [ ] fixture 证明 cookie/localStorage/cache 清理作用域，不读取或污染用户系统浏览器。

## Phase 4：导航、权限、下载、Localhost 与故障恢复

### 用户结果 / 验收入口 / 明确不做

- 用户结果：HTTPS 与本机开发服务可直接打开；popup、权限、下载和危险 scheme 有明确且可预测的结果。
- 验收入口：安全 fixture + 实际 localhost dev server，逐项触发 redirect、popup、camera/location、download、server stop/restart 和 crash。
- 明确不做：不扫描局域网，不默认授予网站权限，不静默下载，不把 Browser 描述成 Agent 可控制。

### 导航与本地服务

- HTTPS 默认可导航；HTTP 只允许 loopback/localhost，其他明文 HTTP 默认阻止并提供“系统浏览器打开”而非隐式放行。
- 顶层拒绝 `file:`, `javascript:`, `data:` 与未知 scheme；外部 scheme 必须走 allowlist + 用户动作 + `shell.openExternal` 安全校验。
- `will-navigate`、redirect、`setWindowOpenHandler` 共用单一 URL policy；popup 默认 deny，用户发起的新窗口可转为受控 tab 或系统浏览器。
- localhost discovery 只在用户明确打开 Browser/本地服务卡片时做有界 loopback 探测；不扫 LAN、不长驻轮询，结果显示真实端口/source breadcrumb，未发现时不展示假服务。

### 权限与下载

- `setPermissionCheckHandler` 和 `setPermissionRequestHandler` 默认 deny，按 exact origin + permission allowlist 决策；选择结果有 session scope 和清除入口。
- guest 不继承 Provider/Runtime permission profile；网页权限与 Agent 权限完全分离。
- 当前下载在 Main `will-download` 一律阻断，并在 Browser 中显示诚实错误；下载 UI、目标选择与进度在实现前不得宣称支持。
- 拒绝危险路径、重复覆盖与未经确认的可执行文件；取消/失败/磁盘错误有真实状态，不显示假完成。
- 日志、Sentry 与下载 UI 不记录 cookie、Authorization、query secret 或本地敏感路径。

### 测试

- [ ] URL/scheme/redirect/popup/permission 矩阵与 sender/frame 恶意反例。
- [ ] download：文件名穿越、重复、取消、超大/未知大小、危险扩展、磁盘失败、窗口退出。
- [ ] localhost：端口开启/关闭/重启、IPv4/IPv6 loopback、无服务、慢服务；确认无 LAN 扫描。
- [ ] certificate error、offline、DNS、connection refused、guest crash/unresponsive 的错误和恢复路径。

## Phase 5：验证、Guardrail 与交付

### 用户结果 / 验收入口 / 明确不做

- 用户结果：三平台正式包中的 Browser 主路径可验收，已知限制和数据作用域可查。
- 验收入口：packaged macOS/Windows/Linux，从项目打开 Browser、访问 localhost/HTTPS、切换顶层 Browser tabs、overlay、下载、重启恢复和清数据。
- 明确不做：不以单元测试或 macOS dev smoke 冒充三平台完成；不在未跑真实包时写 `Shipped`。

### 验证门禁

- [x] Tier 0：typecheck、相关 unit/contract tests、Electron main security 与 workspace tests。
- [x] Tier 1：Renderer surface/launcher/tab/error-state UI tests，语义字段均有真实 source breadcrumb。Web Playwright 只验 web 端诚实禁用；真实 guest 由 Electron dev smoke 覆盖。
- [ ] Tier 2：三平台 packaged smoke；vibrancy/DPI/WM、IME、overlay、zoom、shortcut、crash、partition、permission、download 全部登记 Ledger。
- [ ] Security review 无 P1/P2；日志脱敏与主窗/guest sandbox 边界分别核对，不用 guest sandbox 冒充主窗已加固。
- [ ] v13 Files + preview 删除仍只由 Sidebar plan 在真实替代交互通过后执行；Browser MVP 不越权清理。

### 文档认领

- [x] 更新 [ElectronMain guardrail](../../guardrails/ElectronMain.md)：`<webview>` attach gate、窄 IPC、guest hardening、navigation/download。
- [x] 更新 [PermissionBoundary guardrail](../../guardrails/PermissionBoundary.md)：网页权限与 Agent 权限隔离、默认拒绝。
- [x] 更新 ARCHITECTURE.md：Browser Main/Renderer 数据流、SurfaceRegistry、partition 与 state owner。
- [x] 更新本计划状态、决策日志、Smoke Ledger；POC 保留为 superseded research breadcrumb。
- [x] Browser availability 从 POC gate 改为 Electron bridge 后，同步回写 [WorkspaceSidebar guardrail](../../guardrails/WorkspaceSidebar.md)；其余 Sidebar 状态合同仍由上游计划认领。

### 2026-08-26 验证结果

- `npm run typecheck`：通过。
- `right-rail-mutex.test.ts` 最终布局契约：7/7 通过；明确接受 `standalone | peek | split` 三态，并钉死任何窄宽度 Inspector 都不渲染 fallback Primary / “返回看板、Git、Files”来源栏。Electron security 合同同时包含在全量回归中。
- `npx playwright test src/__tests__/e2e/project-panel.spec.ts`：13/13 通过；覆盖两个顶层 Browser tab、无嵌套 tablist、无 Sidebar 内 shell close、页面右上角统一 toggle 的 reload 行为、standalone 网页预览无幽灵分隔线/“返回 Git”行，以及 preview / Widget 双向切换且 preview 内容区无第二个返回入口。
- Browser 相关文件定向 ESLint、`npm run lint:docs-drift`、`npm run lint:hooks`、`git diff --check`：通过。
- `node scripts/build-electron-dev.mjs`：通过；`npm run build` 因给用户保留的 dev client 持有 `.next/dev/lock` 被项目安全门禁拒绝，未冒充生产构建通过。
- `npm run test`（删除 Inspector 来源栏及其契约测试均落入最终代码后，沙箱外权威复跑）：5385 项中 5384 通过、1 跳过、0 失败；typecheck、Harness boundary 与全量 unit 均通过。此前沙箱内尝试因 loopback 测试监听 `127.0.0.1` 被 EPERM 拒绝，不计为产品回归。

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|------|---------|----------|-------|---------|------|--------|----------|
| 2026-08-26 | Electron 40.10.6 dev / macOS arm64 | N/A | N/A | isolated `/tmp` Chromium profile；provider secret 跳过仅为一次性 smoke，源码随后撤除 | Sidebar 打开 Browser；localhost redirect 与实际 URL 同步；HTTPS example.com；顶层 new/close tab；back；remote HTTP 阻断 | ✅ PASS（dev only） | Computer Use AX：guest `HTML 内容` 分别报告 `localhost:3000/chat` 与 `example.com/`；Main stderr 仅有一条 Chromium mojo diagnostic，无产品 crash |
| 2026-08-26 | Electron 40.10.6 dev / macOS arm64 | N/A | N/A | 本机临时 4 秒 loopback fixture；无用户数据 | 真实 loading lifecycle；完成后标题同步；“+”创建第二个顶层 Browser tab；关闭后首个 guest 保活；无内层 tabbar/Sidebar shell X | ✅ PASS（dev only） | Computer Use AX 在加载期报告 `进度指示器 正在加载网页`，完成后消失并将顶层 tab 命名为 `Slow smoke`；第二个 Browser tab 关闭后首个 URL/内容仍在 |
| 2026-08-26 | Electron 40.10.6 dev / macOS arm64 | N/A | N/A | 用户本地 `/Users/op7418/Documents/CodePilot/Assistant/demo-page.html`；无外部凭据 | 打开本地网页 Artifact 预览，再通过加号添加看板并来回切换；内容区不显示 Primary/Inspector 分隔线或“返回看板/Git”来源栏 | ✅ PASS（dev only） | Computer Use screenshot + AX：顶层同时存在 `看板` 与 `demo-page.html`，网页 Inspector 直接从文件工具栏开始；无 `data-inspector-back` / `← 看板`；Playwright 同文件 13/13 |
| _待执行_ | Electron packaged | N/A | N/A | workspace-isolated session | macOS Browser 主路径 + vibrancy/IME/overlay | ⏳ | app version + screenshot/recording + partition marker |
| _待执行_ | Electron packaged | N/A | N/A | workspace-isolated session | Windows Browser 主路径 + DPI/download | ⏳ | app version + screenshot/recording + fixture report |
| _待执行_ | Electron packaged | N/A | N/A | workspace-isolated session | Linux Browser 主路径 + WM/focus | ⏳ | app version + screenshot/recording + fixture report |
| _待执行_ | Electron packaged | N/A | N/A | fixture permissions/downloads | navigation/permission/download/guest compromise matrix | ⏳ | sanitized security report |

## 完成定义

- 路线变化明确引用用户裁决，不伪造 WebContentsView POC GO；`<webview>` threat model 与安全 gate 独立闭环。
- Browser 通过统一 Surface Sidebar 打开，Primary + Inspector、pin、窄屏退化与 v13 迁移顺序符合 Sidebar 合同。
- Hardened `<webview>`、窄 IPC、workspace partition、导航/权限/下载策略和 overlay 行为均通过 Tier 2 回归。
- 同 repository worktrees 共享、独立 clone 隔离的真实 session fixture 通过；清理作用域对用户说清楚。
- 三平台 packaged Smoke Ledger 有真实证据，未执行项明确标 `not run`；Review 无未关闭 P1/P2。
- ElectronMain、PermissionBoundary、ARCHITECTURE 与完成态 breadcrumb 已同步后，才可标 Ready for human acceptance；用户验收后才可标 Shipped。
