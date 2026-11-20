# T3 Code：模型输入区、统一侧边栏与内置浏览器专项调研

> 日期：2026-08-25
> 状态：Claude 独立审查后已修订，待产品确认后拆执行计划
> CodePilot 基线：`c97de028721d4c466982065780445d947048eee2`
> T3 Code 本地基线：`643daa51616d0bfcd4c8235ae6966a68f106dcfe`
> 证据口径：截图只证明可见交互；本地源码证明实现形状；未经过打包应用三平台 smoke 的能力不标记为“生产已验证”。

## 1. 结论

用户指出的方向成立，而且不是简单“照抄 T3”。推荐按三个相互独立的工作包推进：

1. **输入区先收口**：保留 CodePilot 已有的 provider + model 一体选择，在此基础上补搜索、按 `provider instance + model` 收藏、能力驱动的参数菜单；把 Runtime、权限与运行状态收进输入框 footer。可移除独立 Code / Plan 控件，但 **Plan 的跨 Runtime 只读权限语义必须并入 Permission 选择器**，不能消失或静默回落到 Code。
2. **侧边栏改为单一外壳、内部主从分栏**：文件、Git、浏览器、看板/Widget、Agent、Diff、Artifact 都进入同一注册表；“项目级固定”和“会话级临时打开”分开持久化。Files 作为主模块时，点击文件应在同一外壳的 preview inspector lane 打开，不切走文件树；这样既避免两个独立侧栏，又保留 v13 的“文件树 + 预览并排”核心工作流。
3. **浏览器采用 T3 的产品/状态模型，不直接复制其 `<webview>` 传输层**：CodePilot 先用 Electron `WebContentsView` 做 POC，由主进程拥有 tab、session、权限和导航策略；确认布局、透明材质、焦点、输入法与三平台表现后再产品化。Agent 自动化后置，复用 `webContents.debugger` / CDP 的思路。

两项历史决策需要被本次用户反馈显式覆盖：

- 旧输入区方案的完整理由是“约 20 个模型时滚动成本可接受，recent 可覆盖约 80% 使用”，并非简单认为搜索无用。当前 shipped catalog 已包含 29 个 preset、121 条 preset-model 记录，单 preset 最多 15 条；实际 composer 条目仍取决于用户启用的 provider。新方向据此改为“最近 + 收藏 + 搜索”并存，虚拟列表是否必要由真实启用条目数和性能测量决定。
- Workspace Sidebar v13 的双栏叠加本身是 2026-05-10 用户实测后对互斥方案的纠正。新的单外壳方向只有在 preview inspector lane 通过真实“文件树点击 → 预览”验收后才可覆盖 v13；不能先删除旧路径再寻找替代。
- 独立审查结论为 **Accept with revisions**：原方案关于 T3 和 CodePilot 的事实核验成立；Plan 权限语义、v13 替代交互、workspace identity、native view overlay 和迁移冲突规则必须先修订。

## 2. 截图证据与判断

| 截图 | 可见事实 | 判断 |
|------|----------|------|
| `ScreenShot_2026-08-25_173640_254.png` | 左侧按渠道切换，右侧为该渠道模型；底部 trigger 同时显示渠道图标和模型名 | 应借鉴。CodePilot 已有 provider + model 共同选择，但缺少左 rail、搜索和收藏 |
| `ScreenShot_2026-08-25_173651_356.png` | 收藏视图展示可直接选择的模型项，行内保留渠道信息 | 应借鉴，但收藏键必须是 provider **实例** + model，而不是只存模型名 |
| `ScreenShot_2026-08-25_173713_931.png` | Reasoning、Context Window、Fast Mode 在一个菜单中，trigger 汇总为 `High · 1M` | 应借鉴“单 trigger、多 capability descriptor”，不能假设所有 provider 都支持同一组选项 |
| `ScreenShot_2026-08-25_173704_990.png` | 搜索跨模型工作，列表虚拟滚动，快捷键可快速选择 | 多 provider 场景下搜索有价值；收藏、最近和文本匹配需要明确排序规则。虚拟列表是否必需须以实际启用条目数和性能数据验证 |
| `ScreenShot_2026-08-25_173946_479.png` | 右侧空态用 Browser / Terminal / Files / Diff / Agents 卡片选择 surface | 适合 CodePilot 的空态 launcher；截图本身没有证明“项目级 pin”已实现 |

## 3. T3 源码核验

