# macOS 平台视觉层 — 产品思考

>
> 对应执行计划：docs/exec-plans/completed/phase-7b-macos-native-visual-profile.md（macOS 平台视觉）+ docs/exec-plans/completed/phase-7c-card-primitive.md（浮动卡片 primitive，已归档）

## 解决的用户问题

CodePilot 是 Electron 应用，在 macOS 上**看起来像一个套在窗口里的网页**：大量实色 surface 盖住了系统材质，到处是网页式 hover，缺少"长期运行的 Mac 桌面应用"的质感。

用户的诉求很克制，值得原样保留：

> 总体上，细节以及每个页面的内容，我不想有特别大的差别。我就是想在背景材质以及一些独特的样式上，体现出一些平台特色，也就是用户能看得见的地方。至于页面里的细节，我希望还是维持一套同样的设计语言和设计风格。

翻译成产品边界：**只在"用户看得见的壳层"体现平台特色，页面内容、信息架构、按钮位置不分叉。**

## 为什么这样设计

### 借鉴 Raycast 的原则，而不是它的实现

灵感来自一篇 Raycast 2.0 技术解析。但 Raycast 的"Swift / C# 原生宿主 + WebView + Node + Rust"很重，CodePilot 已经是 Electron，**不会为了平台感重写宿主**。我们学的是它的产品原则：**共享 Web UI 负责产品速度，平台宿主负责窗口、材质、标题栏和 native feel**。

### 用 Apple 官方 HIG 校准，而不是凭"玻璃感"的印象

Phase 0 强制复核 Apple Liquid Glass（WWDC 2025 / macOS Tahoe 26）+ HIG Materials 一手资料，得到几条反直觉但关键的原则：

- **Material 是语义化的**（sidebar / header / popover / menu / hud / tooltip 各有对应），不是"统一一种玻璃"。
- **Vibrancy 是对比度保险，不是装饰**——保证材质之上的文字图标在不同背景下仍可读。
- **Liquid Glass 适合 controls / navigation，不建议放到 content layer**。我们"内容区保持不透明"的红线**直接来自这条 Apple guidance，不是我们自己的保守取舍**——这点很重要：它让"为什么聊天/代码/表单不上玻璃"有了官方依据，而不是团队口味。
- **Hierarchy through depth**：层级用 translucency / 厚度差表达。反例是"全屏均匀玻璃"——那样层级反而丢失。

### 三层模型把"能改的"和"不能改的"焊死

1. **Shared Product UI**（页面结构、数据流、文案、按钮顺序）——跨平台一致，永不分叉。
2. **Platform Visual Profile**（font / radius / hover policy / surface alpha / material token / titlebar safe area）——本计划只实现 macOS。
3. **Native Window Chrome**（Electron BrowserWindow / vibrancy / traffic light safe area / drag region）——只校准，不重写宿主。

允许 macOS 化的只有：窗口 chrome、顶栏、侧栏、Composer 外壳、浮层。**明确不动**：聊天消息体、代码块 / 终端、Settings 表单、Provider/Models/Runtime 卡片结构、Widget / Artifact / Markdown 内容——这些是"用户产物"或"三层心智模型"，必须忠实、跨平台一致。

### 一个被反复踩的工程事实，塑造了产品边界

**Electron vibrancy 是窗口级的**——一个 BrowserWindow 只能选一个 vibrancy 值。所以 DOM 浮层（Radix Popover / RunCockpit / Tooltip）**不能**各自用 Electron 的 `'popover'` / `'hud'` / `'tooltip'` vibrancy，只能用 CSS token 模拟 HIG material 的**视觉语义**。由此立了一条诚实纪律：**不得在文档 / 代码 / PR 里声称这些浮层用了 Electron per-surface vibrancy**。要真用，得把浮层做成独立 native window（Raycast 路线），那是未来选项、不在首轮。

平台标记还拆成 `data-platform`（OS）+ `data-shell`（host shell）两个维度，避免把普通 macOS 浏览器 / Playwright 误判成 Electron 而触发 body 透明 + traffic-light 安全区。平台 token 默认值等价于产品 token，**引入这一层本身不产生视觉 diff**。

## 7c：一个"三个症状其实是一个病"的故事

Phase 7b 推进到后期，四张浮动卡片反复出现三个观感问题：卡片底部圆角"脏"、拖动分割线没落在两卡 gap 几何中心、顶栏上方留白比卡片底部多。一次"一刀切修三个问题"的尝试（Round 34）反而把 4 个 panel 改成不一致结构，导致 Mac 适配整片失效，被迫回退。

Codex 复审给出根因：**这三个症状本质是同一个病——floating card 缺一个 layout primitive**。当时 sidebar / main / workspace / file-tree 各写了一套 wrapper / handle / surface，于是 ResizeHandle 落点错位、padding 一把梭。结论是抽出三个单职责组件：

- **CardFrame** 只投影、不裁剪；**CardSurface** 只裁剪和承载内容、不投影；**ResizeGutter** 是 row-level 兄弟、保证分割线永远在 gap 几何中心。

这件事的产品教训：**反复在各处局部修同一类观感问题时，要怀疑缺的是一个共享抽象，而不是再打一个补丁。** 几何中心这种"肉眼差不多"的东西，最后用 `getBoundingClientRect` 的 e2e 断言钉死（offset=0），不靠目测。

附带澄清了一个误判（tech-debt #29）：曾以为"删掉某个 layout wrapper 会让平台标记失效"，复核后确认真凶是组件树任意位置的 hydration mismatch 触发 `<html>` 重渲染抹掉 anti-FOUC script 设的属性，与那个 wrapper 无因果关系。**关联性 ≠ 因果性**，回退"除某物之外的一切"恰好也回退了真凶时，容易让无辜的改动背锅。

## 未来方向与已知局限

- **7b Phase 3-5 未做**：macOS hover / cursor / density 收口（减少网页 hover 感）、浮层视觉 POC（RunCockpit / model picker / command menu）、CDP/Electron smoke + 文档归档。这是下一段视觉工作。
- **截图证据有缺口**：目前 baseline + 7c 截图多为 **browser 模拟 darwin profile**（手动注入 `.dark` class），不是真实 Electron 窗口 vibrancy 截图。Phase 5 收口仍需补一次真实 Electron-window material smoke——`backdrop-filter` / vibrancy 的真实观感只有在 Electron 窗口里才算数。
- **Windows / Linux 不在本计划**：只保证新增 token 不破坏后续 Windows profile（Mica / Acrylic 留作扩展形态）。
- **不做的诱惑**：不重写 Electron 为原生宿主、不复制两套页面、不新增 macOS-only Settings 内容、不全仓删 hover/cursor（只治理壳层 + 导航层）。
