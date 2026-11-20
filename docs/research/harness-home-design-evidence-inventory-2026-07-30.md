# Harness Home Design Method — 真实证据候选清单

> 日期：2026-07-30
> 状态：已有 4 组真实产品 brief / accepted / rejected 证据；**能证明既有产品取舍，尚不能自动等同于用户的通用个人审美**
> 历史执行计划：harness-home-design-method.md（2026-08-04 已被 Capability Package/Broker / `creative` reference package 方向接管，本清单仅作研究证据）

## 用途与纪律

本清单只整理仓库里已经存在、能回到用户原话或已落地产品决策的材料。它可以作为 CodePilot Design Method v0 的候选输入，但在用户确认“这确实是我的通用方法”之前：

- 不创建 confirmed built-in Method；
- 不创建 durable user preference；
- 不把单个项目决策跨项目传播；
- 不把模型总结当作用户原话；
- 不用“高级、优雅、电影感”等不可验收形容词替代 criterion。

## Brief 1 — macOS 平台感，但产品内容不分叉

- **source ref**
  - `docs/insights/macos-visual-profile.md`
  - `docs/handover/macos-visual-profile.md`
- **真实 brief**：在用户看得见的壳层体现 macOS 平台特色，同时保持页面内容、信息架构与设计语言跨平台一致。
- **accepted**
  - 平台特色落在 window chrome、顶栏、侧栏、Composer 外壳和浮层；
  - 产品内容层保持稳定、不透明、可读；
  - 用 platform token + shared primitive 解决重复观感问题。
- **rejected / counterexample**
  - 为平台感重写原生宿主；
  - 给聊天、代码、表单等 content layer 全面加玻璃；
  - 为 macOS 复制一套页面；
  - 把 DOM 浮层误写成 Electron per-surface vibrancy。
- **可验证的选择理由**：用户原话明确要求“背景材质和独特样式体现平台特色”，但“页面里的细节维持一套同样的设计语言和风格”。
- **candidate principles**
  - 平台差异优先进入 shell，而不是 product content；
  - 视觉材料必须服从信息层级与可读性；
  - 同类观感问题反复出现时，优先寻找共享 primitive。
- **适用 scope**：CodePilot platform shell。
- **Method 状态**：`candidate`；“可迁移到其他设计任务吗”待用户确认。

## Brief 2 — Chat 是 Agent 工作入口，不是按钮收纳柜

- **source ref**
  - `docs/insights/chat-composer-redesign.md`
  - `docs/handover/chat-composer-redesign.md`
- **真实 brief**：让用户把注意力放在输入与任务，而不是在发送前逐个检查 Runtime、模式、权限、工具和健康状态。
- **accepted**
  - 输入框是主入口；
  - 非 AI 的确定性控制（权限、模型、上下文、发送）可见但克制；
  - AI 能调度的 Agent / MCP / CLI / Skill 按意图出现；
  - 正常状态不抢注意力，异常才展开；
  - Run 面板解释本次运行，不变成第二个 Settings。
- **rejected / counterexample**
  - 状态、模式、能力、命令都平铺成常驻按钮；
  - 常态绿色健康度长期占据视觉焦点；
  - “已固定”使用高对比主色 chip；
  - 模型列表为不明确需求先加搜索框。
- **可验证的选择理由**
  - 用户原话指出页面“心智上有点吵”；
  - 用户明确担心常驻健康警示制造心理负担；
  - 用户多轮要求降低“已固定”的视觉权重。
- **candidate principles**
  - 默认无形，异常才上色；
  - 用户硬指令必须显式，AI 可调度能力按意图披露；
  - 主动作之外的元素必须证明其常驻价值。
- **适用 scope**：CodePilot Chat / Agent interaction。
- **Method 状态**：其中五条 Chat 原则已是明确产品基线；是否抽象为跨产品通用 Design Method 待用户确认。

## Brief 3 — 图标先解决语义，再解决换皮

- **source ref**
  - `docs/insights/icon-system.md`
  - `docs/handover/icon-system.md`
