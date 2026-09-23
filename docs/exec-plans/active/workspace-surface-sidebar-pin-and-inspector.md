# Workspace Surface Sidebar：项目 Pin、Primary + Inspector 与迁移

> 创建时间：2026-08-25
> 最后更新：2026-08-28
> 状态：🚧 单一 shell / identity / pin / Primary+Inspector / v13 清理已落；hydration、Tab/Pin、Inspector 三条真实点击路径及全量回归通过，待复审
> 风险等级：Tier 1；workspace identity / Git 子进程边界按 Tier 2 审查
> 事实基线：[T3 Code 模型输入区、统一侧边栏与内置浏览器专项调研](../../research/t3code-composer-sidebar-browser-ux-2026-08-25.md)
> 下游依赖：[Browser WebContentsView 技术 POC](browser-webcontentsview-poc.md)、[Browser Surface MVP](browser-surface-mvp.md)

## 用户问题与争议

用户希望文件树、Git、浏览器、看板、Diff、Agents 等进入同一个侧边栏，并能按项目 pin。没有 pin 时显示少量入口卡片，避免当前 FileTree Panel 与 Workspace Sidebar 两个独立外壳。

但 v13 的双栏叠加不是遗留代码：它来自真实使用反馈，解决“在文件树浏览，同时在另一栏持续预览”的任务。直接把 Files 和 Preview 变成互斥 tabs 会第三次反转产品方向。本计划采用一个外壳内的 **Primary + Inspector**：Files 保持可见，点击文件在 Inspector lane 打开预览；真实路径通过前不删除 v13。

另一个关键问题是 scope。现有 sidebar key 使用原始 `workingDirectory + sessionId`，无法合并 symlink/大小写/尾斜杠，也不理解 Git worktree。项目 pin 与 Browser partition 必须共享一个 canonical workspace identity 合同。

## 状态

| Phase | 内容 | 状态 | 用户能看到什么 |
|-------|------|------|----------------|
| Phase 0 | UX contract + Primary/Inspector 宽度 POC | ✅ 通过 | 同一 shell 在宽屏 split、窄屏 peek；窄 app 使用右侧 overlay |
| Phase 1 | Canonical Workspace Identity | ✅ 完成 | 同仓库 worktree 共享 opaque workspace id，独立 clone 隔离 |
| Phase 2 | Surface registry + 双层状态 | ✅ 完成 | workspace preference 与 thread inspector state 分离、版本化 |
| Phase 3 | Primary + Inspector 正式路径 | ✅ 完成 | 点击文件不再弹出第二个独立侧栏，树与预览仍可同时看 |
| Phase 4 | Workspace Pin + launcher / 加号入口 | ✅ 主路径完成 | 常用模块按项目恢复；空态与 Tab 栏加号都展示真实可用性 |
| Phase 5 | 旧状态迁移、v13 清理与验证 | 🚧 自动化与 UI smoke 通过 / 待复审 | 独立 FileTree shell 已删除；迁移、hydrate 与三条 Inspector 用户路径通过 |

## 决策日志

