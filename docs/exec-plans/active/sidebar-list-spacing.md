# Sidebar list + 角色映射 footer 间距

> 状态：已完成 · 提交：见 `git log worktree-product-refactor-research`
> 范围：`src/components/layout/ChatListPanel.tsx` (3 行) + `src/components/settings/ModelsSection.tsx` (1 行) + `src/components/settings/PresetConnectDialog.tsx` (1 行) + `docs/ui-governance.md`

## 1. 问题

`worktree-product-refactor-research` 分支上两个相邻元素无视觉分段的问题：

| # | 位置 | 症状 |
|---|---|---|
| A | `ChatListPanel` 中三处 `flex flex-col`（项目/助理分组、session 列表） | 相邻 list item 的 hover 背景融成一条无分隔的色带 |
| B | `ModelsSection` 的「角色映射」Dialog | 取消/保存按钮紧贴上方最后一个模型设置行 |
| C | `PresetConnectDialog` 的 footer | Test / Connect 按钮与上方 form 字段无分隔 |

根因：所有这些容器/footer 用了 `flex flex-col` 或 `DialogFooter` 但**没声明 gap 或 border**。同文件 `SessionListItem` L224 用 `gap-0.5` (2px)，但其他三处没继承这个约定 —— 是不一致，不是失误。

## 2. 修复

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/components/layout/ChatListPanel.tsx` | 3 处 `flex flex-col` → `flex flex-col gap-1.5`（6px） | 3 行 className |
| `src/components/settings/ModelsSection.tsx` | `<DialogFooter>` 加 `shrink-0 gap-2 border-t border-border/50 pt-5 mt-3`（32px 堆叠 + 分隔线） | 1 行 className |
| `src/components/settings/PresetConnectDialog.tsx` | 同上（preset 弹窗 footer） | 1 行 className |
| `docs/ui-governance.md` | 新增「间距规范」一节 | +30 |

总代码改动：**5 行 Tailwind className**。零业务逻辑变更。

## 3. 间距选型

### Sidebar 6px（`gap-1.5`）

| 候选 | 视觉效果 | 长列表代价 | 决定 |
|---|---|---|---|
| 2px (`gap-0.5`) | 与 hover bg 边缘融合，仍是「一坨」 | 0 | ❌ 问题没解决 |
| **6px (`gap-1.5`)** | **hover 边缘清晰分隔，行高仍紧凑** | **20 行 = 120px** | ✅ |
| 8px (`gap-2`) | 略松 | 20 行 = 160px，开始挤掉「新建会话」入口 | ❌ |

### Dialog footer 32px（`pt-5 mt-3`）

不用「margin-only」是因为滚动到列表底部时，**最后一行 + 按钮之间如果只有 margin，视觉上仍然像粘在一起** —— 间距不传达「分段」。`border-t + pt` 给一个 1px 锚点 + 8px 缓冲，加 mt-3 让 anchor 落在按钮的"肩部"而非"胸腔"。

## 4. 不改 `DialogFooter` primitive

`DialogFooter` 仍被短弹窗（confirm / add-model）复用。在 primitive 上加 `pt-5 + border-t` 会污染这些短弹窗 —— 一个 2-button 的 confirm 弹窗在按钮上方出现一根孤零零的分隔线会很怪。

约定：**footer 视觉锚点是滚动型 dialog 才需要**。调用方按需传 className，primitive 保持 `flex + gap-2` 的最小契约。

## 5. 验证

按 `CLAUDE.md` Tier 0 分层（无 Playwright / 无 CDP）：

| Gate | 结果 |
|---|---|
| `npm run typecheck` | ✅ 0 错 |
| `npm run test:unit` | ✅ baseline pass |
| 视觉 | ⏸ reviewer 本地 `npm run electron:dev` 复跑 |

### 反例 smoke（reviewer 本地）

| 场景 | 期望 |
|---|---|
| 项目分组：0 个项目 / 1 个项目 / 5 个项目 | 间距一致，hover 不融合 |
| Session 列表：滚动 50 行 | 最后一行 hover 不被 footer 截断 |
| 项目分组折叠 | 折叠态无空白 gap（容器高度 = 子项之和） |
| 角色映射弹窗：1 个 role / 5 个 role / 10 个 role | footer 始终贴在底部，body 单独滚动 |
| 角色映射弹窗：宽屏 1440 / 窄屏 1024 | 32px footer 间距不与左右 padding 冲突 |
| Preset 弹窗：Advanced 展开 / 折叠 | footer 始终在底部，model mapping 与按钮有 32px 间距 |
| 添加模型弹窗（短弹窗，无 border） | 视觉不受影响（确认 primitive 不被污染） |

## 6. 范围之外

- **不**重做整个 sidebar 排版（line-height / row hover 颜色 / row 内 padding）—— 那是独立的设计语言梳理任务
- **不**改其他 Dialog 的 footer
- **不**做 hover 状态的颜色对比度审计 —— 那是独立 a11y pass

## 7. 决策日志

| 时间 | 决策 | 备选 | 取舍 |
|---|---|---|---|
| v1 (执行前) | sidebar `gap-0.5` (2px) / footer `pt-3 mt-2` (20px) | — | 起点 |
| v2 (review 反馈) | sidebar `gap-1.5` (6px) / footer `pt-5 mt-3` (32px) | 8px / 24px | review 觉得 v1「视觉上没分段」，bump 一次到位而非渐进 |
| 选型原则 | 改 className 不改 primitive | primitive 改 + 短弹窗 opt-out | primitive 改动有跨文件回归风险 |
| 文档位置 | `ui-governance.md` 一节 | `design.md` (旧) / mega-doc | ui-governance.md 是当前 contract 入口，与 4-layer 架构、icon 策略并列 |
| Preset 弹窗也改 | 同 ModelsSection role mapping | 只改 role mapping | 同 2xl 滚动结构，同样问题，一致修复 |
| 范围 | 5 行 className | 顺手重做 dialog 滚动结构 | 滚动结构是独立设计语言梳理，独立 PR |
