# Sidebar list spacing — 2px → 6px

> 状态：已完成 · 提交：`3285fa3 fix(ui): bump sidebar list gap from 2px to 6px` + `bc0c857 docs(ui-governance): add spacing convention`
> 范围：`src/components/layout/ChatListPanel.tsx` (2 行) + `docs/ui-governance.md` (新增 1 节)

## 1. 问题

`ChatListPanel` 中两处 sidebar 列表用 `flex flex-col gap-0.5`（2px）。2px 是 cell **内部** stack 的标准（icon+label、title+subtitle），但用于 **列表项之间** 偏紧：浅色主题下 hover 背景 `bg-sidebar-accent` (≈ 6% 黑叠加) 边缘与 2px 间隔融合，扫鼠标时两条 hover 背景读作"一段色带"，看不出"这是两条独立条目"。

## 2. 改动

| 文件 | 行 | 改动 |
|---|---|---|
| `src/components/layout/ChatListPanel.tsx` | L470 | `gap-0.5` → `gap-1.5`（feature nav items） |
| `src/components/layout/ChatListPanel.tsx` | L598 | `gap-0.5` → `gap-1.5`（项目组内 session 列表） |
| `docs/ui-governance.md` | — | 新增"间距规范"一节，把规则写入 design system contract |

总代码改动 = 2 行 Tailwind className。

## 3. 选型

| 候选 | 视觉 | 长列表代价 | 决定 |
|---|---|---|---|
| 2px (`gap-0.5`) | 与 hover bg 融合 | 0 | ❌ 问题没解决 |
| **6px (`gap-1.5`)** | **清晰分隔** | **20 行 = 120px** | ✅ |
| 8px (`gap-2`) | 略松 | 20 行 = 160px，挤掉"新建会话"入口 | ❌ |

6px 与行内 `px-3` / `h-8` 构成"外 6 / 内 32 / 内 12"三档节奏。

## 4. 不改的地方

- **`SessionListItem.tsx:218` 仍是 `gap-0.5`**：这是 cell 内部 stack（图标+标题+副标题），按"外 6 / 内 2"分层设计。
- **`ModelsSection` / 角色映射 dialog footer**：原 bug 报告里的 dialog 在新架构已被 refactor 掉（`ModelsSection.tsx` 整个文件已删除，role mapping 拆为 `ProviderForm` JSON 文本域 + `PresetConnectDialog` 多字段）。该 bug 在 main 上不再存在，本 PR 不涉及。
- **`PresetConnectDialog` 的 footer**：已是 2xl 滚动结构但 footer 没 border + pt，肉眼判断是否过紧需要 dev 模式实看，**不在本 PR 范围**。下一轮视觉 pass 一起处理。

## 5. 验证

| Gate | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错（`rm -rf .next` 后清理 33 个 stale validator 错误，与本 PR 无关） |
| `npm run test:unit` | ✅ baseline pass |
| dev 视觉 | ⏸ reviewer 本地 `npm run electron:dev` 复跑 |

### Reviewer 视觉 smoke（< 1 分钟）

1. 打开 sidebar → 鼠标在两个 feature nav 之间扫 → 期望两条 hover 背景清晰分隔
2. 展开任一项目组 → 鼠标在两个 session row 之间扫 → 期望同上
3. 折叠项目组 → 期望折叠态无空白 gap
4. 单看一个 session row 内部（icon + 标题）→ 期望 **未变**，仍是紧贴的 2px

## 6. 决策日志

| 时间 | 决策 | 备选 | 取舍 |
|---|---|---|---|
| v1 (旧 base `48df4d6`) | 修 3 处 `flex flex-col` 加 `gap-0.5` (2px) | — | 在 bug 报告的分支上 |
| v1.5 (review 反馈) | bump 到 `gap-1.5` (6px) | 4px / 8px | 用户视觉判断 2px 不够 |
| v2 (新 base `9678e01`) | 只动 2 处（feature nav + session list）；项目分组结构已重写 | 全文件扫描 | 边界明确：动 list 容器，不动 cell 内部 |
| 文档位置 | `ui-governance.md` 顶部一节 | `design.md` (旧) | 新架构用 ui-governance.md 替代 design.md 作 contract |
| 不动 Primitive | `DialogFooter` 不下沉 border | primitive 改 | 短弹窗会污染 |

## 7. 链接

- 设计规范（contract）：`docs/ui-governance.md` §「间距规范」
- 产品反向链接（context）：`docs/insights/sidebar-list-2px-vs-6px.md`