### 3.1 模型选择不是单纯按 provider kind 分组

- `apps/web/src/components/chat/ProviderModelPicker.tsx` 的 trigger 同时显示当前 provider instance 图标与模型。
- `apps/web/src/components/chat/ModelPickerSidebar.tsx` 左侧 rail 的单位是 provider **instance**，另有 favorites 入口。不可用 instance 仍会 disabled；现有 thread 锁定 provider 时，其他 provider 也可能显示“新开 thread 才能切换”。因此“整合后完全不再有置灰”并不成立，正确目标是把不可用原因放在渠道层，而不是让每个模型行重复置灰。
- `apps/web/src/components/chat/ModelPickerContent.tsx` 跨 provider 搜索、favorites、legacy 折叠与虚拟列表都在同一选择器内。
- `apps/web/src/modelOrdering.ts` 通过 `providerModelKey(instanceId, slug)` 建组合键。收藏设置也以 `{ provider: ProviderInstanceId, model }` 持久化，避免同名模型跨渠道串线。

### 3.2 参数菜单来自能力描述，不是写死的三段菜单

- `apps/web/src/components/chat/TraitsPicker.tsx` 调用 `packages/shared/src/model.ts`，把 reasoning、context window、fast mode 等 descriptor 渲染到同一菜单。
- trigger 只汇总当前模型实际可选的 descriptor；不支持的能力不出现。
- 这套模式值得借鉴的核心是“descriptor contract”，不是 `High · 1M` 这一条具体文案。

### 3.3 右侧 surface 有持久化，但未发现项目级 pin

- `apps/web/src/components/RightPanelTabs.tsx` 在空态提供 Browser、Terminal、Files、Diff、Agents 卡片。
- `apps/web/src/rightPanelStore.ts` 管理多个 browser/terminal/file surface，并按 thread key 持久化。
- 在右侧 panel store、tab 和 layout control 中未发现 `pin` / `pinned` 的项目偏好实现。项目级 pin 是用户提出的 CodePilot 产品扩展，不应归因于 T3 已有能力。
- T3 并非所有状态都按 thread：surface 列表按 thread，浏览历史按 project，站点数据按 environment partition，panel 宽度是全局状态。CodePilot 应按状态语义拆 scope，而不是复制单一持久化层级。

### 3.4 T3 内置浏览器的真实方案

T3 不是 iframe，也不是另起一个 Playwright Chromium：

- Web 层 `apps/web/src/browser/ElectronBrowserHost.tsx` 为每个浏览器 tab 托管一个 `apps/web/src/browser/HostedBrowserWebview.tsx`，后者渲染 Electron `<webview>`。
- `BrowserSurfaceSlot` 只负责测量 React 面板矩形，host 再用 fixed position 把 guest webview 覆盖到对应区域，从而绕过 webview 不能自然嵌进普通 DOM stacking 的问题。
- `apps/desktop/src/window/DesktopWindow.ts` 开启 `webviewTag`，并通过 `will-attach-webview` 强制 guest partition / preload / webPreferences。
- `apps/desktop/src/preview/BrowserSession.ts` 以 scope 哈希生成 `persist:t3code-preview-*` partition，处理缓存、站点数据、User-Agent 与权限策略。
- `apps/desktop/src/preview/Manager.ts` 在主进程注册 guest `webContents`，统一负责导航、favicon、诊断和 CDP。
- `apps/desktop/src/preview/PlaywrightInjectedRuntime.ts` 从 `playwright-core` 提取 selector runtime 后注入页面；Agent 可使用 role/text 等 locator，但没有启动第二个浏览器进程。
- T3 还包含 native guest 常见的补偿机制：guest 非激活时移到 `-100000` 离屏、把关键快捷键回传主窗口、重新附着时恢复独立 zoom，并对 crash 做退避恢复。CodePilot 的 `WebContentsView` POC 需要自行验证同类问题。

风险也必须一起看：T3 为页面内 React hook / 元素选择器让 guest `contextIsolation` 关闭，依赖 sandbox 阻断 Node 泄露。这是针对其预览/标注功能做的特殊取舍，不适合在 CodePilot 的“完整浏览器”里无条件照搬。

## 4. CodePilot 当前状态与差距

### 4.1 输入区

