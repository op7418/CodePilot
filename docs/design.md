---
name: CodePilot
description: Multi-model AI Agent desktop client. Settings shell — bordered cards, inset dividers, charcoal monochrome accent.
version: 0.2-settings-providers-models
colors:
  primary: "#252525"
  primary-foreground: "#FAFAF9"
  background: "#FFFFFF"
  foreground: "#1A1816"
  card: "#FFFFFF"
  card-foreground: "#1A1816"
  muted: "#F0EEEB"
  muted-foreground: "#857F75"
  accent: "#F0EEEB"
  border: "#E6E1DB"
  border-soft: "#E6E1DB80"        # border-border/50 — the default for display cards
  input: "#E6E1DB"
  ring: "#252525"
  destructive: "#DC2626"
  status-success: "#16A34A"
  status-success-muted: "#DCFCE7"
  status-warning: "#EA580C"
  status-warning-muted: "#FFEDD5"
  status-error: "#DC2626"
  status-error-muted: "#FEE2E2"
typography:
  page-title:
    family: Geist
    size: 0.875rem               # text-sm
    weight: 500
  section-label:
    family: Geist
    size: 0.6875rem              # text-[11px]
    weight: 500
    transform: uppercase
    tracking: wider
    color: muted-foreground
  body:
    family: Geist
    size: 0.8125rem              # text-[13px]
    weight: 400
  caption:
    family: Geist
    size: 0.6875rem              # text-[11px]
    weight: 400
    color: muted-foreground
  meta:
    family: Geist
    size: 0.625rem               # text-[10px]
    color: muted-foreground
rounded:
  sm: 4px                        # rounded-sm — segmented control inner buttons
  md: 6px                        # rounded-md — sub-cards, icon containers, image-family rows
  lg: 8px                        # rounded-lg — outer display cards (canonical card radius)
  full: 9999px                   # status pills, dot indicators
spacing:
  page:
    container: max-w-4xl mx-auto
    section-gap: 40px            # space-y-10  — between top-level sections
    block-gap: 24px              # space-y-6   — within a section
    row-gap: 12px                # space-y-3   — header → grid
  card:
    padding: 20px                # p-5
    inner-gap: 16px              # gap-4 (column)
  inset-divider-padding: 20px    # px-5 inside the wrapper that hosts `divide-y` so dividers don't touch the rounded edge
---

# CodePilot Settings Design

Concrete patterns extracted from `Settings > Providers` and `Settings > Models`. Anything in here is implemented and shipping; treat it as the canonical surface for new Settings work.

## Token 分类（产品 token vs 平台 token）

CodePilot 的 CSS token 分两层。本节是项目级原则，虽然 design.md 主要服务 Settings，但 token 分类规则对所有 UI 改动都适用。任何引入新 token 或改 token 用法的 PR 在 review 时必须能回答"这是产品 token 还是平台 token"。

### 产品 token —— 跨平台一致

声明位置：`src/app/globals.css` `:root` / `.dark`，以及 `themes/*.json`。

涵盖：
- 色板：`--background` / `--foreground` / `--card` / `--popover` / `--sidebar` / `--muted` / `--accent` / `--border` / `--primary` 等
- 圆角：`--radius`（产品组件圆角，目前 `1rem`）— 注意 design.md 顶部 frontmatter 仍以 8px 作为 outer card 的画板规范；个别 card 仍按本规范的 `rounded-lg` 处理
- 状态色：`--status-success-*` / `--status-warning-*` / `--status-error-*` / `--status-info-*`
- 字体：`--font-geist-sans` / `--font-geist-mono`
- Terminal / 代码块、Composer shadow、Context dot 等业务专用 token

**用在**：组件内层（按钮、表单字段、表格、内容卡片、对话框 body、消息气泡）。

### 平台 token —— 仅在 macOS profile 当前注入

声明位置：`src/app/globals.css` 的 `:root` / `html[data-platform="darwin"][data-platform-style="auto"]`。

前缀：`--platform-*`。当前可用 token：
- `--platform-font-ui` —— chrome UI 字体（默认 Geist；macOS 切到 SF/system-ui 栈）
- `--platform-radius-window` / `--platform-radius-control` —— 窗口和控件圆角
- `--platform-hover-alpha` —— 壳层 hover 强度（默认 1，macOS 软化到 0.7）
- `--platform-surface-sidebar` / `--platform-surface-bar` / `--platform-surface-popover` / `--platform-surface-hud` / `--platform-surface-tooltip` —— 壳层与浮层表面
- `--platform-border-subtle` —— chrome 边缘细线

**用在**：窗口 chrome / 顶栏 / 侧栏 / Composer 外壳 / Popover / Menu / HUD / Tooltip 这类"壳层 + 浮层"。

### 决策规则

| 你要改的元素 | 用哪一层 |
|--------------|----------|
| 按钮、输入框、表单字段、表格、内容卡片、对话框 body | 产品 token |
| 顶栏、侧栏、Composer 外壳、Popover/Menu/HUD/Tooltip 的表面材质 | 平台 token |
| 圆角：组件圆角 | `--radius`（产品） |
| 圆角：窗口/侧栏外框 | `--platform-radius-window`（平台） |
| 字体：正文 / 代码 | `--font-geist-sans` / `--font-geist-mono`（产品） |
| 字体：chrome UI（菜单、状态栏） | `--platform-font-ui`（平台） |

### 平台 token 行为约定

- 平台 token 默认值等价于对应的产品 token —— 引入平台 token 层本身**不产生视觉 diff**。
- macOS 覆盖只在 `html[data-platform="darwin"][data-platform-style="auto"]` 生效。其它平台或 `data-platform-style="neutral"` 时，平台 token 仍 fall back 到默认（= 产品 token 等价值）。
- **平台 token 不允许出现在内容层**（Apple HIG: Liquid Glass 用于 controls / navigation，不用于 content）。如果在 PR 里看到 `--platform-surface-*` 被绑定到内容卡片，直接 reject。

参考：[`docs/exec-plans/active/phase-7b-macos-native-visual-profile.md`](exec-plans/active/phase-7b-macos-native-visual-profile.md) / [`docs/handover/macos-visual-profile.md`](handover/macos-visual-profile.md)。

## 图标语义（CodePilot Icon Layer）

> 完整 semantic alias 字典 + HugeIcons 候选 + 冲突裁决决策日志见 [`docs/handover/icon-system.md`](handover/icon-system.md)；产品理由见 [`docs/insights/icon-system.md`](insights/icon-system.md)。本节只给 design 层的使用规则。

业务代码用 `<CodePilotIcon name="..." />` 表达**产品概念**，不直接 import vendor icon 名。一个概念对应一个 glyph，由 `src/components/ui/semantic-icon.tsx` 的 `SEMANTIC_MAP` 单点裁决。

**已裁决的冲突（不要回退）：**

| 概念 | glyph | 说明 |
|------|-------|------|
| `model` | Cube | Brain 让给 `memory`，不再表示模型 |
| `runtime` | Chip | Lightning 已退役 |
| `memory` | Brain | 记忆才是"脑" |
| `cli` | CommandLine | 命令工具目录，**不等于** `terminal` |
| `terminal` | Terminal | shell 会话，**不等于** `cli` |
| `skill` | MagicWand | 可调用能力，**不等于** `plugin` |
| `plugin` | Puzzle | 安装包 / 容器，**不等于** `skill` |

**规则：**
- **品牌图标用 LobeHub**（Anthropic / OpenAI / OpenRouter / Kimi …），只出现在 provider / runtime brand 场景；不得用通用 glyph 伪装品牌。
- **尺寸 token**：`sm`(14) toolbar / `md`(16) inline-row 默认 / `lg`(20) card header / `xl`(24) empty state。优先用 token，raw 数字是 escape hatch。
- **颜色**：默认 `text-muted-foreground`（次要 affordance，不与相邻文字标签抢注意力）；anchor（左栏 / 侧栏快捷动作 / Settings 左导航）和 active/selected 才用 `text-inherit` 跟随父级深色；状态图标走 `--status-*`。
- **只用 CodePilotIcon 语义层**：业务组件不直引 Phosphor / Lucide（eslint 守卫：Brain/Lightning/Terminal 名导入 error；Phosphor/Lucide 直引重定向到 CodePilotIcon）。结构性图标（CaretDown / CheckCircle / X 等 53 个）暂留 `ui/icon.tsx` 兼容层。