- 2026-08-25：单侧栏指单一 shell，不等于单一内容 lane；Files + Preview 用 Primary + Inspector 保留并排工作流。
- 2026-08-25：Git repository identity 使用绝对 git common dir；同一仓库 worktree 共享 workspace pin 与默认 browser partition，独立 clone 不共享。
- 2026-08-25：non-Git workspace 使用 `PathIdentity.comparisonKey`。
- 2026-08-25：pinned module 属 workspace；preview/diff/browser tab/agent run 属 thread。关闭临时 surface 不等于 unpin。
- 2026-08-25：旧 `files-pinned` 跨 session 冲突采用 monotonic boolean OR；`agent-run` 维持现有不直接持久化行为。
- 2026-08-25：v13 删除是 Phase 5 独立动作，硬依赖 Inspector 真实 smoke，不与新 shell 首次落地同批执行。
- 2026-08-25：实测 800px app 宽度时，持久化 480px sidebar 会挤压 Composer；workspace CardFrame 在 `<lg` 改为右侧有界 overlay，ResizeGutter 隐藏。Inspector 根据 `ResizeObserver` 测得的真实 shell 宽度在 split/peek 间切换，不按持久化目标宽度猜。
- 2026-08-25：Browser 只作为 availability gate 失败的禁用卡片存在；没有 POC GO 前不创建 native view。dirty diff 卡消费真实 `gitDirtyCount` 并进入 Git 选择实际文件，Agent 卡仅在当前 thread 有 live `agent-run` tab 时出现。
- 2026-08-26：按用户复核将 Pin 与当前打开的 Tab 彻底分层：`pinnedKinds` 只决定项目下次打开时恢复什么，`openPrimaryKinds` 只描述当前 renderer/session 打开的 Primary tabs。Unpin 不关闭；每个 Primary tab 自带浏览器式关闭按钮；关闭 pinned tab 不改 Pin，重载/重开项目会恢复。
- 2026-08-26：旧 key 是一版只读迁移输入，新版本不得继续回写 legacy key。否则全新项目会被刚写出的空 legacy bucket 误判为升级用户，并凭空 Pin Git/Widget。
- 2026-08-26：Launcher 卡片改为图标固定左上、标题与说明作为整体相对整张卡片水平/垂直居中；卡片说明采用无句号的短标签口径，避免视觉重心被图标布局带偏。
- 2026-08-26：Tab 栏右侧增加“+”。它只列当前未打开的 Primary surface，选择后瞬时打开但不自动 Pin；Browser 在 WebContentsView POC GO 前保留入口和真实禁用原因，不能伪装成可浏览网页。
- 2026-08-26：复审发现 hydrate 末尾调用 active-primary 会把持久化 `open:false` 重新写成 `true`，且覆盖 thread active。现在按“恢复 active → width → 最后恢复 open”执行；thread active 仍被 Pin 时优先，失效时才回退 workspace default。
- 2026-08-26：复审同时指出 v13 删除早于三条 Inspector 门禁，属于执行顺序违规。补验首先暴露聊天代码块 Artifact 入口缺失；入口补回后，Playwright 通过 FileTree、代码块 Artifact、写文件 Diff 卡三条真实点击路径，并逐次断言 Files Primary 未被替换。门禁现在有实证，但历史顺序不改写成“当时已通过”。
- 2026-08-26：用户实测发现 Standalone 网页预览上通过“+”添加 Widget 后无法切入。根因是交互激活只改 `activePrimaryId`，仍保留 `inspectorOpen:true`；窄栏 Inspector overlay 完全覆盖了已切换的 Widget。新增 `activatePrimaryInteractively`，交互点击关闭 Inspector 展示但保留 preview tab；hydrate 仍直接调用 `setActivePrimary`，继续保留重载恢复出的 Inspector。真实 dev Electron 与 Playwright 均完成 Preview → Widget → Preview → Widget 双向切换。
- 2026-08-26：用户继续验收指出 Preview 与看板已经是顶部同级 Tab，内容区再显示“← 看板”没有层级依据且浪费高度。移除所有窄宽度 Inspector 来源栏；切换 Primary 统一点击顶部 Tab，Esc 仍关闭当前 Inspector 展示。
- 2026-08-26：UI smoke 必须用当前 worktree 的 Electron 完整路径并核对 URL 为 `127.0.0.1:3000`。仅按 `CodePilot` display name 操作会启动已安装正式版（本机监听 47823、旧 UI），其旧文件树不能作为 dev 实现证据。
- 2026-08-28：用户现场发现左侧堆积 44 条 Workspace Sidebar E2E 项目。根因是 Playwright `reuseExistingServer` 把 session POST 发到日常 dev DB，且三条用例 finally 只删除临时目录。已精确删除 44 条（627→583，匹配残留 0）和 1 条目录已不存在的旧 Codex image smoke（583→582）；Playwright 改为单 owner 临时 DB + 独立 `.next-e2e-*` server，所有相关 fixture 增加 session DELETE；直接 `npx playwright` 缺少隔离环境时 fail closed。Computer Use 刷新真实 Electron 后重复 sidebar/smoke 项目消失；有 298/192/15 条长期历史的 `test-workspace2/ui-test/test-workspace` 明确保留，不以名字猜测为垃圾。