- [`ModelSelectorDropdown.tsx`](../../src/components/chat/ModelSelectorDropdown.tsx) 已经一次选中 provider + model，并按 provider 分组；也有最近模型，但没有搜索和收藏。
- 选择器会依据当前 Runtime 禁用不兼容模型。改造后应把“渠道不可用”和“当前 Runtime 不兼容”区分开，不能把所有 disabled 一概消掉。
- [`EffortSelectorDropdown.tsx`](../../src/components/chat/EffortSelectorDropdown.tsx) 只控制 reasoning effort；`context1m` 是独立 provider option，目前不具备统一 capability descriptor UI。
- [`ChatView.tsx`](../../src/components/chat/ChatView.tsx) 在输入框外的 [`ChatComposerActionBar.tsx`](../../src/components/chat/ChatComposerActionBar.tsx) 放置 Mode、Runtime、Permission 和 RunCockpit，正是用户认为冗余的第二条控制栏。
- Mode 不是纯展示风格：Claude `plan` 映射 SDK `permissionMode:'plan'`，Native 只装配 safe-read 工具，Codex 使用 read-only sandbox。它是跨 Runtime 的硬权限边界。
- schema 还接受 `ask`。当前 composer 只露出 Code / Plan；Bridge 将 `ask` 解释为更强确认，主聊天发送链没有同等独立入口。实现前必须盘点存量 `ask` session / binding，不能只迁移 code/plan。

### 4.2 侧边栏

- [`workspace-sidebar.ts`](../../src/lib/workspace-sidebar.ts) 已有 Git / Widget 固定 tab，以及 markdown、artifact、file、`files-pinned`、agent-run 动态 tab。
- [`AppShell.tsx`](../../src/components/layout/AppShell.tsx) 仍允许 FileTree Panel 与 Workspace Sidebar 并存，因此会出现两个右栏。
- FileTree 的“Pin”会将其转成 `files-pinned` tab，但当前持久化绑定 `workingDirectory + sessionId`，不是用户描述的项目级默认模块偏好。
- 当前 PreviewPanel 负责文件 / Artifact 预览，不是 live browser；浏览器应新增 surface，不能拿 live page 语义覆盖现有 artifact preview。
- 双栏不是偶然残留：v13 专门允许它们叠加，让用户在 FileTree 中浏览并持续在另一栏查看 preview。单侧栏方案必须保留这条任务路径，只改变外壳与空间管理方式。

## 5. 推荐产品方案

### 5.1 Composer：单一输入容器

输入框 footer 从左到右建议为：

`[添加/工具] [渠道图标 + 模型] [能力摘要] [Runtime] [权限] …… [运行状态] [发送]`

规则：

1. 模型选择 trigger 使用“provider instance 图标 + model display name”；弹层左 rail 展示收藏与渠道实例，右侧展示可搜索模型。
2. 收藏结构定义为：

   ```ts
   interface ModelRouteFavorite {
     providerInstanceId: string;
     modelId: string;
   }
   ```

   收藏的是可执行 route，不是裸模型名。provider 删除、未登录、Runtime 不兼容时仍可在收藏里看见，但必须展示真实原因和恢复入口。
3. 排序顺序：精确文本匹配 > 高质量前缀/模糊匹配 > 收藏加权 > 最近使用 > provider catalog 原序。收藏加权不能压过更准确的文本匹配。
4. 参数菜单由统一 descriptor 驱动：

   ```ts
   interface ModelOptionDescriptor {
     id: string;
     kind: 'select' | 'boolean';
     label: string;
     options?: Array<{ value: string; label: string }>;
     defaultValue: string | boolean;
     scope: 'thread' | 'turn';
     support: {
       state: 'selectable' | 'fixed' | 'unsupported' | 'unknown';
       runtime: string;
       protocol: string;
       modelIds: string[];
       fixedValue?: string | boolean;
       source: string;
     };
   }
   ```

   只有 `support.state === 'selectable'` 的参数才能显示为控制项。`fixed` 表示该模型的有效值恒定，只能作为信息展示或直接省略。例如默认已经是 1M 的模型不能再显示一个可切换但无实际效果的 1M 开关。catalog 中的静态 `contextWindow` 容量是信息，不等于用户可选的 200K / 1M；不能为了复刻 UI 制造假选项。
