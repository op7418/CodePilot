# Sidebar 密度 vs Dialog 节奏

> 与 `docs/exec-plans/active/sidebar-hover-and-role-mapping-footer-spacing.md` 互为反向链接。
> 本文是 **why**，exec plan 是 **what**。

## 共同的设计失败模式

两个看起来无关的 bug —— 侧边栏 hover 重叠、角色映射 footer 紧贴 —— 其实是同一个失败模式的两个表现：**「容器是 `flex flex-col`」被当成"自动有节奏"的隐含约定**。

CSS 的 `display: flex` 不带 gap 时，子项是 `0px` 间距。代码里写 `flex flex-col` 看起来"反正 flex 嘛"，但如果项目里有一个地方写了 `gap-0.5`、另一个地方没写，就出现 **同文件间距漂移**。在浅色主题下 `0px` vs `2px` 几乎看不出区别，直到 hover 背景把它们之间的差别放大成"无缝融合"。

## 为什么 hover 重叠是 sidebar 特有的

`bg-sidebar-accent` 在 light 主题下大概是 6% 黑色叠加。**两段 6% 黑叠加 + 0px 间距 = 一段 12% 黑色色带**。人眼看到的不是"两个 hover 状态"，而是"一段色带"。

这是 sidebar 的特殊语境：
- 长列表（10–50 行）
- 高频 hover（鼠标扫描导航很常见）
- 行高紧凑（`h-8` ≈ 32px）—— 给 0px 误差的容错空间小

`SessionListItem` 内部 L224 用 `gap-0.5` 是因为作者明确考虑了 hover；外层容器没继承这个考虑，是设计 **默认假设** 和 **实际语境** 的脱节。

## 为什么 footer 紧贴是 Dialog 特有的

Dialog 的 footer 不像 sidebar 那样是「列表项之一」，它是 **退出语义** —— 用户滚到底做决策。决策按钮紧贴最后一行配置项，意味着"我做的改动可能没保存"和"我做出的决策"挤在同一个视觉带里。

正确的视觉语言是 **"配置区"和"行动区"分段**。一根 1px border 就能完成这个分段 —— 它的视觉权重刚好够、不抢戏、不需要用色块或背景来强化。

## "小问题"为什么值得写规范

如果只 patch className 收工，下一个 PR 还会撞同一个坑。把"6px 是 sidebar list 的标准 gap"和"32px + border 是 2xl dialog footer 的标准节奏"写进 `docs/design.md`，下次有人在 sidebar 加 list、加 dialog，**类比就有锚点**，不会凭直觉从 0/2/4/8 里随机选一个。

规范的价值不是约束，是 **省一次设计讨论**。

## 反向 case：什么时候 2px / 20px 是对的

- **2px**：cell 内部的元素（比如 icon + label），因为它们在同一个交互单元里，不应该被"分隔"
- **20px (pt-3 mt-2)**：非滚动的短弹窗（confirm dialog），body 就 1–2 行，footer 自然"就在"body 下面，border 会显多余

规范覆盖的是 **90% 的 case**。剩下 10% 写明"为什么是例外"比"硬要套规范"更健康 —— 这也是为什么 footer 规范只在调用方用 className 加，不下沉到 primitive。

## 不在这次范围

- hover 颜色对比度（独立 a11y pass）
- 其他 Dialog 的 footer 节奏统一（独立 PR）
- sidebar 排版语言整体梳理（独立设计 sprint）

这次只修「容器的 gap 缺失」这一类 bug，不顺手扩大战场。