设计系统页 `/design-system` 的 "Icon Semantics" 区有可视样例。

## macOS 壳层 profile（platform shell）

> 完整 surface matrix + Electron vibrancy 选型 + 分层依据见 [`docs/handover/macos-visual-profile.md`](handover/macos-visual-profile.md)；产品理由见 [`docs/insights/macos-visual-profile.md`](insights/macos-visual-profile.md)。本节只给 design 层的边界规则。

**一句话边界**：macOS profile 只动**外壳和控件层**，不动内容层。同一套产品结构（聊天 / Settings / 卡片 / 消息 / Widget / 按钮顺序）在 mac / win / linux / web 上完全一致，不开平台分支。

**用户能看到的差别（仅 macOS）：**
- 窗口是无边框圆角悬浮，红绿灯按钮嵌在左上，顶栏可拖动。
- 侧栏 / 顶栏 / 浮层（菜单、tooltip、HUD）半透明，透出背后桌面的模糊（vibrancy）。
- 内容区（聊天正文、代码、Settings 卡片、Widget）**保持不透明**——阅读画布不做玻璃化。

**哪些层允许平台化（其余一律不动）：**

| 层 | 允许 | 例子 |
|---|---|---|
| chrome（窗口 / 顶栏 / composer 外壳） | 半透明 + vibrancy | 顶栏、composer hood |
| navigation（左右侧栏） | 半透明 + backdrop-blur | ChatListPanel / SettingsSidebar / WorkspaceSidebar |
| floating control（浮层） | CSS 材质模拟 | Popover / Menu / Tooltip / RunCockpit HUD |
| **content（内容）** | **不透明、跨平台一致** | 聊天正文、代码、卡片、Widget、Dialog 正文 |

**规则：**
- **内容层永远不透明**。玻璃化内容会毁掉可读性和 artifact 保真；Dialog 正文 / 卡片 / 消息一律实色（`bg-background` / `bg-card` / `bg-popover`）。
- **DOM 浮层只是 CSS 材质模拟**，不是真原生 vibrancy。Electron 的 `vibrancy` 是窗口级（`titleBarStyle: 'hiddenInset'` + `vibrancy: 'sidebar'`）；Radix popover / tooltip / RunCockpit 这些 DOM 面在 webview 里裁剪，不要宣称"原生 popover 行为"。
- **平台差异一律走 `--platform-*` token，不在组件里写 `isMac` 分支**（见上方「平台 token」节）。darwin profile 把 `--platform-surface-bar` 设 `transparent`、`--platform-surface-sidebar` 设半透明，让 vibrancy 透上来；off-mac 这些 token 退回实色，同一份 DOM 直接当普通块渲染。
- **顶栏保留拖动区 + 红绿灯安全间距**；嵌套按钮要标 `no-drag`。

实现路径（实现者）：profile 由 `data-platform` / `data-platform-style`（anti-FOUC `<script>` 在 hydration 前盖到 `<html>`）驱动；token 在 `globals.css` 的 darwin profile 块（`--platform-surface-*`）；Electron 窗口在 `electron/main.ts`。

## 浮动卡片布局（floating card shell）

> 抽象边界 + 四卡接入点 + gutter 几何验收见 [`docs/handover/macos-visual-profile.md`](handover/macos-visual-profile.md) 的 Phase 7c 节。

macOS profile 下，外壳是**几张悬浮卡片**并排：左侧栏 / 主聊天 / 右工作区 / 文件树（assistant rail 复用同一套 primitive）。每张卡圆角 14px、独立投影、卡间留窄缝（缝里一条可拖拽细线调宽）。off-mac 圆角归 0、退回普通分栏块——同一份 DOM。

**用户能看到的：**
- 几块内容像浮在窗口里的卡片，彼此有缝、有投影。
- 缝中间一条 2px 细线，悬停时跟着光标亮起渐变，拖动改相邻两卡宽度，双击重置。
- 缝永远落在两卡正中（不偏移）。

**三个 primitive（职责单一，不许串味）：**

| primitive | 干什么 | 不许干 |
|---|---|---|
| `CardFrame` | 投影 + 圆角 + 布局槽位（`kind="main"` 吃 `flex-1`，其余 `shrink-0` + 固定宽） | 裁剪（必须 overflow visible 让投影画全） |
| `CardSurface` | 背景 + clip-path 圆角裁剪 + backdrop-filter + 内容槽位 | 画外层投影（那是 frame 的事） |
| `ResizeGutter` | 8px 宽 row-level 兄弟，2px 线靠 `justify-center` 永落缝中心 | 出现在 CardFrame 内部 |

**规则：**
- **frame 画影、surface 裁剪、gutter 调宽**——三件事分给三个组件；不要在一个 div 上又投影又裁剪（投影会被自身 `overflow:hidden` 切掉）。
- **ResizeGutter 永远是 CardFrame 的兄弟、不是孩子**。卡间可见缝全部由 gutter 的 8px 宽度提供（content-row gap 设 0），隐藏的卡旁边不留多余缝。
- **半透明只给 sidebar / workspace kind**（backdrop-blur + `--platform-surface-sidebar`）；main / fileTree / assistant 不透明（`bg-background`）。
- **宽度 state 留在业务面板**，primitive 只收 `width` prop + 转发 `onResize` 回调；面板组件（ChatListPanel 等）只出内层内容，不再自己 wrap aside / data-attribute / bg / clip。
- 约束被 `card-primitives.test.ts` 的 source pin 锁死，别绕过。

实现路径（实现者）：`src/components/layout/card-primitives.tsx`；圆角 14px / clip-path 在 `globals.css` darwin profile（off-mac radius 0、clip no-op）；四卡接入点 = `AppShell.tsx`(sidebar) / `ChatContentRow`(main + workspace) / `PanelZone`(fileTree)；`RESIZE_GUTTER_WIDTH_PX = 8`。

## Composer（聊天输入外壳）

> composer 属 chrome 层，macOS profile 下透出 vibrancy；surface matrix 见 [`docs/handover/macos-visual-profile.md`](handover/macos-visual-profile.md)。

聊天输入框是一个**悬浮 hood**：顶部一排已选上下文胶囊（文件 / CLI / 目录引用），中间多行文本框，底部一排操作（左侧加料 + 模型 / effort 选择，右侧发送）。

**用户能看到的：**
- 输入区像浮在聊天底部的一块面板（macOS 下半透明、透出背后模糊）。
- 添加的附件 / CLI / 目录引用以胶囊排在文本框上方，可单独删。
- 底部左边是「加料」菜单（插入命令 / 调用 CLI / 加上下文）+ 模型选择 +（模型支持时）effort 选择；右边是发送按钮。

**规则：**
- **外壳走平台 token**：`bg-[var(--platform-surface-bar)] backdrop-blur-lg`。default profile 该 token = 实色 `--background`；darwin = `transparent`，让 vibrancy 透过 composer hood。文本框本身保持清晰，**不要**在文字输入区堆模糊（伤打字专注）。
- **可调控件安静优先**：模型 / effort 这类下拉默认无边框无填充，hover 或处于非默认值时才浮出结构（见 `feedback`：composer 控件 invisible-until-hover）。右侧发送是唯一常驻强调的动作。
- **工具图标走语义层**：`<CodePilotIcon name="code" />` / `name="cli"` 等，不直引 vendor icon（见「图标语义」节）。
- **运行状态（Runtime / Auto / Context 占用）不在 composer 里**——由 ChatView 级的状态读出（`RuntimeSelector` / `ModeIndicator` / 上下文 popover）承担。composer 只管「写什么 + 发送」，只读状态归状态区，别混进输入栏。