5. 移除的是独立的 `ModeIndicator`，不是 Plan 能力。Permission 选择器建议统一成四个用户可理解的档位：`只读规划`、`需要时询问我`、`替我审批`、`完全访问`。其中 `只读规划` 必须继续映射现有跨 Runtime 的 plan wire：Claude SDK plan、Native safe-read tools、Codex read-only sandbox；计划 prompt / artifact 只是补充，不能替代硬权限。
6. 兼容与迁移必须 fail-closed：

   - 旧 `session.mode='plan'` 打开时，Permission 显示 `只读规划`，发送仍保持只读；只有用户在 Permission 选择器中显式改档才允许离开只读，禁止默认回落到 code。
   - `ask` 不是 composer 当前可达选项，但仍存在于 session / Bridge schema。实现前先统计其来源和使用量；Bridge 的 ask 语义继续保留，主聊天遗留 ask 至少映射到“需要时询问我”，不得迁成更宽权限。
   - 第一阶段保留 `mode` 字段和现有 wire precedence，并通过 UI adapter 把 mode/profile 映射为统一权限档位；等迁移证据、真实 Runtime wire 测试和旧 session smoke 完成后，再评估 schema 收敛。
7. Runtime、Permission 和 Run 状态迁入输入框内部。权限始终显式可见；低频诊断仍留在 RunCockpit popover，不把原本解释性信息全部塞进 footer。

### 5.2 Sidebar：workspace pin + thread surface

用一个 `SurfaceRegistry` 统一定义模块：

```ts
type SurfaceKind =
  | 'files'
  | 'git'
  | 'widget'
  | 'browser'
  | 'agents'
  | 'diff'
  | 'artifact'
  | 'file-preview';

interface SurfaceRegistration {
  kind: SurfaceKind;
  title: string;
  icon: string;
  pinnable: boolean;
  availability: (context: SurfaceContext) => Availability;
}
```

布局不是“所有 surface 只能占同一个 tab 内容区”，而是一个外壳内的两种 lane：

- **Primary lane**：Files、Git、Widget、Browser、Agents 等 pinned / active module。
- **Inspector lane**：文件、Markdown、Artifact、Diff detail 等由 Primary 临时打开的预览。

Files 被选中时，点击文件必须保持树可见，并在同一外壳右侧打开可调整宽度的 Inspector；关闭 Inspector 后树恢复全宽。空间不足时 Inspector 可以变成外壳内的 peek/overlay，并提供明确返回 Files 的入口。只有这条替代交互通过真实用户路径验证后，才允许删除两个独立右栏并存的 v13 路径。

#### Workspace Identity

不能直接使用原始 `workingDirectory` 字符串。定义 `canonicalWorkspaceKey`：

1. 先用 `resolvePathIdentity(...).comparisonKey` 合并 symlink、尾斜杠、大小写等路径变体。
2. Git 项目再解析绝对 `git common dir`，以其 path identity 作为 repository key；同一仓库的主 worktree 与 linked worktree 共享 pinned modules 和默认 browser partition。
3. 非 Git 文件夹退回目录本身的 `comparisonKey`。两个独立 clone 即使 remote 相同也不共享，避免意外串联本地偏好和登录态。
4. thread surface 仍绑定 session；其中 file path 保持各 worktree 自己的绝对路径，不把不同 worktree 的预览文件混在一起。

状态分两层：

- `WorkspaceSurfacePreferences`：按 `canonicalWorkspaceKey` 保存 pinned kinds、顺序、默认 active kind、sidebar 宽度和开合状态。
- `ThreadSurfaceState`：保存当前会话临时打开的 browser tabs、file previews、diff 和 agent run，不污染项目默认 pin。

打开项目时：

- 有 pinned modules：打开同一个 sidebar，恢复 tab 顺序并选中上次 active；“默认展开”解释为这些模块默认存在且 sidebar 展开。Primary + Inspector 可以在一个外壳内同时出现，但不会再创建两个彼此独立的 sidebar shell。
- 无 pinned modules：展示 3–5 张上下文卡片。默认候选 Files、Git、Browser；有改动时加 Diff，有 sub-agent 时加 Agents，无 Git 时 Git 卡显示 Initialize Git。
- 任意模块都可 pin / unpin；临时关闭不等于取消 pin，必须用独立操作避免误删偏好。

迁移建议：

