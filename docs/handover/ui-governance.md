# 设计模式与组件一致性治理

> 完成时间：2026-03-12 | 涉及 92 个文件 | 净减 ~2,900 行

## 治理目标

在保留现有视觉语言的前提下，建立统一的组件分层规则、消灭跨层重复模式、拆分超大组件、通过 ESLint 静态约束防止退化。

## 分层架构

```
src/components/ui/          → 纯 primitives（Button, Input, Select, Dialog…）
src/components/patterns/    → 复用展示模式（SettingsCard, FieldRow, StatusBanner…），零副作用
src/components/{feature}/   → 组合 hooks + patterns + 业务状态
src/app/                    → 页面装配
src/hooks/                  → 数据获取、状态管理
src/lib/constants/          → 纯数据常量，不引用 UI 层
```

## 已完成的治理项

### 1. ESLint 治理规则 (`eslint.config.mjs`)

| 规则 | 级别 | 作用域 | 说明 |
|------|------|--------|------|
| 禁止原生 HTML 控件 | warn | 业务组件 + app 层 | `<button/input/select/textarea>` → 使用 `ui/` 组件 |
| 禁止 Lucide 导入 | error | `src/**` | 统一使用 Phosphor，通过 `ui/icon.tsx` 入口 |
| 禁止直接引用 Phosphor | warn | 业务组件 + hooks | 应从 `@/components/ui/icon` 导入 |
| 组件文件行数上限 500 | warn | `src/components/**`（排除 ui/、ai-elements/） | `skipBlankLines + skipComments` |
| Patterns 层隔离 | error | `src/components/patterns/**` | 禁止导入 `@/hooks/*` 和 `@/lib/*`（允许 `@/lib/utils`） |
| 外部资料目录排除 | — | `资料/**` | 不参与主仓 lint |

### 2. 图标统一 (`src/components/ui/icon.tsx`)

- 所有业务组件通过 `@/components/ui/icon` 统一入口导入 Phosphor 图标
- 目前导出 86+ 个图标 + `ICON_SIZE` 常量 + `Icon`/`IconProps` 类型
- `types/index.ts` 中的 `IconComponent` 类型与 Phosphor 解耦，使用泛型 SVG 签名
- 图标与命令数据分离：`lib/constants/commands.ts`（纯数据）+ `lib/constants/command-icons.ts`（图标映射），在 `hooks/useSlashCommands.ts` 中合并

### 3. 颜色 token 治理 (`globals.css` + `lint:colors`)

新增语义 token（light + dark）：

```
--status-success-{muted,foreground,border}   （原 green-*）
--status-warning-{muted,foreground,border}   （原 orange/yellow/amber-*）
--status-error-{muted,foreground,border}     （原 red-*）
--status-info-{muted,foreground,border}      （原 blue-*）
```

- Tailwind v4 通过 `@theme inline` 中的 `--color-status-*` 变量注册
- `npm run lint:colors` 检查 `green/emerald/red/orange/yellow/amber/blue-{400-700}` 用法
- 例外行标注 `// lint-allow-raw-color`（如 diff 语法高亮、终端提示符）

### 4. Patterns 层 (`src/components/patterns/`)

| 组件 | 用途 |
|------|------|
| `SettingsCard` | 统一的设置卡片容器（title + description + children） |
| `FieldRow` | 设置项行布局（label + description + 右侧控件） |
| `StatusBanner` | success/warning/error/info 状态横幅 |
| `EmptyState` | 空状态占位（icon + title + description + action） |
| `CommandList` | 斜杠命令列表弹窗 |

### 5. 超大组件拆分