## Phase 0：UX contract + 宽度 POC

### 用户结果 / 验收入口 / 明确不做

- 用户结果：能在一个外壳中看到 Files Primary 与 Preview Inspector；关闭预览后树位置、展开和选择不丢。
- 验收入口：聊天页右侧栏，文件树打开、点击 Markdown/代码/Artifact、切换 Git 后返回 Files。
- 明确不做：不改持久化、不迁移 v13、不引入 Browser native view。

### 布局合同

- Primary lane：Files、Git、Widget、Browser、Agents 等 active module。
- Inspector lane：file/markdown/artifact/diff detail 等由 Primary 触发的临时预览。
- 当前 sidebar 320–800px、默认 480px。POC 必须实测而不是预设一个漂亮阈值：
  - 宽度足够：Primary + Inspector 可调整分隔；Files tree 有最低可用宽度。
  - 宽度不足：Inspector 在同一 shell 内成为 peek/overlay，通过顶部同级 Tab 返回 Files/看板；不得创建第二个 CardFrame 或内容区返回栏。
  - 用户手动扩宽/缩窄时，active file、scroll、tree expansion、preview mode 保持。

### 执行清单

- [x] 以现有 CardFrame/WorkspaceSidebar 样式做最小交互 POC，不新造视觉系统。
- [x] 覆盖 1024px app min width、默认桌面宽度、320/480/640/800 sidebar width。
- [x] Files 点击 markdown/code；Diff 打开 detail；Artifact 打开/关闭；返回时 Primary state 保留。
- [x] 验证键盘焦点、screen reader region label、resize handle hit target、peek 的 Esc 与顶部 Tab 切换行为。
- [x] 记录交互 POC 与可重复用户路径证据；未通过不得开 Phase 5 删除。

## Phase 1：Canonical Workspace Identity

### 用户结果 / 验收入口 / 明确不做

- 用户结果：同一 Git 仓库的主目录与 linked worktree 共享项目级 pin；symlink/尾斜杠不产生重复偏好；独立 clone 不串线。
- 验收入口：主 repo + worktree + symlink + non-Git folder 各开会话，查看 opaque workspace id 与偏好归属诊断。
- 明确不做：不按 remote URL 合并 clone，不把 thread preview path 跨 worktree 共享，不暴露绝对路径到遥测。

### Canonical contract

```ts
interface CanonicalWorkspaceIdentity {
  id: string; // versioned hash; renderer/localStorage/partition only消费这个值
  scope: 'git-repository' | 'directory';
  comparisonKey: string; // server-only
  version: 1;
}
```

解析顺序：

1. `resolvePathIdentity(workingDirectory)`，只接受 existing directory。
2. 使用固定 executable + argv、`shell:false`、短 timeout 执行 `git -C <absolutePath> rev-parse --path-format=absolute --git-common-dir`。
3. 成功则再对 common dir 做 path identity，以 comparison key 作为 repository scope；非 Git、git 不可用或明确 not-repository 时回退 directory comparison key。
4. 权限/timeout/异常不得回显动态路径或 git stderr；不可判定时 fail closed 到当前 canonical directory，不猜 remote。
5. `id = hash('workspace-v1\0' + scope + '\0' + comparisonKey)`；localStorage 和 browser partition 不直接含绝对路径。

### 执行清单