实现路径（实现者）：`src/components/chat/MessageInput.tsx`（外壳 + footer），`MessageInputParts.tsx`（胶囊行），`ModelSelectorDropdown` / `EffortSelectorDropdown`；运行状态读出在 `ChatView.tsx`（`ModeIndicator` / `RuntimeSelector`）。

## Page shell

Every Settings sub-page uses the same outer container:

```tsx
<div className="max-w-4xl mx-auto space-y-10">
  <Section />
  <Section />
</div>
```

- **`max-w-4xl`** = 896px for config pages; **`max-w-5xl`** = 1024px for **Overview** (it carries a 2-col card grid + a 365-day heatmap and needs the extra width). Page list: **Overview** / General / Appearance / Providers / Models / Runtime / Usage / Assistant / **About**. Overview at the top is a *status dashboard*, not a config page — three layers: (1) a "Getting started" checklist that auto-hides once 4/4 items are done (provider connected / models enabled / runtime verified / workspace configured); (2) a 2-col grid of 6 status cards — Runtime / Providers / Models / Assistant Workspace / Update & About / Setup & Diagnostics — where attention-needed cards pick up `status-warning-muted` accent and configured cards stay flat (so the page reads as a status dashboard, not a wall of black tiles); (3) GitHub-contribution-style token-usage heatmap with 30/90/365D range pills + total / most-active day / longest streak / current streak summary. About at the bottom carries version + update check + platform info + account + diagnostics + external links. The middle stays the three-layer mental model: Providers (assets) → Models (exposure) → Runtime (environment). General is strictly application behavior; visual customization is its own page (Appearance).
- **`mx-auto`** centers horizontally. Don't left-align.
- **`space-y-10`** (40px) between top-level sections gives Luma-style breathing room.
- Within a section: `space-y-6` (24px) for header → body, `space-y-3` (12px) for sub-blocks.

## Card system

The single rule for display cards:

```tsx
<div className="rounded-lg bg-card border border-border/50 p-5">
  …content…
</div>
```

- **`rounded-lg`** (8px). Not `rounded-2xl`, not `rounded-3xl`. Outer cards are medium-radius.
- **`border border-border/50`** — softened, not solid `border-border`. The deeper border felt heavy.
- **`bg-card`** — same base as the page background; the border is what makes the card visible.
- **No shadow** by default. Shadows imply depth this surface doesn't earn.
- Padding `p-5`. Section 0-style strip cards use `px-5 py-4` (less vertical for single rows).

### Sub-card (nested content)

When a card holds a list-of-rows or a metadata block, the inner block uses:

```tsx
<div className="rounded-md bg-muted/40">
  <div className="px-3.5 divide-y divide-border/50">
    {rows.map(r => <div className="py-2.5 flex items-center justify-between">{…}</div>)}
  </div>
</div>
```

- **`rounded-md`** (6px) — one step smaller than the outer card, preserves hierarchy.
- **`bg-muted/40`** — distinct from `bg-card` so the user perceives it as a child block.
- **Inset dividers are mandatory**: `divide-y` lives on a `px-3.5` wrapper, not on the outer rounded box. This is what gives the "doesn't touch the edge" look.

The same inset-divider rule applies to outer cards that host stacked rows (e.g. the Service Settings card with diagnostics + default model):

```tsx
<div className="rounded-lg bg-card border border-border/50">
  <div className="px-5 divide-y divide-border/50">
    <div className="py-4 …">…row 1…</div>
    <div className="py-4 …">…row 2…</div>
  </div>
</div>
```

### Catalogue card (clickable, opens detail dialog)

For lists of installable / configurable items (Skills, MCP servers, CLI tools, marketplace skills) the card is a button that opens a detail dialog. It inherits the outer-card chrome above and adds:

```tsx
<div
  role="button"
  tabIndex={0}
  onClick={onOpen}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  }}
  aria-label={`${item.name} — ${item.description}`}
  className="rounded-lg bg-card border border-border/50 p-5 cursor-pointer transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
>
  …
</div>
```

- **`role="button"` + `tabIndex={0}` + Enter/Space `onKeyDown`** — keyboard + screen-reader parity. The whole card is one activatable target; never split "click name to view, click pencil to edit" — that's the anti-pattern that triggered the MCP card unification work in 2026-05.
- **`hover:bg-muted/40`** — the only hover affordance. No border-color shift, no shadow.
- **`focus-visible:ring-2 focus-visible:ring-ring`** — required for keyboard discovery.
- **`aria-label` includes name + a short description** — icon-only or short-name cards are illegible to screen readers without it.
- **Inner action buttons** (toggle switch, delete-confirm, install) must `e.stopPropagation()` so they don't trigger the card-level open.

Card body layout convention (top-to-bottom, all sections optional except name):

1. **Identity row** — `flex items-center gap-2 flex-wrap`. Name + inline pills (transport / source / status / Preview tag) + `tool count` tail. Pills are inline next to the name, **never on a separate row** — that's the rule that aligned built-in MCP and user-installed MCP cards.
2. **Description** — `text-xs text-muted-foreground mt-2 leading-relaxed line-clamp-3`. Three lines is the max; if a card needs more, it belongs in the detail dialog.
3. **Footer row** (optional) — `flex items-center justify-between mt-3 gap-2`. Left: secondary metric (agent-friendliness stars, last-used time). Right: shrink-0 action button (install / delete / reconnect). Footer only renders when at least one of those is present.

### Catalogue grid

```tsx
<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
  {items.map(item => <CatalogueCard … />)}
</div>
```

- **`md:grid-cols-2`** is the canonical breakpoint. Don't add `lg:grid-cols-3` — at three columns the description gets line-clamped to oblivion and the page reads like a table-of-tables.
- **`gap-4`** matches the outer card's `p-5`; tighter gaps make adjacent cards bleed visually.
- The same grid string applies to Skills sources, MCP built-in catalog, MCP installed servers, CLI installed/recommended, and marketplace results — all four MCP/CLI/Skills lists keep the same density on every breakpoint.

### Click-card → detail dialog

The canonical detail-dialog `DialogContent` className:

```tsx
<DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col gap-0 overflow-hidden">
  <DialogHeader className="shrink-0">
    <DialogTitle>{item.name}</DialogTitle>
    <DialogDescription>{metaLine}</DialogDescription>
  </DialogHeader>
  <div className="flex-1 min-h-0 overflow-y-auto mt-4 space-y-4">
    {/* sections — see body conventions */}
  </div>
  <DialogFooter className="shrink-0 border-t border-border/50 pt-3 mt-2">
    {/* primary actions */}
  </DialogFooter>
</DialogContent>
```

- **`sm:max-w-2xl`** is the unified width across Skills / MCP (built-in + user-installed) / CLI / Marketplace dialogs. Earlier we had `max-w-md` / `max-w-lg` / `max-w-2xl` mixed across the four families — that read as inconsistency, not as content-sized variation.
- **`max-h-[85vh] flex flex-col gap-0 overflow-hidden`** is non-negotiable. Without `gap-0` the default DialogContent gap leaks visible whitespace between header / body / footer; without `overflow-hidden` the dialog itself starts scrolling instead of just the body.
- **Body is the only scroll region** — `flex-1 min-h-0 overflow-y-auto`. Header and footer are `shrink-0`. Pulling header/footer out of the scroll keeps the title + actions anchored when the user scrolls long content (Skills README, CLI use-cases).
- **Footer separator** — `border-t border-border/50 pt-3 mt-2`. Visible boundary between content and actions; matches the same border weight used on cards.
- **Section heading dialect** inside the body — `<h5 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1.5">`. Use `· N` after the heading when the section is a counted list ("工具 · 7").
- **Inline list as sub-card** — when a section is a list of mono-spaced strings (tool names, server URLs), use the same inset-divider sub-card from above (`rounded-md bg-muted/40` + `px-3.5 divide-y`).

#### Two-mode dialog (detail / edit) — same dialog, swap body

When a detail dialog also offers edit, **swap the body in-place — never open a second Dialog**. Stacked dialogs ("弹窗叠弹窗") were called out as a UX regression in 2026-05; the same single-dialog-with-mode-state pattern is used by `<MarketplaceBrowser>` (list ↔ detail) and `<McpServerDetailDialog>` (detail ↔ edit):