- 首次升级把现有固定 Git / Widget 作为默认 pinned，避免已有用户突然得到空侧栏。
- 同一 `canonicalWorkspaceKey` 下只要任一旧 `workingDirectory + sessionId` 桶曾有 `files-pinned`，workspace-level `files` 就视为 pinned；冲突采用布尔 OR，不依赖“最后打开哪个 session”这一不稳定顺序。
- markdown / artifact / file 继续作为 thread inspector surface。`agent-run` 当前本来就不写 localStorage，迁移后维持“运行时可见、重启后由持久消息按需重建”的既有行为，不承诺迁移不存在的 tab 记录。
- 先迁移偏好、上线 Primary + Inspector 并通过 smoke，再清理重复 FileTree Panel 入口；任何阶段都不能同时渲染两个文件树。

### 5.3 Browser：主进程拥有的 `WebContentsView`

Electron 官方已经不推荐把 `<webview>` 当长期默认嵌入方案，并建议考虑 iframe 或 `WebContentsView`；`BrowserView` 自 Electron 29 起已废弃。因此 CodePilot 建议：

1. 主进程新增 `BrowserSurfaceManager`，拥有 `WebContentsView`、tab lifecycle、navigation、session partition、downloads、permissions 和 crash recovery。
2. renderer 只渲染 browser chrome 与占位 slot，通过窄 IPC 上报边界矩形；主进程更新 view bounds。不要把任意 `webContents` 对象或无限制 `executeJavaScript` 暴露给 renderer。
3. CodePilot 没有 T3 的 environment 实体。partition 明确定义为 `persist:codepilot-browser-<hash(canonicalWorkspaceKey + browserProfileId)>`；首期只有 `browserProfileId='default'`。同仓库 worktree 共享登录态，不同 repository/non-Git workspace 隔离；“清除站点数据”必须显示并只清除此 partition scope。
4. guest 固定 `sandbox: true`、`nodeIntegration: false`、`contextIsolation: true`。若后续元素选择器确需 page-world 注入，单独做威胁模型，不以关闭隔离作为默认前提。
5. URL 策略：远端默认 HTTPS；HTTP 仅允许 localhost / loopback / 用户明确确认的 host；拒绝 `file:`、`javascript:` 和未登记自定义 scheme。新窗口、下载、权限请求与外部打开全部经过主进程策略。
6. MVP chrome：地址栏、后退/前进、刷新/停止、tab、新开/关闭、localhost 端口发现、响应式 viewport、在系统浏览器打开、清缓存。
7. Agent 浏览器操作放到后续阶段：主进程通过 `webContents.debugger` / CDP 提供 snapshot、click、type、press、scroll、wait；可研究 T3 注入 Playwright selector runtime 的方式，但先不复制录屏、标注、React grab 等扩展。
8. `WebContentsView` 是 native view，会盖在 renderer DOM 之上。全局 dialog、dropdown、command palette、toast 或侧栏 peek 与其相交时，必须由统一 overlay coordinator 暂时隐藏、移除、移到离屏，或显示安全截图替身；具体策略由 POC 决定，不能让每个弹层自行打补丁。
9. T3 没有可直接复用的 `will-download` 产品实现。CodePilot 的下载目录、文件名冲突、危险类型、进度、取消与完成 receipt 需要独立设计，不能把“源码可参考”当作完成度。

为什么不是 iframe：完整浏览器需要跨站登录、导航、权限、下载、localhost 与独立 session，iframe 会受 CSP / X-Frame-Options 和同源策略限制。为什么不直接复制 `<webview>`：Electron 官方提示其架构稳定性风险，且 CodePilot 当前没有开启 `webviewTag`，选择它会扩大 renderer-facing attack surface。

## 6. 分阶段路线

### Phase 1：Composer 收口

- 新模型 picker：搜索、收藏、provider-instance rail、键盘导航、虚拟列表。
- 新 capability descriptor：先覆盖已验证 effort；context 只接 per-runtime + per-protocol + per-model 已验证且实际可变的 provider option。
- 先做 legacy mode POC：构造 `plan` / `ask` session，记录 Claude / Native / Codex 的 effective permission wire。
- Runtime / Permission / Run 状态迁入输入框；移除独立 Code / Plan 控件，把 Plan 作为 `只读规划` 权限档位并保留兼容状态。
- 更新 `ComposerModelSelection.md` 与 Runtime / Permission 相关 guardrail。

### Phase 2：单 Sidebar 与 pin

- 引入 surface registry 和双层状态。
- 先实现并验证同一外壳的 Primary + Inspector：FileTree 点击文件时树保持可见、预览在 Inspector 打开。
- 定义 `canonicalWorkspaceKey`，覆盖主目录/worktree/symlink/尾斜杠；再迁移 Git / Widget / files-pinned。
- 增加 launcher cards、pin/unpin、恢复与跨项目隔离测试；替代交互通过后才删除 FileTree 与 Workspace Sidebar 两个独立 shell 的并存路径。
- 更新此前“两个右栏可并存”的架构说明和完成计划。