- [x] 新增 server-owned pure resolver + narrow Git probe；不得从 renderer 启进程。
- [x] 提供窄 API/loader，由 session id 派生 working directory；新会话无 session 时只接受已验证的当前项目目录。
- [x] 单测 macOS/Linux path、Windows drive case、UNC policy、symlink、trailing slash、主 worktree、linked worktree、独立 clone、non-Git、git missing/timeout。
- [x] 记录 identity version；未来算法变化必须显式 migration，不能静默换 key。
- [x] 把 identity contract 输出给 Browser POC/MVP，避免后者复制 git/path 逻辑。

### Phase 1 退出门槛

- 同 repo worktrees id 相同；独立 clone/non-Git folder id 不同。
- 无 shell 字符串、无路径日志、无未界定 fallback。
- Review passed 后 Browser POC 才可消费该合同。

## Phase 2：Surface registry + 双层状态

### 用户结果 / 验收入口 / 明确不做

- 用户结果：所有右侧模块使用一致的 tab/pin/available 状态；不可用模块解释原因。
- 验收入口：Files、Git、Widget、Agents、Diff、Artifact 的打开/关闭/pin 行为。
- 明确不做：Browser 此阶段只有 registry placeholder，不承诺 live page；Terminal 不因 T3 卡片自动进入首版。

```ts
type SurfaceKind =
  | 'files' | 'git' | 'widget' | 'browser' | 'agents'
  | 'diff' | 'artifact' | 'file-preview';

interface WorkspaceSurfacePreferencesV1 {
  workspaceId: string;
  pinnedKinds: SurfaceKind[];
  order: SurfaceKind[];
  defaultActiveKind?: SurfaceKind;
  open: boolean;
  width: number;
}

interface ThreadSurfaceStateV1 {
  sessionId: string;
  activePrimary?: SurfaceKind;
  inspectorTabs: InspectorTab[];
  browserTabs: BrowserTabDescriptor[];
}
```

运行时另维护不持久化的 `openPrimaryKinds`。它在 workspace identity hydrate 后由 `pinnedKinds` seed，但之后与 Pin 独立变化：activate/pin 会打开，unpin 保持打开，tab close 才从中移除。

- [x] `SurfaceRegistry` 是单一标题/icon/pinnable/availability/source breadcrumb 事实源。
- [x] workspace preference 与 thread state 分 key/version/parser；malformed data fail closed 到默认，不丢 app。
- [x] 每个 Primary tab 在自己的标签内提供关闭按钮；close 只改 `openPrimaryKinds`，unpin 只改 workspace preference，二者互不代替。
- [x] Files/Git/Widget 初始固定语义迁成普通 pinnable surface；首次升级按 Phase 5 兼容策略保留。
- [x] Artifact/file/diff 不默认 pinnable；若以后要 pin，另做可恢复 identity 设计。
- [x] agent-run 不复制 prompt/result 到 localStorage，继续从 durable message 重建。

## Phase 3：Primary + Inspector 正式路径

### 用户结果 / 验收入口 / 明确不做

- 用户结果：FileTree 点击文件后，树保留在 Primary，preview 在 Inspector；没有第二个独立右栏。
- 验收入口：file tree → markdown/source/rendered/HTML trust flow、DiffSummary → preview、Artifact → preview。
- 明确不做：本阶段不删除旧 v13 fallback；不改变 HTML/local path trust 边界。

- [x] WorkspaceSidebar shell 内实现 Primary/Inspector 状态与布局，复用 CardFrame/ResizeGutter。
- [x] 将 `workspace-tab-open-request` 分成“activate primary”与“open inspector”明确事件，不再用一个 active tab 隐式表达两件事。
- [x] Files tree expansion/scroll/selection 独立于 inspector lifecycle。
- [x] Inspector tabs 按 kind+key 复用；trust tier、preview view mode、file path canonicalization 继续沿用现有合同。
- [x] 窄宽度 peek 打开时 Primary state 保留；关闭/点击顶部 Primary Tab 不重新 mount 整棵 tree，内容区不重复显示返回栏。
- [x] 回归 AssistantPanel、chat min-width、两侧栏/聊天列表组合和 macOS card/vibrancy。

