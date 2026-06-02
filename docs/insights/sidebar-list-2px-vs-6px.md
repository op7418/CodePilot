# Sidebar list 间距：2px vs 6px

> 与 `docs/exec-plans/active/sidebar-list-spacing.md` 互为反向链接。
> 本文是 **why**，exec plan 是 **what**。

## 共同的设计失败模式

"`flex flex-col` 没声明 gap 时是 0px 间距" 这件事在 CSS 里是默认行为，但人写代码时容易把 "flex" 当成"自动有节奏" 的隐含约定。`SessionListItem` 内部用 `gap-0.5`、外层容器也用 `gap-0.5` 时，看着"反正都是 gap-0.5 一致"——但**它们是不同语境下的 0.5**：

- **cell 内部**（icon + label、title + subtitle）：同一个交互单元里的元素，必须**紧贴**，2px 才对
- **list 容器**（nav 项、session row）：不同交互单元之间，必须**清晰分隔**，2px 不够

把它们 collapse 成同一个值，混用 = 节奏混乱。

## 为什么 hover 重叠是 sidebar 特有的

`bg-sidebar-accent` 在 light 主题下大概 6% 黑色叠加。**两段 6% 黑叠加 + 0~2px 间距 = 一段 12% 黑色色带**。人眼看到的不是"两个 hover 状态"，而是"一段色带"。

这是 sidebar 的特殊语境：
- 长列表（10–50 行）
- 高频 hover（鼠标扫描导航很常见）
- 行高紧凑（`h-8` ≈ 32px）—— 给 0~2px 误差的容错空间小

## 为什么 6px 是 sidebar 列表的"最小可读分隔"

- **2px** 与 6% 黑叠加的 hover bg 边缘融合，色带无法被拆成两条
- **4px** 浅色下勉强可读，但深色主题下 token 透明度变化，4px 又掉到边缘融合区间，**不可靠**
- **6px** 是 6% + 12% 黑叠加之间能形成"两段色带"感知的最小物理距离；与 `px-3` (12px) / `h-8` (32px) 构成"外 6 / 内 32 / 内 12"三档节奏，视觉上不冲突
- **8px** 在单行看略松，**但在 20 行列表上累计 160px**，把"新建会话"挤到 768p 折叠线以下 —— 高频用户最常用的入口被推下去，是反 UX 的

## 为什么不在 `DialogFooter` primitive 上加 border

`DialogFooter` 被两类 dialog 共用：
- **2xl 滚动 dialog**（provider detail、role mapping 长列表、preset 多步表单）：footer 是"决策出口"，需要 32px 缓冲 + 1px 锚点
- **短弹窗**（confirm、add-model 单字段）：footer 是"看一眼就关"，再加 border + 32px 是噪音

Primitive 一改，两边都被污染。**调用方按需传 className，primitive 保持 `flex + gap-2` 的最小契约**。这是 "primitive 干净，policy 在调用方" 的标准做法。

## 不在这次范围

- `PresetConnectDialog` 的 footer 是否需要 border + pt：肉眼判断需要 dev 模式实看，**下一轮视觉 pass 一起做**
- `ProviderForm`（短表单）footer：保持无 border 是对的
- hover 颜色对比度审计：独立 a11y pass
- sidebar 排版语言整体梳理：独立设计 sprint

## 这次 PR 没做的"另一个 bug"

用户最初报告的"角色映射 dialog footer 紧贴"在 main 上**已经不存在**：原 `ModelsSection.tsx` 整个文件被 refactor 掉，role mapping 拆成了 `ProviderForm` 里的 JSON 文本域（短表单）和 `PresetConnectDialog` 里的多字段（中等长度）。bug 报告时所在的 `worktree-product-refactor-research` 分支还停在 309 个 commit 前的快照上，那个 dialog 早就不在了。

教训：**报告 bug 前先确认 base**。这次的 fix commit 只动了 sidebar list，dialog 部分留给 reviewer 在新架构下重新评估。
