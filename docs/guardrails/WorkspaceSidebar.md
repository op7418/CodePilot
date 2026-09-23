# Workspace Sidebar — Tab / Pin / Primary + Inspector 护栏

右侧 Workspace Sidebar 把 Files、Git、Widget、Browser、Agents 等 Primary surface 与文件、Diff、Artifact 等 Inspector preview 放进一个 shell。本护栏锁住最容易混淆的三件事：当前打开、项目 Pin、整个侧栏展开状态。

## 1. 词汇表

| 名称 | 定义 | 事实源 |
|---|---|---|
| Primary surface | Files / Git / Widget / Browser / Agents 等项目工具 | `src/lib/workspace-surfaces.ts` |
| Inspector tab | 由 Primary 触发的 file / markdown / diff / artifact 临时预览 | `src/lib/workspace-sidebar.ts` |
| `openPrimaryKinds` | 当前 renderer/session 打开的 Primary tabs；瞬时状态 | `src/hooks/useWorkspaceSidebar.tsx` |
| `pinnedKinds` | 下次打开同一 canonical workspace 时要恢复的 Primary kinds | `WorkspaceSurfacePreferencesV1` |
| Launcher | 当前没有打开 Primary/Inspector 时显示的模块卡片 | `WorkspaceSidebar/TabPanel.tsx` |
| Add surface（+） | Tab 栏上的瞬时打开入口；普通 Primary 只列未打开项，Browser 可重复创建页面 tab | `WorkspaceSidebar/TabBar.tsx` |
| Browser surface tab | 一个顶层 Workspace Sidebar tab 对应一个网页/`<webview>`；没有浏览器内层 tab | `workspace-sidebar.ts` + `BrowserPanel.tsx` |
| Standalone Inspector | 从聊天预览等入口直接打开、当前没有真实 Primary surface 的 Inspector；它独占内容区 | `TabPanel.tsx` |
| Shell collapse | 页面右上角统一入口收起整个右侧 shell；不等于关闭某个 tab | `UnifiedTopBar.tsx` |

## 2. 不变量 / 契约表

| 用户动作 | `openPrimaryKinds` | `pinnedKinds` | 可见结果 |
|---|---|---|---|
| 点击 launcher / 激活 Primary | 加入 kind | 不变 | 当前打开并选中该 tab |
| 从“+”选择 Primary | 加入 kind | 不变 | 当前打开并选中；下次不自动恢复 |
| Pin | 加入 kind | 加入 kind | 当前打开；重开项目仍恢复 |
| Unpin | **不变** | 移除 kind | 当前 tab 继续打开；下次不自动恢复 |
| 点击 tab 自己的关闭按钮 | 移除 kind | **不变** | 当前隐藏；若仍 Pin，重开项目恢复 |
| 收起 shell | 不变 | 不变 | 整个右栏隐藏，tabs/pins 均保留 |
| workspace identity hydrate | 从 pins seed，并优先保留仍 pinned 的 thread active | 从 versioned storage 恢复 | active/width 先恢复，`open` 最后恢复；有 Pin 也可以保持用户收起态 |

附加不变量：

- 每个 Primary tab 必须在自己的标签内有可聚焦、带名称的关闭按钮；不能只提供全局关闭，也不能让 Unpin 冒充关闭。
- Sidebar 内不得再放一个 shell-level 关闭按钮；整个右栏由页面右上角既有 Workspace Sidebar toggle 收起，tab 内关闭只负责当前模块/页面。
- 关闭 active Primary 后选择下一个已打开的 Primary；没有剩余项时关闭 Inspector 并显示 launcher，但保持 shell 打开。
- Primary + Inspector 是同一 shell 内两个 lane。关闭 Inspector 不得卸载或重置 Files tree；打开 preview 不得创建第二个侧栏。
- 用户点击 Primary tab 或从“+”打开 Primary 时，必须让 Primary 成为可见 lane：只关闭 Inspector 的 active 展示，不删除 Inspector tab。点击原 preview tab 应能再次打开 Inspector。Hydration 不是用户点击，必须继续保留 thread 恢复出的 active Inspector，二者不得共用会清状态的 reducer。
- Inspector tab 可以脱离 Primary 独立打开。只有 Primary 与 Inspector 两类 tab 同时存在时才显示 tab 分隔线；Inspector 内容区在任何宽度都不渲染“返回 Git/Files/看板”等来源栏，切换完全由顶部同级 Tab 承担。
- `pinnedKinds` 按 canonical workspace id 持久化；`openPrimaryKinds` 不持久化，只在 hydrate 时由 pins seed。
- 旧 `codepilot:workspace-sidebar::<wd>::<sid>` key 只读迁移。当前版本不得回写 legacy key，否则全新 workspace 会被误判成升级用户并产生假 Pin。
- shell collapse/open、width、default active 可以是 workspace preference，但都不能改变上表的 Tab/Pin 语义。
- hydrate 不能用“激活 Primary”作为最后一步：该 reducer 会顺带 `open:true`。必须先决定 thread active / workspace default 并恢复 width，最后单独恢复持久化 `open`，否则 reload 会擅自展开侧栏。
- “+”对普通 Primary 只列 `preferences.order - openPrimaryKinds`；Browser 是可重复项，每次选择都创建新的顶层 Browser tab（有界上限），而不是在 BrowserPanel 内创建嵌套 tab。availability 未通过的项必须 disabled 并显示真实原因；Browser 以 Electron preload 的窄 browser bridge 为事实源，web 客户端保持 disabled 并显示“仅桌面客户端支持”，不得创建假页面。
- 每个 Browser tab 只拥有一个 BrowserPanel/guest；切换 tab 时保持已打开页面挂载，关闭时只销毁对应 guest。页面 URL/history/title 不写入 workspace preference，恢复时只从 Pin 生成一个空白 Browser tab。