```tsx
const [mode, setMode] = useState<'detail' | 'edit'>('detail');
<DialogContent className="…">
  <DialogHeader className="shrink-0">…name + pills…</DialogHeader>
  <div className="flex-1 min-h-0 overflow-y-auto mt-4 …">
    {mode === 'detail' ? <DetailBody … /> : <EditForm … />}
  </div>
  <DialogFooter className="shrink-0 border-t border-border/50 pt-3 mt-2 sm:justify-between">
    {mode === 'detail' ? (
      <>
        <Button variant="ghost" className="text-destructive …" onClick={confirmDelete}>{t('common.delete')}</Button>
        <Button onClick={() => setMode('edit')}>{t('common.edit')}</Button>
      </>
    ) : (
      <>
        <Button variant="outline" onClick={() => setMode('detail')}>{t('common.cancel')}</Button>
        <Button onClick={submit}>{t('mcp.saveChanges')}</Button>
      </>
    )}
  </DialogFooter>
</DialogContent>
```

- **One Dialog, header stays mounted** through the mode switch — the user sees they're still in the same context, no flicker, no focus loss.
- **List ↔ detail variant** uses a back button at the top of the detail panel instead of `onClose` (`<MarketplaceBrowser>` is the reference). The Dialog wrapper stays open; only the inner panel swaps.
- **Destructive confirm** (delete) goes through `<AlertDialog>` — that's the one place stacking is fine, because it's a transient confirm, not navigation.
- **Form extraction**: when the same form is reachable from both an "Add" Dialog and a Detail Dialog edit-mode, extract the form fields into a headless component with imperative `submit()` ref, so the two wrappers can place buttons in their own footers without duplicating validation. `<McpServerEditorForm>` is the reference.

## Status & source badges

Two distinct dialects, same shape, different intent.

### Status pill — provider runtime state

```tsx
<span className={cn(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
  STATUS_TONE[data.status],
)}>
  <span className={cn("size-1.5 rounded-full", DOT_TONE[data.status])} />
  {label}
</span>
```

| Status | Background | Dot |
|---|---|---|
| `available` | `bg-status-success-muted text-status-success-foreground` | success-foreground |
| `needs-config` | `bg-status-warning-muted text-status-warning-foreground` | warning-foreground |
| `error` | `bg-status-error-muted text-status-error-foreground` | error-foreground |
| `unknown` | `bg-muted text-muted-foreground` | muted-foreground |

### Source badge — data origin (`source`)

Smaller (`text-[10px]`), no dot. Used on every row in `Settings > Models`. Answers **"where did this row come from"** — purely a lineage marker.

| Source | Tone | When |
|---|---|---|
| `api` | `bg-status-success-muted text-status-success-foreground` | discovered via /v1/models or models.list |
| `catalog` | `bg-muted text-muted-foreground` | shipped from VENDOR_PRESETS |
| `manual` | `bg-primary/10 text-primary` | user hand-entered |
| `role_mapping` | `bg-status-warning-muted text-status-warning-foreground` | implied by `model_mapping` |
| `sdk_default` | `bg-muted text-muted-foreground` | hard-coded SDK fallback |

### Enable-source badge — current-state intent (`enable_source`)

A **second** badge that sits next to the source badge on Models-page rows. Same shape, different question: **"why is this row enabled / hidden right now?"** Distinct from `source` (where it came from). Both can render side-by-side because they answer orthogonal questions:

> `API 同步 · 手动启用` = "we got this row from /v1/models, AND the user explicitly turned it on"