### Phase 3A：Browser 技术 POC

- 只做一个 `WebContentsView` tab，验证 bounds 同步、窗口缩放、全屏、焦点、中文输入法、透明/vibrancy、macOS/Windows/Linux 打包表现。
- 专门验证 native z-order：在 browser 区域上方打开 dialog、dropdown、command palette、toast 和 Inspector peek，确认统一隐藏/离屏/移除/截图替身策略不会闪烁、吞焦点或泄漏交互。
- 验证 guest 与主窗快捷键仲裁、独立 zoom 恢复、crash 退避恢复，以及 browser view 隐藏期间的音频和自动化状态。
- 验证 partition、导航拦截、permission handler、new-window、下载、crash/reload 和清站点数据。
- 结论必须是实机 smoke 记录；POC 不直接变成正式能力。

### Phase 3B：Browser MVP

- 接入 surface registry、多 tab、浏览器 chrome、localhost 发现和持久化。
- 增加 main-process capability contract、IPC schema 和安全回归。
- 更新 `ElectronMain.md` / `PermissionBoundary.md`，补 packaged smoke ledger。

### Phase 4：Agent Browser（可选）

- CDP automation + 可访问性 snapshot + selector runtime。
- 每次操作带 thread/tab identity、权限归属、timeout、取消和 receipt。
- 标注/录屏/React component grab 作为独立能力评估，不与 Browser MVP 捆绑。

## 7. 验收门禁

### 模型与输入区

- 收藏同一 model ID 的两个 provider instance 后，可分别一键选择正确 route。
- provider 未登录、删除或与 Runtime 不兼容时，收藏项显示真实状态和恢复动作，不产生假成功。
- 搜索支持模型名、provider 名与别名；键盘、屏幕阅读器、focus restore 和大目录滚动通过。
- 仅显示 per-runtime + per-protocol + per-model 真实 wire 支持且可变的 reasoning/context/fast 选项；恒真/固定参数不渲染假开关。切换模型后无效旧值被显式归一化，并显示 effective value。
- 移除独立 Mode 控件后，旧 `plan` session 继续显示 `只读规划`；发送后 Claude 实收 SDK plan、Native 只装配 safe-read、Codex 实收 read-only sandbox，任何 Runtime 都不得静默扩大权限。
- 旧 `ask` session / Bridge binding 的迁移有来源盘点和显式规则；至少不得比迁移前更少询问。

### 侧边栏

- pin 按 `canonicalWorkspaceKey` 生效：同仓库主目录与 worktree 按既定决策共享，不同 clone / non-Git workspace 互不串线；symlink、尾斜杠与大小写变体合并。
- 临时 surface 按 thread 恢复；关闭临时 tab 不影响 workspace pin。
- 无 pin 时出现 launcher；有 pin 时 sidebar 打开且恢复 active tab。
- Files 中点击文件时 Files Primary 保持可见，preview 在同一外壳 Inspector 打开；关闭 preview 后仍回到原树位置和选择。
- 升级迁移不会同时显示两个文件树，也不会丢失现有 artifact/file tab；运行中 `agent-run` 维持现有“不直接持久化、从消息按需重建”的行为。
- 同 workspace 多个旧 session 对 `files-pinned` 有冲突时按布尔 OR 合并，迁移结果确定且可重复执行。

### 浏览器

- guest `WebContentsView` compromise 不能取得 Node、文件系统或未授权主进程 IPC 能力。主窗 renderer 当前未启用 `sandbox:true`，是否收紧属于独立安全评估，不能混入 Browser MVP 后假装已经满足。
- 不安全 scheme、未经允许的外部导航、新窗口与权限请求被 fail-closed 拒绝。
- tab identity / `canonicalWorkspaceKey + browserProfileId` partition 不串线；清站点数据只影响 UI 明示的 scope。
- guest crash、主窗口 resize、sidebar resize、项目切换和 app 重启后均可恢复到真实状态。
- 任意全局 overlay 与 native browser view 相交时不被遮挡；关闭 overlay 后 view 的焦点、zoom、音频和页面状态正确恢复。
- macOS / Windows / Linux packaged smoke 覆盖输入法、焦点、缩放、下载与 localhost；未跑到的平台不能标记完成。