## Phase 4：Workspace Pin + 空态 launcher

### 用户结果 / 验收入口 / 明确不做

- 用户结果：pin Files/Git/Widget 后，同项目新会话自动出现；无 pin 时看到 3–5 张可选择卡片。取消 Pin 后当前 tab 仍在，用户可从标签自己的关闭按钮关掉；关闭但仍 Pin 的 tab 会在重开项目时恢复。
- 验收入口：同项目新会话、worktree、另一 clone、non-Git folder、app restart；逐项覆盖 pin → unpin（仍开）、pin → tab close（当前关闭）→ reload（恢复）。
- 明确不做：不把临时 file/browser tab 变成项目 pin，不无限展示所有 surface 卡片。

- [x] launcher 默认候选 Files/Git/Browser；有 dirty diff 加 Diff，有 active sub-agent 加 Agents，无 Git 时 Git 卡显示 Initialize Git。
- [x] 卡片 availability 必须来自真实状态；不可用不显示假计数/假 0。
- [x] pin/unpin/reorder/default active/open/width 按 workspace id 持久化。
- [x] 有 pin：shell 恢复并选上次 active；无 pin：显示 launcher，不自动假定 Git/Widget。
- [x] 当前打开的 Primary tabs 不持久化；只在 hydrate 时从 pins 恢复。Unpin 不关闭，Primary 自有 close 不清 Pin。
- [x] Tab 栏“+”列出未打开的 Primary surface；选择可用项只调用 activate/open，不改 `pinnedKinds`。已打开项不重复出现。
- [x] 加号菜单与 launcher 共用真实 availability 口径；Browser POC 未通过、无 durable agent-run 等状态必须 disabled 并解释原因。
- [x] 首次安装与升级用户的默认策略分开，升级迁移不覆盖用户显式 unpin。
- [x] 键盘 reorder/pin、aria-current、tooltip 与 icon semantic 回归。

## Phase 5：迁移、v13 清理与验证

### 用户结果 / 验收入口 / 明确不做

- 用户结果：升级后 pin/preview 可继续使用，不出现两个文件树；经过 Inspector 验收后才移除旧双 shell。
- 验收入口：同 workspace 多 session 有/无 files-pinned 冲突、旧 dynamic tabs、app reload、worktree。
- 明确不做：不迁移不存在的 agent-run localStorage；不删除 completed 决策历史，只加 superseding breadcrumb。

### 迁移规则

- 新 key versioned by opaque workspace id；旧 key 保留一版只读 fallback 期。新代码不得再 `setItem` legacy key，避免制造假迁移输入。
- 枚举 well-formed `codepilot:workspace-sidebar::<wd>::<sid>` key；从最后一个 delimiter 解析 session，路径包含 `::` 时仍可处理。
- unique old working directories 通过有界 batch resolver 转 workspace id；不存在/不可信路径跳过并保留旧 key，不猜。
- 同 workspace 任一 old bucket 含 `files-pinned` → new `files` pin = true（boolean OR）。迁移幂等、单调，不因后处理 bucket 反转。
- dynamic markdown/artifact/file tabs 保持 thread/session scope；迁到新 ThreadSurfaceState，不提升为 workspace pin。
- agent-run 不在 serialized old state 中，验收只要求运行时行为与现状一致。

### 删除门禁

- [x] Primary + Inspector 在默认宽度、窄宽度、800px 宽度真实 UI smoke 通过。
- [x] FileTree → preview、Diff → preview、Artifact → preview 三条真实点击路径不丢 Files Primary 上下文。
- [x] 迁移 fixture 覆盖冲突、malformed、path variants、worktree、重复运行。
- [x] 独立 FileTree Panel shell/入口重复路径与 v13 coexistence code 已删除；复审确认删除动作曾早于三路径门禁，补回 Artifact 入口并让门禁通过后才允许合并。
- [x] 更新 `workspace-sidebar-tabs.md`、`refactor-phase-3-background-tasks-notifications.md`、`refactor-closeout.md` 加 superseding breadcrumb；同步 `ARCHITECTURE.md` 和 `AppShell.tsx` 注释。
- [x] `npm run test`、`npm run test:smoke`，必要时 `npm run test:e2e`；真实 UI 证据写 Ledger。