Render rule: only show the badge when the state is non-trivially different from the system default. `recommended` and `catalog` stay silent (they're the boring default and would just add visual noise). Three states are visible:

| Enable source | Label (zh / en) | Tone | Tooltip |
|---|---|---|---|
| `manual_enabled` | 手动启用 / Manually enabled | `bg-primary/10 text-primary` | "你在 Models 页主动启用，刷新不会覆盖" |
| `manual_hidden` | 手动隐藏 / Manually hidden | `bg-muted text-muted-foreground` | "你在 Models 页主动隐藏，刷新不会覆盖" |
| `discovered` | 未推荐 / Off-catalog | `bg-status-warning-muted text-status-warning-foreground` | "上游有这个模型，但不在推荐目录里 — 默认不在 picker 中显示" |

The two manual states are user-promises: they tell the user "your toggle stuck, refresh is no longer going to flip this." The discovered state is a recommendation-system signal: it tells the user "we found this but didn't think it belonged in the picker; you can turn it on if you want."

The `discovered` warning tone is intentional — it pairs with the same orange used in the discover-models diff dialog's "will-be-hidden" preview, so the two surfaces feel coherent.

`recommended` and `catalog` are never tooltip-explained inline because they're the implicit default; explaining them everywhere would dilute the signal of the three that do display.

## Header rhythm

### One row vs two rows

The **Provider card header** (in Settings > Providers) packs identity + status pills + actions. It uses the existing two-row scheme already in `ProviderCard.tsx`:
  - Row 1: icon + name + inline actions (right side)
  - Row 2: status pill + compat pill (full inner width, never wraps mid-character)

The **Models-page section header** went through the same evolution. Single-row was packing 6 chips and made action buttons drift down whenever the row wrapped. Two-row split:

```
Row 1: [icon] Provider Name   3 / 10 启用    上次同步: N 分钟前      → [刷新] [全部关闭] [全部启用] [角色映射] [+ 添加模型]
Row 2: [Compat pill] [默认: model]
```

Row-split rules:
- **Row 1 = operational**: counts that change (enabled/total), freshness (last sync), and the action cluster. Action buttons stay pinned to the right of the title's baseline regardless of how many secondary chips ride along.
- **Row 2 = identity**: chips that don't change with usage (compat tag, default-model chip). Indented to align with the provider name (`pl-9` to clear icon + gap).
- Row 2 is **omitted entirely** when neither chip applies (manual-only providers with no compat info) — don't render an empty row.

### Counts + freshness rules

- **`X / Y 启用`** when not searching, **`X / Y 匹配`** when searching. Switch the suffix, not the format.
- **Bulk-toggle and reorder are disabled while searching** + tooltip — would otherwise hit the unfiltered list.
- **"上次同步" / "上次刷新"** uses bucketed relative time (just-now / N-min / N-hour / N-day / absolute date for >30d). Always pair with a `title` attribute carrying the absolute UTC timestamp for users who need precision.
- Hide the freshness row entirely when `last_refreshed_at` is null (catalog-only providers, never probed) — don't render "从未同步" placeholders inline; the absence IS the signal.
- **Primary "Add" button on the far right**, outline variant. Adding is distinct from the muted bulk-toggles.

## Sidebar list item spacing

Vertical lists inside the chat sidebar (project groups, session rows, assistant groups) use:

```tsx
<div className="flex flex-col gap-1.5">  {/* 6px */}
```

**Why 6px (not 2px, not 8px):**
- **2px** is visually indistinguishable from "items touch" — hover backgrounds still merge edge-to-edge, defeating the affordance that an item is hoverable.
- **8px** looks fine on a single item but compounds on long lists (a 20-row session list eats 160px of extra height) and pushes the "new chat" affordance below the fold on 768p.
- **6px** is the smallest gap that registers as a separation under default hover bg (`bg-sidebar-accent` ≈ 6% black overlay on light theme), and it's symmetric with the row's own internal padding (`px-3` horizontally, `h-8` ≈ 32px tall) so the visual rhythm stays balanced.

The same `gap-1.5` is used by `SessionListItem` rendering its own internal stacks and by `SplitGroupSection` headers — keeping the value consistent across the sidebar means a hover transition between any two items has the same visual weight, so muscle memory carries over.

If a list cell contains multi-line content (e.g. a row with title + subtitle), keep the gap and add `space-y-0.5` *inside* the cell for the title↔subtitle stack — outer rhythm and inner rhythm are different problems.

## Visible vs kebab actions

Decide by frequency, not by cleanliness.

**Visible inline buttons (text or icon+text):**
- Edit
- Disconnect
- Refresh models  ← was kebab, promoted because discoverability matters for the diff flow
- Primary action: Login (OAuth), Settings link (env-managed), "Set as default" (image families)

**Kebab (`DotsThree`) only:**
- Diagnose
- Sync to Claude Code
- Anything < 5% usage

**Always:** kebab trigger needs `aria-label` + `title`.

## Filter tabs (segmented control)

Used for `enabled / hidden / all` on the Models page:

```tsx
<div className="inline-flex items-center rounded-md bg-muted p-0.5">
  {options.map(opt => (
    <button
      onClick={() => setFilter(opt.key)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {opt.label}
      <span className="text-[10px] tabular-nums">{opt.count}</span>
    </button>
  ))}
</div>
```

- **Default to the most useful filter**, not "all". Models page defaults to `enabled` because that's "what's actually exposed to chat".
- Counts must use `tabular-nums` so digits don't jitter as filters change.
- Don't reach for a heavyweight `<Tabs>` component if it co-locates with other controls — keep it inline.

## Search

```tsx
<div className="relative flex-1">
  <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
  <Input className="pl-9" placeholder="搜索…" />
</div>
```

- Icon `pointer-events-none` so clicks always reach the input.
- Search is composable: filters apply first, search filters within the result.

## When to preview, when to silently auto-apply

Two separate apply paths in this codebase, with different UX rules:

### A. Conservative auto-apply (no preview dialog)

Used by:
- **Add Service** success → auto-discover the new provider's models
- Per-provider **"刷新"** button on Models page section header
- Page-top **"刷新全部"** batch driver

Why no preview: the apply layer (`applyDiscoveryDiff` in `db.ts`) reads
each row's `enable_source` and refuses to flip rows in
`manual_enabled` / `manual_hidden`. New rows land enabled only if the
recommendation list says so; everything else hides. So a silent refresh
can never override a user choice — the protection is in the data
layer, not the UI gate.

A toast (single-provider, or rolling progress for batch) reports the
outcome — `recommendedEnabled` / `discoveredHidden` counts; the user
gets a 1-line summary instead of a 3-step dialog.

### B. Preview-then-apply (dialog)

Used by:
- **"按推荐整理"** (Tidy by recommended — `alignEnabledWithCatalog`)
- The advanced diff dialog accessed from `ProviderManager.handleDiscoverModels`
  (legacy, kept for orphan review and forced resets)

Why preview: these flows can intentionally flip many rows or produce
permanent deletes (catalog seed pruning); the user needs to see scope
before committing.

Implementation in three phases of a dialog:

1. `previewing` — spinner + "Computing…"
2. `preview-ready` — show counts + per-target breakdown + Apply button
3. `applying` — Apply disabled, "Applying…", close on completion

Rules:
- Preview must be **idempotent** server-side (no DB writes during dryRun).
- The same code path computes the preview and the apply — never let them diverge.
- Counts are surfaced as a 4-row sub-card (Insert / Enable / Hide / Prune). Per-target deltas use ASCII glyphs (`+ ↑ ↓ −`) in monospace for scan-ability.
- Skipped targets (no catalog, no upstream support) get a plain text footnote, not their own row.

## Batch action button (page-top, secondary)

Pattern for "do this across every applicable target" actions where the per-target version exists somewhere on the page (e.g. "刷新全部" sits at the top of Models, while each section has its own "刷新").

```tsx
<Button
  variant="ghost"
  size="sm"
  className="gap-1.5 text-muted-foreground hover:text-foreground"
  onClick={handleRefreshAll}
  disabled={inFlight || syncableCount === 0}
  title={syncableCount === 0
    ? "没有可同步的服务商"
    : `挨个刷新 ${syncableCount} 个支持同步的服务商，最后会汇总成功 / 失败 / 无更新`}
>
  {inFlight ? <SpinnerGap className="animate-spin" /> : <ArrowsClockwise />}
  刷新全部 ({syncableCount})
</Button>
```

Rules:
- **Ghost variant**, not outline. Outline is reserved for the heavier sweep action sitting next to it ("按推荐整理"). The ghost batch reads as "convenience over the per-target version" rather than "third major action."
- **Count in the label** (`(N)`). It tells the user how much work the click is buying — also doubles as a disabled-when-zero affordance.
- **Disable when zero** rather than hide. Hiding makes the user wonder where it went; disabled-with-tooltip explains why.
- Per-target buttons stay enabled while batch is idle, but **mutually gate** while either is in flight (no double-fire).

## Sequential batch with rolling progress toast

When a batch executes per-target probes (network), prefer **sequential + single rolling toast** over `Promise.all` + per-target toasts. Reasons:

- The progress toast actually reads as a progression instead of a blink-and-done.
- Doesn't fan-burst against shared upstreams (some Code Plan endpoints rate-limit on parallel hits).
- One toast lifecycle is easier to mentally track than N stacked toasts.

```ts
const toastId = showToast({ type: 'loading', message: t('batch.progress', { done: '0', total: String(N), name: targets[0].name }), duration: 0 });
try {
  for (let i = 0; i < targets.length; i++) {
    updateToast(toastId, { type: 'loading', message: t('batch.progress', { done: String(i + 1), total: String(N), name: targets[i].name }), duration: 0 });
    const result = await runOne(targets[i]); // pure; no toast inside
    // ... aggregate counters ...
  }
  // … post-loop refetch …
  updateToast(toastId, { type: failCount > 0 ? 'warning' : 'success', message: summary, duration: failCount > 0 ? 8000 : 6000 });
} catch (err) {
  updateToast(toastId, { type: 'warning', message: `批量过程异常: ${err.message}`, duration: 6000 });
} finally {
  setInFlight(false); // ALWAYS reset, regardless of throw
}
```

Rules:
- **`try / finally` is non-negotiable** — without it, an unexpected throw mid-loop leaves the page-top button stuck in "Refreshing..." forever. The reset MUST happen in `finally`.
- **`catch` turns the rolling toast into a warning** instead of letting it disappear silently — users need to see something happened.
- **Pure helper inside the loop** — extract a no-toast variant (e.g. `probeAndApplyProvider`) so the outer driver owns the toast story; per-target helpers only return typed results.
- **Final summary** lists successes + no-change + failures with up to 3 failure names inline (`+M more` suffix when more). Warning tone if any failed, success tone otherwise.

## Soft refetch (preserve scroll position)

When a partial state change should reflect on screen but the page lists many sections (Models page, project list, etc.), don't reuse a global `fetchAll()` that flips `loading=true` — that unmounts the entire list and loses scroll. Instead, refetch only the affected slice in place:

```ts
// Soft per-id refetch — updates one bucket of state, leaves the rest untouched
const refetchProviderBundle = useCallback(async (providerId: string) => {
  try {
    const r = await fetch(`/api/providers/${providerId}/models?all=1`);
    if (r.ok) {
      const d = await r.json();
      setBundles(prev => ({ ...prev, [providerId]: d.models || [] }));
    }
  } catch { /* ignore — toast already covers failure */ }
}, []);
```

Use it after a single-target action completes, or after a batch via `Promise.all(succeededIds.map(refetchProviderBundle))`. The point: only the section whose row count actually changed re-renders.

## Disable with explanatory tooltip

When an action genuinely cannot succeed for the current state of a target, **disable + tooltip the reason** rather than letting the user click and read a failure toast.

```tsx
const sync = isSyncableProvider(provider);
return (
  <Button
    disabled={!sync.ok}
    title={!sync.ok ? sync.reason : "重新从上游拉取模型列表（不会覆盖你手动启用/隐藏的行）"}
  >
    刷新
  </Button>
);
```

Rules:
- **Only disable when 100% certain it won't work** (e.g. OAuth-only provider, no /v1/models endpoint exists). When a probe might 401 / 404 but the user could fix it (set a key, reconnect), let the click happen — accurate failure beats accurate-sounding pre-filter.
- **Reason as the tooltip body**, not a separate help icon. The user is already hovering the disabled control.
- **Filter out disabled targets from batch operations** via the same predicate. The batch button label should show the count of *eligible* targets, not all targets.

## Empty states

```tsx
<div className="rounded-lg border border-border/50 bg-card p-10 flex flex-col items-center text-center gap-3">
  <div className="text-sm font-medium">{title}</div>
  <div className="text-xs text-muted-foreground max-w-md">{body}</div>
  <Button variant="default" size="sm" className="gap-1.5 mt-1">
    <Plus size={14} weight="bold" />
    {primaryAction}
  </Button>
</div>
```

- One sentence title (`text-sm font-medium`).
- One paragraph body (`text-xs text-muted-foreground`), capped at `max-w-md`.
- One primary action — solid (default) variant. Empty state is the moment the page exists for; this is the right place for the loud button.
- `p-10` for generous breathing room.

## Modal / fullscreen dialogs

Two flavors via the shared `DialogContent` component:

- **Centered modal** (default) — confirms, small forms, info dialogs.
- **Fullscreen takeover** (`fullscreen` prop) — for Add Service, Connect Provider, Edit Provider. Forms get the user's full attention; the underlying surface is replaced with `bg-background`, the form content lives in a `min-h-full flex items-center justify-center` wrapper so it stays vertically centered.

Both flavors render a circular close button top-right (built in to `DialogContent`).

### Dialog width ladder

Three named tiers. Pick by content type, not by gut feeling:

| Tier | className | Use for |
|---|---|---|
| **md** | `sm:max-w-md` | Single-purpose confirms, tiny forms (≤2 fields), feature-announcement / update dialogs. The width that says "one decision." |
| **lg** | `sm:max-w-lg` | Medium forms (3–6 fields), connection wizards step bodies, install / progress dialogs. |
| **2xl (canonical detail)** | `sm:max-w-2xl max-h-[85vh] flex flex-col gap-0 overflow-hidden` | All "click-card → detail" dialogs (Skills, MCP, CLI tools, Marketplace, server detail/edit). Full-readme / structured detail / two-mode (detail↔edit) flows live here. |

Pixel widths (`sm:max-w-[550px]` etc.) are not allowed. If the tier doesn't fit, the content is fighting the dialog; rethink either the content or the tier before reaching for a custom width.

The 2xl tier carries three rules together — body is the only scroll region, header/footer are pinned:
- Header: `<DialogHeader className="shrink-0">`
- Body: `<div className="flex-1 min-h-0 overflow-y-auto mt-4 …">`
- Footer: `<DialogFooter className="shrink-0 border-t border-border/50 pt-5 mt-3">`

The footer's `border-t + pt-5` (32px stack) gives scrolling lists a visual anchor so the action bar never looks welded to the last list row. Apply this pattern to any 2xl dialog that scrolls — the footer is the natural "exit ramp" and deserves its own breathing room.

Don't put `overflow-y-auto` on the `DialogContent` itself — that scrolls the whole dialog including the title, which loses the user's place. Reserve raw `overflow-y-auto` for tier md/lg dialogs that are short enough not to need a sticky header.

### Service "enabled vs running" — two-banner pattern

When a feature has both an **enabled** config toggle AND a separate **running** runtime state (Bridge, future webhooks, scheduled jobs), the surface MUST distinguish the two with two banners, never one:

```tsx
{isEnabled && !isRunning && (
  <StatusBanner variant="warning">
    <Warning size={14} className="shrink-0" />
    {t("…enabledNotRunningHint")}  {/* "Enabled, but service is not running yet" */}
  </StatusBanner>
)}
{isEnabled && isRunning && (
  <StatusBanner variant="info" className="bg-primary/10 text-primary">
    <span className="size-2 rounded-full bg-primary inline-block" />
    {t("…activeHint")}  {/* "Service is running. External channels can send tasks" */}
  </StatusBanner>
)}
```

- The 2026-05-05 fix in BridgeSection is the cautionary tale: a single banner that fires on `isEnabled` told users their phone could send tasks when the service wasn't actually running. Don't conflate the two states ever.
- `isEnabled && !isRunning` is **warning** tone (yellow) — it's a "you're not done yet" signal, not an error.
- `isEnabled && isRunning` uses `bg-primary/10 text-primary` — it's a positive confirmation, not a status-success (which we reserve for "verified healthy" not "currently active").
- Active-state copy must mention what runtime ability the user gains ("外部渠道可以发送任务"), not just "active" / "已激活" — "active" is a config word, "running" is a runtime word.

### Service start / stop button pattern

Symmetric pair of buttons in the status row:

- **Start** — `<Button size="sm">` (default variant). The user is opting in.
- **Stop** — `<Button variant="outline" size="sm">`. The user is opting out — outline keeps it visible without competing for attention.
- Both show `<SpinnerGap size={14} className="animate-spin mr-1.5" />` while the action is in flight; label switches to the gerund i18n key (`bridge.starting` / `bridge.stopping`).
- **Disable** the button while in-flight, don't hide it. Letting it disappear creates layout shift and looks broken.

Reference: `BridgeSection.tsx:267-300`.

### Destructive vs warning AlertDialog tone

`<AlertDialog>` is for any confirm-then-act flow. The action button's color encodes severity:

- **`bg-destructive`** — the action is permanent and irreversible (delete a server, remove a tool). Reaches the user as red.
- **`bg-status-warning hover:bg-status-warning/80 text-white`** — the action is reversible-but-risky (enable auto-approve, run a sweeping refresh). Reaches the user as amber.
- **Default (no override)** — the action is benign-but-needs-confirmation (regenerate skill from template, install). Standard primary tone.

Footer always pairs `<AlertDialogCancel>` (left) with `<AlertDialogAction>` (right, with the colored class). Never single-button — the cancel must always exist.

Reference: `McpServerDetailDialog.tsx:268-285` (destructive); `GeneralSection.tsx:234-238` (warning).

### Settings page-shell widths

Two named widths, one rule: container width follows content density.

- **`max-w-4xl mx-auto space-y-6`** — catalogue / management pages: Providers (cards grid), Models (table), Overview (dashboard cards). Wider so cards or table columns breathe.
- **`max-w-3xl mx-auto space-y-6`** — config pages: Bridge channels, Telegram / Feishu / Discord / QQ / WeChat credentials, Appearance, About. Narrower so 1-column form rhythm feels intentional, not floaty.

`mx-auto` is non-negotiable — without it the page anchors left on wide screens and reads as "this column is the whole page" instead of "this card sits in a column."

### `FieldRow` vs raw `<label>` — when to pick which

`FieldRow` is the canonical row for a single label + control. Use it whenever you'd write:

```tsx
<div className="flex items-center justify-between">
  <div>
    <Label>…</Label>
    <p className="text-xs text-muted-foreground">…</p>
  </div>
  <Switch ... />
</div>
```

Use raw `<Label htmlFor={...}>` + `<Input>` (stacked, label above) only when:
- The control is a **multi-line input** (Textarea) where horizontal layout doesn't work.
- The label sits **inline** with the input on the same baseline (date-range filters: `gallery/page.tsx:185-203`).
- A single card holds **a form-style cluster** of inputs that need a tighter visual relationship than `FieldRow` allows (e.g. Bot Token + Webhook URL stacked under one heading).

Never roll your own `flex justify-between + Switch` row — that's the BridgeSection regression that 2026-05-05 fixed by migrating 5 channel toggles back to `FieldRow`.

### Loading skeletons

Two acceptable patterns:

1. **Inline spinner** (preferred when content area < 50% of viewport): `<SpinnerGap size={20} className="animate-spin text-muted-foreground" />` centered in the slot. Use this for cards / sub-cards / dialog bodies.
2. **Dashed-border placeholder card** (when the card itself is loading): `rounded-lg border border-dashed border-border/50 bg-card/50 p-10 text-center` with a one-line `text-muted-foreground` copy. Reference: `OverviewSection.tsx`, `HealthSection.tsx` loading shells.

Don't use raw `animate-pulse` divs. Don't switch from "no card chrome" (loading) to "full card chrome" (loaded) — the layout shift looks broken; pick one structure for both states.

### Empty state — chrome rule

Two patterns by context. The 2026-05 audit found 6 places each rolling their own; converge on:

1. **Inline empty (replaces a list)** — `<div className="rounded-lg border border-border/50 bg-card p-10 flex flex-col items-center text-center gap-3">` with icon (size 32, `opacity-40 text-muted-foreground`) + heading + description + optional primary action. Use when the list lives inside a Tab / Section that always renders.
2. **Full-page empty** — same chrome but `py-12` instead of `p-10`, no card border (parent is the whole route). Use only when the page itself is empty (`/gallery` with no items).

The bordered card variant is the default — only drop the border for full-route empties.

### Catalogue grid — break at md, never lg

The two-column responsive rule for catalogue grids is `grid grid-cols-1 md:grid-cols-2 gap-4`. Both `md:grid-cols-2 lg:grid-cols-3` AND `lg:grid-cols-2` (no md breakpoint) are wrong:

- `lg:grid-cols-3` → too dense; 3-col card descriptions get line-clamped to oblivion. Anchor implementations stay 2-col.
- `lg:grid-cols-2` (skipping md) → the typical Settings panel width is 768–900px and never hits `lg` (1024px+), so the grid stays single-column where it should already be split. The 2026-05-05 audit caught this in `RuntimePanel.tsx`; engine cards never went two-up because the breakpoint was wrong.

Engine pickers, model lists, server cards, marketplace cards — all `md:grid-cols-2`. If you need three columns, content is too dense; split into two grids or reduce per-card content.

### Chart card

Same chrome as outer card (`rounded-lg border border-border/50 p-5`), heading is `text-sm font-medium` (no uppercase tracking — the body of the chart already provides visual structure). Stat tiles below the chart use `rounded-md bg-muted/30 px-3 py-2` (lighter than the canonical sub-card `bg-muted/40` so they read as quick reference, not a separate panel).

Reference: `OverviewHeatmap.tsx` (heatmap + 4 streak stats), `UsageStatsSection.tsx` (daily-tokens bar chart).

## Runtime Compatibility Matrix

Single source of truth for "where does this model belong": `src/lib/runtime-compat.ts`. Provider-layer compat is computed once via `getProviderCompat()` and consumed by:

| Consumer | What it does with compat |
|---|---|
| Provider Card | Renders a second pill in the header next to status pill |
| Models page | Shows compat badge on every row + Runtime filter dropdown gates whole sections |
| `/api/providers/models` | Returns `compat` per group so chat picker can filter / badge |
| provider-resolver | (Phase 2) skip models whose compat doesn't match active runtime |

### Provider-layer states

| State | When | Pill tone |
|---|---|---|
| `claude_code_ready` | `anthropic-official` / `bedrock` / `vertex` preset, env-detected Claude Code | success |
| `claude_code_experimental` | Anthropic-protocol brands & relays (anthropic-thirdparty, kimi, glm, moonshot, minimax, volcengine, xiaomi-mimo, bailian, deepseek, ollama, litellm) | warning |
| `codepilot_only` | OpenRouter / OpenAI-compat / Google chat — non-Anthropic protocol | primary/10 |
| `media_only` | image-image protocols | muted |
| `unknown` | Custom URL with no preset match — UI says "需验证", never "不可用" | muted |

### Model-layer flags

A bag of capability flags (multiple can apply). Used for finer-grained gating:

- `chat` — usable as chat / coding model
- `tool_capable` — known to support tool calls (defaults true unless catalog says otherwise)
- `thinking_capable` — supports reasoning / effort levels
- `claude_code_compatible` — surfaceable when current runtime is Claude Code
- `codepilot_runtime_compatible` — surfaceable when current runtime is CodePilot Runtime
- `media` — image / video / embedding only; never enters chat picker

Computed via `getModelCompat({ modelId, providerCompat, capabilities })`. Claude-alias rows (`sonnet` / `opus` / `haiku` / `claude-*`) auto-get `claude_code_compatible` even on `codepilot_only` providers — relays often expose Anthropic models too.

### Filter precedence (when consumed)

1. **Hidden** (`enabled=0` in `provider_models`) wins over everything. Catalog fallback / role default / env injection all check `dbHiddenIds` first.
2. **Runtime filter** then narrows by Provider compat. `unknown` stays visible across runtimes — copy is "需验证", not "incompatible".
3. **Media** is never in chat surfaces, regardless of filter.

### Wording lock

Use `compatLabel(compat, isZh)` from `runtime-compat.ts` everywhere. Don't hard-code Chinese strings in components — a future copy change must touch one file.

## What `Settings > Models` is for

The Models page is the source of truth for "which models reach the chat picker / runtime". Providers can advertise hundreds of models; users decide which they actually want.

Hard rules baked into the implementation:
- Hiding a model in Models page **must** suppress it in `/api/providers/models` (the picker feed) and in `provider-resolver.ts` (the runtime). The catalog fallback respects user-set hidden ids.
- The **section-level "刷新" button** on the Models page silently auto-applies (probe → conservative apply → toast). The data layer's `enable_source` guard makes this safe: `manual_enabled` / `manual_hidden` rows are never flipped by refresh, regardless of the apply path.
- The **page-top "刷新全部 (N)"** button runs the same flow sequentially across every syncable provider, with a rolling progress toast and a final summary listing successes / failures / no-change.
- The **"按推荐整理" button** (`alignEnabledWithCatalog`) stays preview-first: it's a sweeping reset that intentionally flips many rows + can prune deletes, so the user needs to see scope before committing.
- The **legacy diff dialog** on Provider Card kebab → "刷新模型" stays preview-first too, kept for orphan review and forced resets. Two refresh entry points by intent — section "刷新" for routine maintenance, kebab for advanced inspection.
- User-edited rows (`user_edited=1`) and rows with `enable_source IN ('manual_enabled','manual_hidden')` survive every refresh / align — display_name, capabilities, and especially `enabled=0` are preserved.

## Counts on the Provider card

The "Models" row on each Provider card shows `enabled / total`, where:

- **enabled** = rows the chat picker actually surfaces.
- **total** = `total_count` from `/api/providers/models` — i.e. all `provider_models` rows for this provider, including hidden ones. Falls back to catalog size when the table is empty.

Don't display only the enabled count — users hide things and need to remember they did. Don't display only total — they need to know how many are actually exposed. The "X / Y" form is non-negotiable.

## Do / Don't

✅ **Do**
- Use `border border-border/50` for display cards. Soft, not heavy.
- Inset dividers via `px-N + divide-y` wrapper. Never `divide-y` directly on a rounded card.
- Mirror the page-shell radius hierarchy: outer `rounded-lg`, nested `rounded-md`, micro chips `rounded-full`.
- Show counts as `enabled / total` when both are interesting. Don't pick one.
- `aria-label` every icon-only button.
- Use `tabular-nums` on numeric counts that change.
- Auto-apply silently when the data layer protects against override (refresh paths under `enable_source` guard); show a preview dialog only when the operation can intentionally flip many user choices ("按推荐整理") or perform deletes.

❌ **Don't**
- Don't put a preview dialog in front of every write — single-provider refresh + batch refresh-all auto-apply on purpose; gating them behind a dialog regresses the UX. Reserve previews for the Tidy / advanced-diff paths where the user is asking for a sweeping change.
- Don't add an apply path that ignores `enable_source IN ('manual_enabled','manual_hidden')` — that's the invariant that makes silent refresh safe in the first place.
- Don't bury the most-used action in a kebab. If a user needs it weekly, surface it.
- Don't display the same list as both "all models" and "what the picker shows" — they diverge once the user starts hiding things, and the picker view is the lie.
- Don't toggle `loading=true` on a soft refresh — it remounts the list and loses scroll position.
- Don't dispatch a global `provider-changed` from inside the page that listens for it; it's a feedback loop with a flicker.
- Don't use `border-border` (full-strength) for cards — that's reserved for inputs where contrast aids hit-testing.
- Don't assume `total_count` equals catalog size — for providers with API-discovered rows, total includes hidden ones.
- Don't auto-enable models the user has hidden. Refresh apply must respect `user_edited=1` AND `enable_source IN ('manual_enabled','manual_hidden')` — both are required, the legacy flag protects pre-Phase-B rows.

## Anchor implementations

| Pattern | File |
|---|---|
| Settings shell + nav | `src/components/settings/SettingsLayout.tsx` |
| Floating card shell (4-panel) | `src/components/layout/card-primitives.tsx` (`CardFrame` / `CardSurface` / `ResizeGutter`); 接入点 `AppShell.tsx` / `PanelZone.tsx`；约束 `card-primitives.test.ts` |
| Composer shell | `src/components/chat/MessageInput.tsx` (`--platform-surface-bar` hood + footer tools) + `MessageInputParts.tsx` (胶囊行) |
| macOS platform shell profile | `src/app/globals.css` (darwin `--platform-surface-*` 块) + `electron/main.ts` (`hiddenInset` + `vibrancy`) |
| Page-level container width (Settings sub-pages) | `src/components/settings/{OverviewSection,GeneralSection,AppearanceSection,ProviderManager,ModelsSection,RuntimePanel,UsageStatsSection,AssistantWorkspaceSection,AboutSection}.tsx` |
| Status-dashboard cards | `OverviewSection.tsx` — `GettingStartedBar` (top checklist, auto-hides at 4/4) + 6 `OverviewCard` in `lg:grid-cols-2` (Runtime / Providers / Models / Assistant Workspace / Update & About / Setup & Diagnostics; warning-tone cards pick up `status-warning-muted` accent) + `OverviewHeatmap.tsx` (365-day grid + 30/90/365D pills, reuses `/api/usage/stats`) |
| Outer card | `ProviderCard.tsx` (`rounded-lg bg-card border border-border/50 p-5`) |
| Inset divider sub-card | `ProviderCard.tsx` info section (`rounded-md bg-muted/40` + `px-3.5 divide-y divide-border/50`) |
| Catalogue card (clickable, opens detail) | `src/components/skills/SkillsManager.tsx` (`SkillCard`), `src/components/plugins/BuiltInMcpSection.tsx` (`BuiltInMcpCard`), `src/components/plugins/McpServerList.tsx` (user-installed card), `src/components/cli-tools/CliToolCard.tsx` |
| Catalogue 2-col grid | All four files above use `grid grid-cols-1 md:grid-cols-2 gap-4` |
| Click-card → detail dialog (canonical) | `src/components/skills/SkillDetailDialog.tsx`, `src/components/plugins/BuiltInMcpSection.tsx` (`BuiltInMcpDetailDialog`), `src/components/plugins/McpServerDetailDialog.tsx`, `src/components/cli-tools/CliToolDetailDialog.tsx`, `CliToolExtraDetailDialog.tsx` — all use `sm:max-w-2xl max-h-[85vh] flex flex-col gap-0 overflow-hidden` |
| Two-mode dialog (detail ↔ edit, same dialog) | `src/components/plugins/McpServerDetailDialog.tsx` (mode swap + shared form via `McpServerEditorForm.tsx`) |
| List ↔ detail dialog (same dialog, back button) | `src/components/skills/MarketplaceBrowser.tsx` + `src/components/skills/MarketplaceSkillDetail.tsx` (inline panel, no nested Dialog) |
| Headless form for shared edit | `src/components/plugins/McpServerEditorForm.tsx` (imperative `submit()` ref; consumed by `McpServerEditor` Dialog and `McpServerDetailDialog` edit-mode) |
| `SettingsCard` + `FieldRow` patterns | `src/components/patterns/SettingsCard.tsx` (`p-5`, optional title/description) + `src/components/patterns/FieldRow.tsx` (label + control row, optional `separator`) |
| Sub-card list of toggles inside card | `src/components/bridge/BridgeSection.tsx` `ChannelToggleRow` — channels card uses `rounded-md bg-muted/40` + `px-3.5 divide-y divide-border/50` for 5 channel rows + auto-start row |
| Inset-divider list inside card | `src/components/settings/WorkspaceTabPanels.tsx` (FilesTabPanel + TaxonomyTabPanel) |
| Service enable/disable + start/stop | `src/components/bridge/BridgeSection.tsx:218-300` (two-banner `enabledNotRunning` / `activeHint` pair + Start/Stop button pair) |
| Settings page width tiers | `max-w-4xl` for catalogue/dashboard pages (`OverviewSection.tsx`, `ProviderManager.tsx`, `ModelsSection.tsx`); `max-w-3xl mx-auto` for config sub-pages (`bridge/*Section.tsx`, `AppearanceSection.tsx`, `AboutSection.tsx`) |
| Status pill canonical (rounded-full + dot) | `src/components/settings/ProviderDoctorDialog.tsx` `StatusBadge` (post 2026-05 fix); `src/components/bridge/BridgeSection.tsx:251` (Bridge Connected/Disconnected); `WorkspaceTabPanels.tsx` (file exists/missing pills) |
| Destructive AlertDialog | `src/components/plugins/McpServerDetailDialog.tsx:268-285` (`bg-destructive` action) |
| Two-banner enabled-vs-running | `src/components/bridge/BridgeSection.tsx:218-234` |
| Chart card | `src/components/settings/OverviewHeatmap.tsx` (heatmap + 4 streak/active stats), `src/components/settings/UsageStatsSection.tsx` (recharts bar) |
| Sub-card row with relative-time + tooltip | `ProviderCard.tsx` ("Last refresh" row uses `formatRelativeTime` + `title` for absolute UTC) |
| Section 0 stacked card | `ProviderManager.tsx` 「服务设置」block |
| Status pill with dot | `ProviderCard.tsx` header |
| Source badge (data origin) | `ModelsSection.tsx` (`SOURCE_TONE`) |
| Enable-source badge (intent) | `ModelsSection.tsx` (`ENABLE_SOURCE_TONE` / `ENABLE_SOURCE_LABEL_*` / `ENABLE_SOURCE_TOOLTIP_*`) |
| Two-row section header (Models page) | `ModelsSection.tsx` (per-provider section header — row 1 ops, row 2 identity chips) |
| Filter segmented control | `ModelsSection.tsx` (Models page header) |
| Search input | `ModelsSection.tsx` |
| Bulk-action header | `ModelsSection.tsx` (per-provider header) |
| Page-top batch action button (ghost) | `ModelsSection.tsx` ("刷新全部 (N)" next to "按推荐整理") |
| Sequential batch + rolling toast | `ModelsSection.tsx` (`handleRefreshAll`) + `src/lib/auto-discover-models.ts` (`probeAndApplyProvider`) |
| Soft refetch (preserve scroll) | `ModelsSection.tsx` (`refetchProviderBundle`) |
| Disable-with-explanatory-tooltip | `ModelsSection.tsx` (`isSyncableProvider` gate on per-section "刷新") |
| Confirm-then-apply (diff) | `ProviderManager.tsx` (legacy preview dialog) + `ModelsSection.tsx` (align dialog) |
| Conservative auto-apply (no preview) | `src/lib/auto-discover-models.ts` (`runAutoDiscoverForProvider`) — used by Add Service success + section "刷新" |
| Apply-side manual override guard | `src/lib/db.ts` (`applyDiscoveryDiff` + `alignEnabledWithCatalog` — both check `enable_source IN ('manual_*')` AND `user_edited=1`) |
| Empty state | `ProviderManager.tsx` (no providers connected) |
| Fullscreen dialog | `src/components/ui/dialog.tsx` (`fullscreen` prop) + `PresetConnectDialog.tsx`, `ProviderForm.tsx` |
| Visible inline kebab demotion | `ProviderCard.tsx` (Refresh promoted out, Diagnose stays in) |
| Runtime compat matrix | `src/lib/runtime-compat.ts` (`getProviderCompat`, `getModelCompat`, `compatLabel`, `compatTone`) |
| Provider compat pill | `ProviderCard.tsx` header (second pill via `data.compat`) |
| Per-row compat badge | `ModelsSection.tsx` (next to source badge in row label) |
| Runtime filter dropdown | `ModelsSection.tsx` (alongside enabled/hidden tabs + search) |