## 3. 关键文件 + 责任

| 文件 | 责任 |
|---|---|
| `src/hooks/useWorkspaceSidebar.tsx` | identity hydrate、瞬时 open tabs、Pin persistence、关闭 fallback、legacy 只读迁移 |
| `src/lib/workspace-surfaces.ts` | Primary kind、workspace preference parser/key、legacy migration |
| `src/lib/workspace-sidebar.ts` | Primary/Inspector active state、thread preview persistence |
| `src/components/layout/WorkspaceSidebar/TabBar.tsx` | Primary/Inspector 各自标签、各自 close、瞬时“+”与 Pin；Browser tab 可重复，shell collapse 不在此处 |
| `src/components/layout/WorkspaceSidebar/TabPanel.tsx` | launcher、Primary + Inspector layout、Browser panels 保活与 availability |
| `src/components/layout/WorkspaceSidebar/BrowserPanel.tsx` | 单网页地址栏、真实 loading lifecycle 与 guest；不得再建内层 tab bar |
| `src/lib/workspace-identity.ts`, `/api/workspace/identity` | canonical workspace scope；worktree 共享、独立 clone 隔离 |

## 4. 改动检查表

- 改 Primary tab：验证 activate、Pin、Unpin、own close、关闭非 active、关闭最后一项与 reload。
- 改持久化：确认只写 `codepilot:workspace-surfaces:v1:<opaque-id>` 与 thread state，不写 legacy workspace-sidebar key。
- 改 hydrate：覆盖 `open:false + thread active`、thread active 已不再 pinned、workspace default fallback；断言 active 与 shell open 是两个独立维度。
- 改 launcher：无 Pin 的全新 non-Git workspace 必须真实显示卡片；不可用项给真实原因，不显示假 0。
- 改加号菜单：普通模块只列未打开项，Browser 始终可在上限内新建顶层页面 tab；选择可用项不得顺带 Pin；Browser 在 Electron bridge 存在时可用、web 中 disabled，Agents 无 durable run 时 disabled；两者都保留真实 reason。
- 改 Browser tab：验证一个顶层 tab 只对应一个 guest、切换保活、标题同步、popup 同层新建、最后一个关闭 fallback、Pin 只恢复一个空白 tab，以及 BrowserPanel 内没有第二个 tablist。
- 改 identity：主 repo/worktree 共享 pins，独立 clone/non-Git folder 不串；renderer 不持有原始 path key。
- 改 preview：Files → Preview 仍保留 Primary state；窄宽度 peek overlay 不重新 mount tree，返回 Primary 通过顶部同级 Tab；聊天直接打开的 Standalone Inspector 在宽/窄布局下均不得泄漏默认 Git Primary、tab 分隔线或返回栏。
- 改 Primary 激活：覆盖 Standalone Inspector → 加号打开 Widget/Files/Git → Primary 可见 → 点回 preview → 再点 Primary；preview tab 全程保留，交互切换不得改变 hydration 的 Inspector 恢复语义。
- 改无障碍：Primary 与 Inspector 均是 tab；close button name 包含 tab 名；shell collapse 有不同名称。

## 5. 常见坑

1. **用 `pinnedKinds` 直接渲染当前 tabs** — Unpin 会把正在用的模块立即关掉。
2. **close 同时调用 unpin** — 用户只想临时关 tab，却永久修改项目恢复偏好。
3. **只有全局 X，没有 tab own close** — 用户无法判断是在关模块还是收起整个右栏。
4. **把 `openPrimaryKinds` 写入 workspace preference** — 临时浏览行为污染下次打开。
5. **新版本继续写 legacy key** — 全新 workspace 在 identity hydrate 前制造假 upgrade bucket。
6. **Primary/Inspector 做成互斥 tabs** — 点击文件后树消失，破坏持续浏览 + 并排预览任务。
7. **加号点击顺带 Pin，或重复列出已打开的普通 Primary** — 临时浏览污染项目恢复状态。Browser 是唯一有意可重复的 Primary，每次重复都必须是独立的顶层页面 tab。
8. **hydrate 最后调用 `setActivePrimary`** — reducer 顺带把 shell 展开，并可能用 workspace default 覆盖 thread active。
9. **BrowserPanel 内再套一层 tabs，或 Sidebar 内再放全局 X** — 同一个网页/同一个 shell 出现两套 owner，用户无法判断关闭的是页面还是整个侧栏。
10. **用 `activePrimaryId` 代替“真实已打开 Primary”判断 lane** — 初始 fallback 是 Git；Standalone Inspector 会凭空出现分隔线、Git 内容或“返回 Git”。必须同时核对 `openPrimaryKinds` 和可重复 Browser tab 实体。
11. **交互激活与 hydration 共用同一副作用** — 用户点击 Primary 需要收起当前 Inspector 展示，hydration 却必须保留恢复出的 Inspector。应由 `activatePrimaryInteractively` 包装 `setActivePrimary + closeInspector`，hydrate 继续直接使用 `setActivePrimary`。
12. **窄屏 Inspector 再加“返回来源”栏** — 顶部已经有同级 Primary/Inspector tabs；额外来源栏重复导航、占据预览高度，并把“从哪打开”误写成层级关系。