## 关键文件与预计责任

| 模块 | 文件 | 责任 |
|------|------|------|
| State | `src/lib/workspace-sidebar.ts`, `src/hooks/useWorkspaceSidebar.tsx` | registry、workspace/thread state、versioned persistence |
| Shell | `src/components/layout/AppShell.tsx`, `WorkspaceSidebar/*`, `PanelZone.tsx` | 单 shell、Primary/Inspector、旧路径清理 |
| Files | `panels/FileTreePanel.tsx`, PreviewPanel/TabPanel | tree state、inspector open、trust contract |
| Identity | `src/lib/path-identity.ts`, 新 workspace identity helper/API | repo/directory scope、opaque id |
| Topbar | `UnifiedTopBar.tsx` | 单入口、active/pin 状态、无重复 toggle |

## 不变量与反例

- 一个 shell 不等于互斥 tabs；Files → Preview 必须保留浏览上下文。
- worktree 共享 pin 不等于共享 thread file paths。
- 同 remote 的独立 clone 不共享 workspace id。
- close pinned surface 不得隐式 unpin；unpin 不得关闭 Primary tab，也不得删除 thread inspector tabs。
- Primary tab 的关闭入口必须在它自己的标签内；shell collapse 只收起整个侧栏，不能冒充 tab close。
- 加号菜单只能打开当前未打开且真实可用的 Primary；打开不等于 Pin，不得因为用户临时点一次就污染项目恢复偏好。
- 全新 workspace 没有真实 legacy bucket 时必须落到无 Pin launcher；不得由当前版本自产 legacy key 后触发 upgrade defaults。
- migration 不得因 localStorage malformed/path inaccessible 清空用户旧状态。
- v13 清理必须晚于替代路径 smoke，不以源码/单测冒充用户路径通过。

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|------|---------|----------|-------|---------|------|--------|----------|
| 2026-08-25 | Browser UI | N/A | N/A | local app | Files Primary + Inspector split / 320px peek / 800px app overlay | ✅ PASS | interactive 1280/800/320 smoke；Primary state 与 preview close 保持；旧返回栏交互已由 2026-08-26 顶部 Tab 决策取代 |
| 2026-08-25 | Node unit | N/A | N/A | temp Git fixtures | main repo/worktree identity 共享；clone/non-Git 隔离 | ✅ PASS | `workspace-identity.test.ts` |
| 2026-08-25 | Node unit | N/A | N/A | localStorage fixtures | multi-session files-pinned OR、malformed、thread preview migration | ✅ PASS | `workspace-surfaces.test.ts` + `workspace-sidebar.test.ts` |
| 2026-08-25 | Playwright | N/A | N/A | web fixture | unified shell launcher / file deep-link migration / explicit non-Git Initialize Git | ✅ PASS | `project-panel.spec.ts` 既有 2 条通过；新增 Git init 1/1；`global-search-file-seek.spec.ts` 1/1 |
| 2026-08-25 | Automated | N/A | N/A | fixture | full unit / build / smoke / scoped/full E2E | ⚠️ PARTIAL | unit 5359 pass + 1 skip；build PASS；smoke 22/22；本次 scoped E2E 4/4；full E2E 35 pass / 98 skip / 27 stale-selector/credential-dependent failures |
| 2026-08-26 | Browser UI | N/A | N/A | local app | Files tab：pin → unpin 保持打开 → 标签内关闭 | ✅ PASS | interactive dev-client smoke；launcher 与 Primary state 正确切换 |
| 2026-08-26 | Playwright | N/A | N/A | temp non-Git workspace | 无假 legacy pin；unpin 保持；pinned tab close；reload 恢复 | ✅ PASS | `project-panel.spec.ts` dedicated path 1/1 |
| 2026-08-26 | Playwright | N/A | N/A | web fixture | Tab 栏加号列未打开模块；Files 瞬时打开且未 Pin；Browser 显示 POC gate 禁用原因 | ✅ PASS | `project-panel.spec.ts` 汇总 7/7 |
| 2026-08-26 | Playwright | N/A | N/A | mocked workspace tree | 旧 FileTree context-menu smoke 适配统一侧栏：先显式打开 Files，再验证 rename / quiet refresh | ✅ PASS | dedicated 3/3；full smoke 22/22 |
| 2026-08-26 | Node + Playwright | N/A | N/A | workspace/thread storage fixtures | reload 保留 `open:false` 与 thread active Files；失效 active 才回退 default | ✅ PASS | `workspace-sidebar.test.ts` 新增 2 条；`project-panel.spec.ts` 10/10 |
| 2026-08-26 | Playwright | N/A | N/A | mocked message + workspace tree | FileTree 点击、聊天代码块 Artifact、写文件 Diff 卡依次打开 Inspector；每次 Files 仍是 Primary | ✅ PASS | `workspace-context-menu-actions.spec.ts` 三路径 1/1；文件整体 4/4 |
| 2026-08-26 | Final regression | N/A | N/A | fixture + local web server | typecheck / full unit / scoped UI / full smoke / production build | ✅ PASS | `npm run test` 5363 pass + 1 skip；scoped Playwright 14/14；smoke 23/23；production build 137 pages（live dev 占用 `.next`，故在同源 `/tmp` 副本验证） |
| 2026-08-26 | Browser UI + Playwright | N/A | N/A | local dev app | Launcher 图标左上；文案组相对卡片水平/垂直居中；说明无句号 | ✅ PASS | 三卡 98px 高，copy center delta 0px，icon offset 17px/17px；`project-panel.spec.ts` 10/10；console 0 warning/error |
| 2026-08-26 | Electron dev + Node + Playwright | N/A | N/A | 当前 worktree Electron；用户 `demo-page.html` preview | Preview → 加号添加看板 → Preview → 看板双向切换；网页内容直接从 Inspector 工具栏开始，无重复“返回看板”栏；preview tab 保留；旧独立 FileTree shell 不存在 | ✅ PASS | Electron App=`Electron`、URL=`127.0.0.1:3000` AX 实证；`right-rail-mutex.test.ts` 7/7；`workspace-sidebar.test.ts` 44/44；`project-panel.spec.ts` 13/13；`npm run test` 5384 pass / 0 fail / 1 skip |
| 2026-08-28 | Playwright isolation + real DB audit | N/A | N/A | `/tmp` SQLite + 独立 `.next-e2e-*`；真实库只读前后计数 | scoped `project-panel` 创建/删除三类 session；并发日常 Electron dev；历史测试项目清理 | ✅ 隔离成立；修正英文 `Dashboard` selector 后 13/13；full unit 5423 pass / 0 fail / 1 skip；真实库无新增 | wrapper 结束后 temp DB/build dir 均不存在；真实匹配数运行前后保持 44，随后按双证据删除为 0；另删 1 条 dead `/tmp` smoke，总会话 627→582；Computer Use 刷新确认重复项目消失 |

## 完成定义

- 单一 Workspace Surface shell 落地，同时保留 Files + Preview 任务。
- workspace/thread scope、worktree identity 与 migration 可解释、可测试、可重复执行。
- Pin、当前 Tab 与 launcher 无假状态；升级不丢现有 thread previews，全新项目不被误判迁移。
- v13 只在替代交互 Smoke passed 后删除并同步历史 breadcrumb。
- Tests pass + UI Smoke passed + Review passed；未跑真实布局路径不得标完成。