## 8. 不建议照搬

- 不把“渠道整合”解释成完全取消 disabled；unavailable provider / runtime incompatibility 仍需诚实呈现。
- 不把 catalog context capacity 当成用户可修改的 context option。
- 不把 Plan 当成可由 prompt 代替的文案模式；它是权限边界。
- 不复制 T3 guest `contextIsolation: false` 作为默认浏览器配置。
- 不使用已废弃的 `BrowserView`。
- 不在 Browser MVP 同时承诺 Agent automation、标注、录屏和组件抓取。
- 不把 T3 的 thread-persisted surface 误写为已有的 project pin。
- 不在 Primary + Inspector 替代交互验证前删除 v13 双栏路径。

## 9. 外部依据

- Electron `<webview>` 文档：https://www.electronjs.org/docs/latest/api/webview-tag
- Electron Security：https://www.electronjs.org/docs/latest/tutorial/security
- Electron `WebContentsView`：https://www.electronjs.org/docs/latest/api/web-contents-view
- Electron `BrowserView`（deprecated）：https://www.electronjs.org/docs/latest/api/browser-view

## 10. 后续文档影响

若用户确认进入实现，先创建执行计划，不直接在本调研文档里跟踪代码进度。执行计划必须同步覆盖：

- `docs/insights/chat-composer-redesign.md` 的“无搜索”旧判断；
- `docs/exec-plans/completed/workspace-sidebar-tabs.md`、`refactor-phase-3-background-tasks-notifications.md` 与 `refactor-closeout.md` 中的双栏决策日志，增加“被 2026-08-25 方案以 Primary + Inspector 替代”的 breadcrumb；
- `ARCHITECTURE.md` 与 `AppShell.tsx` 的 v13 布局说明；
- `docs/guardrails/ComposerModelSelection.md`；
- `docs/guardrails/Runtime.md`；
- `docs/guardrails/PermissionBoundary.md`；
- `docs/guardrails/ElectronMain.md`。
- i18n 已存在但未引用的 `composer.searchModels`：实现时复用或清理，避免创建第二套 key。

## 11. 独立审查吸收记录

| Finding | 处理 | 方案变化 |
|---------|------|----------|
| P1-1 Plan 静默权限升级 | 接受 | 独立 Mode 控件可移除，但 Plan 并入 `只读规划` 权限档位；旧 plan session fail-closed，新增三 Runtime wire 验收 |
| P1-2 v13 工作流回退 | 接受 | 单一外壳增加 Files Primary + preview Inspector；替代交互验证前不删 v13 路径 |
| P2-1 workspace/worktree identity | 接受并具体化 | Git common-dir repository key；non-Git fallback path comparison key；worktree 共享 pin/partition，thread file state 不共享 |
| P2-2 native view overlay | 接受 | POC 增加 z-order、全局 overlay、快捷键、zoom、crash、音频/焦点恢复 |
| P2-3 partition scope | 接受 | 固定为 `canonicalWorkspaceKey + browserProfileId`，不引入 CodePilot 不存在的 environment 实体 |
| P2-4 迁移冲突 / agent tab | 接受 | `files-pinned` 多桶按 OR 合并；agent-run 按现状不直接持久化 |
| P2-5 ask mode | 接受 | 增加来源盘点、Bridge 保留和不扩大权限的迁移门禁 |
| P3-1 搜索理由 | 接受并补证据 | 恢复旧决策完整理由；补 shipped catalog 29 presets / 121 preset-model rows，实际启用数仍待运行时测量 |
| P3-2 descriptor 粒度 | 接受 | support 改为 runtime + protocol + model 粒度，并区分 selectable / fixed / unsupported / unknown |
| P3-3 renderer 安全全称命题 | 接受 | 门禁限定 guest WebContentsView；主窗 sandbox 另列安全评估 |
| P3-4 / P3-5 文档与布局勘误 | 接受 | 扩大后续文档清单；不依赖 AppShell 注释中的 inner/outer 顺序描述产品结构 |

修订后仍未解决、必须由执行计划前置 POC 回答的只有三类：`WebContentsView` 在透明/vibrancy 和三平台下的真实表现、Primary + Inspector 的可用宽度/窄屏退化、当前用户实际启用的模型条目数与虚拟列表必要性。它们都不能由源码形状直接升级为“可生产”。