| 组件 | 原始行数 | 当前行数 | 抽出的子模块 |
|------|---------|---------|-------------|
| MessageInput | 1,659 | 444 | `MessageInputParts`, `SlashCommandPopover`, hooks: `useChatCommands`, `usePopoverState`, `useSlashCommands`, `useCliToolsFetch`, `useCommandBadge`, libs: `message-input-logic`, `file-utils` |
| ChatView | ~850 | 419 | `useStreamSubscription`, `useAssistantTrigger` |
| ProviderManager | 1,081 | ~406 | `provider-presets`, `PresetConnectDialog`, `useProviderModels` |
| AppShell | 527 | 470 | `useUpdateChecker` |
| AssistantWorkspaceSection | 908 | 499 | `WorkspaceTabPanels`, `WorkspaceConfirmDialogs`, `WorkspaceStatusCards`, `workspace-types` |
| ChatListPanel | 677 | 484 | `SessionListItem`, `ProjectGroupHeader`, `chat-list-utils` |

### 6. 原生 HTML 控件迁移

38 个文件中 80 处原生 `<button/input/textarea/select>` 替换为 `ui/Button`、`ui/Input`、`ui/Textarea`、`ui/Select`。

### 7. Hook 依赖与死代码清理

- 修复 `react-hooks/exhaustive-deps` 和 `react-hooks/set-state-in-effect` 共 22 处
- 清除 unused imports/variables 共 7 处
- AppShell 中 5 个 `set-state-in-effect` 错误通过 lazy initializer、derived state、`eslint-disable-next-line` 组合解决

## 新增文件清单

### 组件
- `src/components/patterns/CommandList.tsx`
- `src/components/chat/MessageInputParts.tsx`
- `src/components/chat/SlashCommandPopover.tsx`（重构）
- `src/components/layout/SessionListItem.tsx`
- `src/components/layout/ProjectGroupHeader.tsx`
- `src/components/layout/chat-list-utils.ts`
- `src/components/settings/provider-presets.tsx`
- `src/components/settings/PresetConnectDialog.tsx`
- `src/components/settings/WorkspaceTabPanels.tsx`
- `src/components/settings/WorkspaceConfirmDialogs.tsx`
- `src/components/settings/WorkspaceStatusCards.tsx`
- `src/components/settings/workspace-types.ts`

### Hooks
- `src/hooks/useAssistantTrigger.ts`
- `src/hooks/useChatCommands.ts`
- `src/hooks/useCliToolsFetch.ts`
- `src/hooks/useCommandBadge.ts`
- `src/hooks/usePopoverState.ts`
- `src/hooks/useProviderModels.ts`
- `src/hooks/useSlashCommands.ts`
- `src/hooks/useStreamSubscription.ts`
- `src/hooks/useUpdateChecker.ts`

### Lib
- `src/lib/constants/commands.ts`
- `src/lib/constants/command-icons.ts`
- `src/lib/file-utils.ts`
- `src/lib/message-input-logic.ts`

## 当前 Lint 状态

- **治理涉及文件**：0 errors, 0 warnings
- **全仓**：0 errors, 80 warnings（均在未涉及的文件中：tests、api routes、lib、ai-elements）
- **Typecheck**：通过
- **Unit tests**：374 pass, 0 fail

## 已知遗留（不在本轮治理范围）

1. **ai-elements 层**：`prompt-input.tsx`（1,345L）仍含 30+ thin re-export wrappers；`file-tree.tsx` 有可访问性 warning
2. **全仓 80 warnings**：主要是 tests 中的死代码、bridge adapters 中的 unused vars、`stream-session-manager.ts` 中的 unused imports
3. **CodeBlock 两套并存**：`chat/CodeBlock.tsx`（Prism）和 `ai-elements/code-block.tsx`（Shiki），计划统一为 Shiki
4. **`catch { // ignore }` 模式**：50+ 处静默错误，需逐步加 toast 或 console.warn

## 开发者须知

- 新建业务组件时，从 `@/components/ui/icon` 导入图标，不要直接引 `@phosphor-icons/react`
- 颜色使用语义 token（`text-status-success-foreground`），不用裸色值（`text-green-500`）
- 新 pattern 组件放 `patterns/`，不引 hooks/lib（除 `@/lib/utils` 的 `cn()`）
- 组件超过 500 行时考虑拆分
- 提交前运行 `npm run test` + `npm run lint:colors`
