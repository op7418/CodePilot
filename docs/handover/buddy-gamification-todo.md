# Buddy 游戏化待办 — 视觉与流程打磨

> 前置：buddy 系统核心已实现（生成/稀有度/属性/进化/命名/看板/通知）
> 本轮完成：3D 视觉统一、心跳双模式、调度器健壮性、通知链路、安全修复（详见 [buddy-gamification.md](buddy-gamification.md)）
> 本文档记录剩余"视觉上不够游戏化"的点，按链路顺序排列

## 一、孵化流程

### 1.1 孵化后起名字
**现状**：孵化成功的消息/widget 直接展示 buddy 信息，没有起名环节
**应该**：孵化成功 → widget 里加名字输入框 → 用户起名 → 确认 → 名字同步到看板/侧栏/聊天头像
**文件**：`hatch-buddy/route.ts`（API 接受 buddyName）、`context-assembler.ts`（widget HTML）、`WidgetRenderer.tsx`（postMessage handler 传 buddyName）

### 1.2 孵化 Widget 设计不够游戏化
**现状**：纯 HTML div + 按钮，像表单不像游戏
**应该**：
- 蛋有更明显的摇晃动画（CSS 弹跳 + 光效）
- 点击后有"裂开"动画过渡（CSS transition）
- 揭晓时有撒花/粒子效果
- 整体色调和氛围更温暖

### 1.3 孵化详情 Widget 不够游戏化
**现状**：纯文本 + 进度条，像数据面板
**应该**：
- 等级/稀有度用胶囊形标签（pill badge）展示，带渐变色
- 属性条上方一句话概括性格（"一只敏锐的猫咪，擅长洞察问题本质"）
- 属性条用更游戏化的视觉（渐变色、圆角更大、数字更突出）
- 整体布局更像游戏角色卡

### 1.4 重置 buddy 测试入口
**现状**：无法重新孵化（除非手动删 state.json 的 buddy 字段）
**应该**：设置页 buddy 预览区域加"重新孵化"按钮（开发/调试用，或者作为"放生重养"功能）
**文件**：`AssistantWorkspaceSection.tsx`

## 二、新用户 Wizard → 首次对话

### 2.1 Wizard Step 3 揭晓不够惊喜
**现状**：瞬间显示 emoji + 属性条
**应该**：
- 有一个"蛋裂开"的过渡动画（0.5-1s）
- 属性条逐个展开（stagger animation）
- 稀有度揭晓有特殊效果（传说级闪光、史诗级紫光）

### 2.2 首次进入聊天 buddy 不自我介绍
**现状**：Wizard 完成 → 空白聊天 + Quick Actions，buddy 沉默
**应该**：context-assembler 检测到 buddy 存在 + 会话为空 → 注入"首次见面"prompt → AI 用 buddy 性格说第一句话
**注意**：和 `buildNoBuddyWelcome`（无 buddy）互斥，这是另一个分支（有 buddy + 新会话）
**文件**：`context-assembler.ts`、`useAssistantTrigger.ts`（可能需要新增 autoTrigger 条件）

## 三、日常使用

### 3.1 看板 Buddy 卡不够游戏化
**现状**：功能性展示（名字/属性条/状态行）
**应该**：
- 稀有度胶囊标签（带渐变背景色，不只是文字颜色）
- 性格概括语（"一只善于洞察的猫咪"放在名字下方）
- 属性条样式升级（渐变色填充，peak stat 更突出）
- 进化进度条更醒目（接近满时闪烁/发光）
- 卡片整体更像游戏角色面板

### 3.2 侧栏 buddy 展示单薄
**现状**：emoji + 名字，第二行灰色路径
**可选优化**：第二行改为性格概括或稀有度标签（替代路径，路径不重要）

### 3.3 聊天头像不够精致
**现状**：boring-avatars（物种 variant + 稀有度色板）+ 右下角 emoji
**可选优化**：emoji 覆盖更大（不只是右下角小图标），或者整体换一种展示方式

## 四、进化体验

### 4.1 进化弹窗/Widget
**现状**：点"检查进化" → API 返回 → reload
**应该**：点击后在聊天中输出一条带 show-widget 的进化动画消息（旧形态 → 新形态的过渡）

### 4.2 进化后的变化感知
**现状**：稀有度和属性数字变了，视觉上不明显
**应该**：
- 看板卡片边框色变化（从蓝变紫、从紫变金）
- 侧栏可能有短暂的闪光效果
- 聊天头像色板变化

## 五、通知氛围

### 5.1 里程碑消息不够特别
**现状**：纯文本"🐱 Toki：里程碑！我们一起积累了 50 条记忆！🎉"
**应该**：show-widget 里程碑卡片（数字大号展示 + 动效）

### 5.2 定时任务通知不够 buddy 化
**现状**：消息前缀加了 buddy emoji + name
**可选优化**：通知卡片带 buddy 头像 + 气泡样式（像 buddy 在说话）

## 六、整体设计语言

### 需要统一的游戏化元素
- **胶囊标签（pill badge）**：稀有度、等级、属性值都用统一的胶囊样式
- **渐变色**：稀有度从灰→绿→蓝→紫→金的渐变
- **动效规范**：揭晓时 0.5s 弹出、属性条 stagger 展开、闪光效果
- **卡片框架**：圆角 16px + 内边距 24px + 稀有度底色 + 微阴影
- **字体层级**：名字 18px 加粗、种类 13px、属性标签 11px
- **配色**：每个稀有度一套完整色板（背景/边框/文字/高亮）

## 七、文件参考

| 文件 | 涉及 |
|------|------|
| `src/lib/context-assembler.ts` | 孵化 widget HTML、首次见面 prompt |
| `src/app/api/workspace/hatch-buddy/route.ts` | 孵化后消息 + widget |
| `src/components/assistant/OnboardingWizard.tsx` | Wizard Step 3 揭晓 |
| `src/components/layout/panels/DashboardPanel.tsx` | 看板 buddy 卡 |
| `src/components/layout/ProjectGroupHeader.tsx` | 侧栏 buddy 展示 |
| `src/components/chat/MessageItem.tsx` | 聊天头像 |
| `src/components/ui/AssistantAvatar.tsx` | 头像组件 |
| `src/components/settings/AssistantWorkspaceSection.tsx` | 设置页 buddy 预览 |
| `src/lib/buddy.ts` | 所有 buddy 数据定义 |
