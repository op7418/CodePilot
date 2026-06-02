# UI Governance — CodePilot Design System

## 四层架构

```
src/components/ui/          → 纯 primitives（Button, Input, Select, Dialog, Card…）
src/components/patterns/    → 复用页面/表单/状态模式，纯展示，不发请求
src/components/{feature}/   → 组合 hooks + patterns + 业务状态
src/app/                    → 页面装配，不沉淀重复模式
src/hooks/                  → 数据获取、状态管理 hooks
```

### 层级约束

| 层 | 可以导入 | 禁止导入 |
|----|---------|---------|
| `ui/` | React, utils, class-variance-authority | 任何业务模块 |
| `patterns/` | `ui/`, React, utils, cn | `hooks/`, `lib/`, 任何数据逻辑 |
| `{feature}/` | `ui/`, `patterns/`, `hooks/`, `lib/` | 其他 feature 模块（除非通过 props） |
| `hooks/` | `lib/`, types | 组件 |

## 图标策略

**统一使用 Phosphor Icons (`@phosphor-icons/react`)**

- 所有新代码必须使用 Phosphor Icons
- 禁止引入 `lucide-react`（ESLint 规则 `no-restricted-imports`）
- 统一入口：`src/components/ui/icon.tsx`（提供 re-export + 尺寸常量）

### 尺寸常量

| 名称 | 值 | 用途 |
|------|---|------|
| `sm` | 14px | 内联文字旁小图标 |
| `md` | 16px | 默认按钮/菜单图标 |
| `lg` | 20px | 标题/导航图标 |
| `xl` | 24px | 空状态/大图标 |

### Lucide → Phosphor 映射

| Lucide | Phosphor |
|--------|----------|
| CheckIcon | Check |
| ChevronDownIcon / ChevronUpIcon | CaretDown / CaretUp |
| ChevronRightIcon | CaretRight |
| XIcon | X |
| SearchIcon | MagnifyingGlass |
| Loader2Icon | SpinnerGap |
| CornerDownLeftIcon | ArrowElbowDownLeft |
| ImageIcon | Image |
| BrainIcon | Brain |
| TerminalIcon | Terminal |
| BookIcon | Book |
| DotIcon | DotOutline |
| CircleIcon | Circle |

## 颜色 Token 规范

- 优先使用 `globals.css` 中定义的语义 token（`--background`, `--foreground`, `--muted`, `--accent` 等）
- 禁止在业务组件中使用 Tailwind 原始色值（如 `bg-green-500/10`）
- 如需状态色，使用对应语义 class 或在 `globals.css` 中定义新 token

## 组件大小限制

- 单个组件文件不超过 **500 行**（ESLint `max-lines` warn）
- 超过 500 行需拆分为子组件或抽取 hooks
- `ui/` 和 `ai-elements/` 层豁免（它们是独立的原语库）

## 间距规范

> Token 化的间距档位，避免"0/2/4/8 凭感觉选"导致的同文件间距漂移。

### Sidebar list（侧边栏列表项之间）

| 档位 | className | 用途 |
|---|---|---|
| **2px (`gap-0.5`)** | `<div className="flex flex-col gap-0.5">` | cell **内部** 的 icon+label / 标题+副标题等"同交互单元"堆叠 |
| **6px (`gap-1.5`)** | `<div className="flex flex-col gap-1.5">` | sidebar 的**列表项之间**（nav 项、session row、项目组内 session）—— 默认值 |

**6px 的选择理由：**
- 2px 与 hover bg (`bg-sidebar-accent` ≈ 6% 黑叠加) 边缘融合，扫鼠标时两条 hover 背景融成一条色带
- 8px 在 20 行列表上吃 160px 高度，把"新建会话"挤到 768p 折叠线以下
- 6px 是「最小区分」与「长列表密度」的折中；与行内 `px-3` / `h-8` 构成"外 6 / 内 32 / 内 12"三档节奏

**反模式：**不要混用 — 一个 sidebar 里如果出现 `gap-0.5` 和 `gap-1.5` 交替，肉眼会感知到节奏不齐，肌肉记忆失效。

### Dialog footer（2xl 滚动 dialog 的底部按钮区）

| 模式 | className | 适用场景 |
|---|---|---|
| **有 border + pt** | `<DialogFooter className="shrink-0 gap-2 border-t border-border/50 pt-5 mt-3">` | 2xl 滚动 dialog（provider detail、role mapping 长列表、preset 多步表单） |
| **无 border** | `<DialogFooter className="shrink-0 gap-2">` | 短弹窗（confirm、add-model 单字段） |

**为什么 footer 用 border + pt 而不是单 margin：**单纯 margin 即使 32px 在视觉上仍像"最后一行 + 按钮粘在一起"，间距不传达"分段"。1px anchor + 8px 缓冲让按钮"站在"分隔线肩部，"决策出口"语义成立。

**为什么不在 primitive (`DialogFooter`) 上加 border：**短弹窗（confirm / add-model）不想要 32px 缓冲 + 1px 锚点，primitive 改动会污染它们。**调用方按需传 className，primitive 保持 `flex + gap-2` 的最小契约。**

## 新 Primitive 审批流程

1. 先检查 `ui/` 中是否已有可复用的组件
2. 如需新建，评估是否属于 `ui/`（通用原语）还是 `patterns/`（业务模式）
3. `patterns/` 组件必须是纯展示组件，零副作用，不发请求
4. 提交 PR 时在描述中说明为何现有组件不能满足需求

## 视觉回归测试

- Design System 展示页：`/design-system`（仅 dev 环境）
- Playwright 视觉快照：`npm run test:visual`
- 基线在 CI (Linux) 生成，本地用 `--update-snapshots`