## 6. 测试覆盖

| 测试 | 覆盖 |
|---|---|
| `src/__tests__/unit/workspace-surfaces.test.ts` | workspace key/parser、legacy OR migration、thread scope |
| `src/__tests__/unit/workspace-sidebar.test.ts` | Primary/Inspector pure state、open/close/width、交互激活关闭 Inspector 但保留 preview tab、hydrate 顺序与 active fallback |
| `src/__tests__/unit/workspace-identity.test.ts` | repo/worktree/clone/non-Git canonical identity |
| `src/__tests__/e2e/project-panel.spec.ts` | launcher、加号瞬时打开/Browser gate、Standalone Inspector 无 phantom Git/divider、Unpin 保持打开、own close 不清 Pin、reload 恢复、Runtime-first Picker |
| `src/__tests__/e2e/workspace-context-menu-actions.spec.ts` | FileTree、聊天代码块 Artifact、写文件 Diff 卡三条真实点击路径；Inspector 打开时 Files Primary 保留 |

改本护栏覆盖的状态或 UI，至少跑上述三组 unit targeted 与 `project-panel.spec.ts` scoped E2E。所有创建 session 的 E2E 必须在 `finally` 调用共享 `deleteTestSession`；Playwright 只能通过隔离启动器运行，不得把测试项目写入日常侧栏。

## 7. 设计决策日志

- **2026-08-25** 单一 shell 采用 Primary + Inspector，而非互斥 tab；保留 Files 浏览上下文与并排预览。
- **2026-08-25** Pin 归 canonical workspace，preview 归 thread；worktree 共享 workspace preference，独立 clone 隔离。
- **2026-08-26** Pin 与当前打开正式拆层；用户明确要求 Unpin 后 tab 仍可关闭，关闭入口归 tab 自己，行为对齐浏览器。
- **2026-08-26** legacy key 改为只读迁移输入；修复新项目自产 legacy bucket 后被错误 Pin Git/Widget。
- **2026-08-26** Tab 栏增加“+”瞬时打开未开启模块；它与 Pin 严格分离，并复用真实 availability gate。
- **2026-08-26** hydrate 明确分离 active 与 shell open；active/width 先恢复，persisted open 最后恢复，避免 reload 擅自展开或覆盖 thread active。
- **2026-08-26** v13 删除门禁补成可重复 E2E；补验发现并修复聊天代码块 Artifact 入口缺失，三条 Inspector 用户路径全部保留 Files Primary。
- **2026-08-26** Browser availability 从 POC 占位改为 Electron browser bridge：桌面 launcher/“+”真实打开 hardened `<webview>`，web 入口继续诚实禁用；Pin/Open/own-close 仍沿用本护栏状态语义。
- **2026-08-26** Browser 改为一个 Workspace Sidebar 顶层 tab 对应一个网页，移除 BrowserPanel 内层 tabs；“+”重复创建 Browser 页面。Sidebar 内冗余 shell close 同时移除，整个 shell 只由页面右上角统一 toggle 收起；加载条只映射真实 navigation request/guest lifecycle。
- **2026-08-26** Inspector 正式支持无 Primary 的 standalone 形态；tab lane 分隔线只在两类 tab 同时存在时展示，窄侧栏返回栏只在确有可返回 Primary 时展示，避免默认 `activePrimaryId=git` 泄漏到网页预览。
- **2026-08-26** 修复 Standalone Inspector 上通过“+”添加 Widget 后点击无可见反应：交互式 Primary 激活现在关闭 Inspector 展示但保留 preview tab；hydration 继续使用无关闭副作用的恢复路径，避免修复交互时破坏重载恢复。
- **2026-08-26** 移除窄屏 Inspector 的“← 看板/Git/Files”来源栏；Primary 与 Inspector 已是顶部同级 Tab，内容区不再重复一套返回导航。
- **2026-08-28** 用户反馈 dev 客户端长期堆积 `E2E Initialize Git / Sidebar Tab Close / Sidebar Hydration` 项目。根因是 scoped E2E 复用真实 dev server 且 finally 只删工作目录。现改为临时 DB + 独立 `.next-e2e-*`，三类 fixture 逐 session 删除；历史 44 条测试会话已精确清理，用户会话未动。