- **真实 brief**：同一个图标承载多个概念、同一概念使用多个图标，导致产品缺乏自己的视觉语言。
- **accepted**
  - 建立 CodePilot semantic icon layer；
  - model / memory、runtime / quick action、CLI / terminal 分开；
  - 品牌图标保留品牌来源；
  - 通过 lint guardrail 防止语义回潮。
- **rejected / counterexample**
  - 全仓机械替换图标库；
  - 用通用 glyph 冒充品牌；
  - 缺图时临时混入第三套图标库；
  - 继续让 Brain / Lightning / Terminal 跨概念复用。
- **可验证的选择理由**：用户明确指出“同一个图标被到处复用，表意不清”；现有决策把问题定义为语义冲突，不是单纯“不好看”。
- **candidate principles**
  - 视觉系统先建立语义层，再选择表现供应商；
  - 视觉一致性需要可执行 guardrail，不靠记忆；
  - 品牌识别与产品语义分层治理。
- **适用 scope**：CodePilot product semantics / iconography。
- **Method 状态**：`candidate`；是否属于用户更广泛的品牌方法待确认。

## Brief 4 — 用户资产忠实，表现层可派生

- **source ref**
  - `docs/insights/markdown-live-preview-file-tree.md`
  - `docs/insights/phase-4-markdown-artifact.md`
  - `docs/handover/markdown-live-preview-file-tree.md`
- **真实 brief**：提高 Markdown 的阅读和编辑体验，但不污染用户文件、不制造有损副本，也不把导出入口塞进日常主路径。
- **accepted**
  - Markdown 是事实源，HTML 是可重复派生的表现；
  - Live Preview 保留原文、保存、diff 和长文虚拟化；
  - 文件类型图标帮助窄侧栏识别，文件夹用结构箭头避免重复；
  - 文件改名/删除走跨 owner transaction，兑现“可恢复”承诺。
- **rejected / counterexample**
  - 用 ProseMirror 富文本成为主数据；
  - 用五套 Markdown presentation 主题制造选择；
  - 将样式 hint 写回 Markdown；
  - 在用户两次质疑后仍把 Save HTML 放回 Preview 头部。
- **可验证的选择理由**
  - 用户资产需要长期可用、AI 可消费、可 diff、可版本控制；
  - Save HTML 两次被用户直接质疑，最终 deferred；
  - 窄侧栏每个像素需要明确职责。
- **candidate principles**
  - 用户数据忠实优先于表现层便利；
  - 派生产物与事实源分离；
  - 可恢复、安全、授权等文案承诺必须由真实 transaction 支撑；
  - 被用户重复拒绝的入口不能靠实现惯性复活。
- **适用 scope**：CodePilot documents / artifacts / asset materialization。
- **Method 状态**：`candidate`；其中 source-of-truth / derived-output 已是本产品明确原则。

## C0 当前覆盖与缺口

已覆盖：

- 4 个真实 creative/product briefs；
- 每个 brief 的 accepted / rejected / reason / scope / candidate principle；
- 至少一个明确用户原话或已落地决策 source；
- 可转为 golden-set 的真实反例。

仍缺：

- 用户确认哪些原则属于“我的通用设计方法”，哪些只属于当时的 CodePilot 项目；
- 每个 brief 对应的最终图片、视频或页面 Asset ID；
- 同 brief 下至少两个真正不同方向的成套输出；
- image → video 的真实成功与失败案例；
- 用户对字体、色彩、构图、材质、运动节奏的具体选择理由；
- 3–5 个 baseline vs Method 的 golden runs。

## 待用户确认的问题

1. “默认无形，异常才展开”是否是你的通用界面原则，还是只适用于 Agent Chat？
2. “先建语义层，再选视觉供应商”是否应进入品牌/图标之外的组件与动效方法？
3. “用户资产忠实、表现层派生”是否也适用于图片、视频和网页工作流？
4. macOS shell 的“平台特色只进壳层”是否要推广为所有平台适配的默认方法？
5. 你最希望首个 golden brief 验证网页、图片系列，还是 image-to-video？

这些问题未回答前，代码只提供 candidate / confirmed 状态、证据解析和按需投影能力，不预装 confirmed Method pack。
