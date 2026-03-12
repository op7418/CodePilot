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

## 新 Primitive 审批流程

1. 先检查 `ui/` 中是否已有可复用的组件
2. 如需新建，评估是否属于 `ui/`（通用原语）还是 `patterns/`（业务模式）
3. `patterns/` 组件必须是纯展示组件，零副作用，不发请求
4. 提交 PR 时在描述中说明为何现有组件不能满足需求

## 视觉回归测试

- Design System 展示页：`/design-system`（仅 dev 环境）
- Playwright 视觉快照：`npm run test:visual`
- 基线在 CI (Linux) 生成，本地用 `--update-snapshots`
