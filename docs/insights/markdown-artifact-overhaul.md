# Markdown / Artifact 体系重构 — 产品思考

> 执行计划归档于 docs/exec-plans/completed/markdown-artifact-overhaul.md

这份文档回答"为什么这样做，而不是其他方式"。技术细节看执行计划；本文只写思路。

---

## 用户痛点（项目起点）

四个独立诉求合并进一个项目：

1. **Artifact 支持更多网页预览** — 旧版只能预览 `.html`/`.htm`，希望扩展到 AI 生成 / 修改的 React（`.jsx`/`.tsx`）文件。
2. **文件树 Markdown 预览优化** — 后端硬 cap 1000 行，长 Markdown 被截断看不完整。
3. **新建和编辑 Markdown 文档** — 不用切到 Obsidian 即可新建 `.md` 并以源码模式编辑。
4. **Artifact 一键导出长图** — HTML / JSX 预览内容可导出为全页 PNG。

这四条对产品定位的启示：**CodePilot 的 Artifact 不是 Claude 那种"生成一次就扔"的一次性预览，而是和文件系统强绑定的持续编辑面板**。这个差异支配了后续所有设计。

---

## 核心设计决策

### 决策 1：卡片 + 点击拉起，不自动弹

**场景：** AI 修改 / 创建了 `.md`/`.html`/`.tsx` 文件时，怎么让用户看到？

**备选：**
- (a) **自动弹** — AI 写完立即打开 PreviewPanel，类似 Claude Artifact
- (b) **卡片 + 点击** — 聊天里渲染一张 Artifact 卡片，用户点击才打开

**选 (b)。理由：**
- 自动弹是"静默 + 不可逆 + 跨面板"的三重副作用叠加。用户可能正在看其他面板内容，突然弹出会打断注意力。
- Claude 的 Artifact 是单轮对话产物，弹了就弹；CodePilot 的场景是多轮迭代，AI 一个 session 可能改十几个文件，每次都自动弹等于洗屏。
- 卡片提供一个**决策点**：用户看到"AI 修改了 App.tsx"后，自己决定"要不要现在看"。卡片可关闭、可延后点、可忽略，都是可逆的。

**落地形态：** `DiffSummary` 原本是 MessageItem 里一行小字"Modified 3 files ›"，升级为每个可预览文件一张 Artifact 卡片（文件名 + Created/Modified chip + **Open preview** 按钮）。非可预览文件（`.ts`/`.yaml`）归入底部小字行 "Also modified: foo.ts"，不占卡片空间。

### 决策 2：升级 DiffSummary，不新建并存 UI

**场景：** 卡片应该是独立组件，还是和现有 DiffSummary 融合？

**备选：**
- (A) **升级 DiffSummary** — 现有组件多加一个按钮列
- (B) **新建 Artifact 卡片 + DiffSummary 保留** — 两个入口并存
- (C) **完全替换** — DiffSummary 删掉，全用 Artifact 卡片

**选 (A)。理由：**
- DiffSummary 已经是"本轮产出物汇总"的语义位，Artifact 卡片是同一语义的能力扩展，不是新语义。
- (B) 会让用户看到两份功能重合的列表，产生"这两个有什么区别"的认知负担。
- (C) 损失非可预览文件的 diff 摘要体验（`.ts`/`.yaml` 需要保留的是数量提示，不是预览入口）。

### 决策 3：Markdown 预览放开上限 + 加截断提示

**场景：** 用户反馈 10 万字符 Markdown 打不开。

**备选：**
- (a) **无限放开** — 彻底取消上限
- (b) **分档放开 + 截断提示** — `.md/.mdx/.txt` 上限 50000 行 + 10MB 字节；超过明确提示
- (c) **流式加载** — 分页滚动读，不一次性发送

**选 (b)。理由：**
- (a) 服务端内存没上限就是 DoS 向量：一个 1GB 的 log 文件能拖垮 Next.js 进程。
- (c) 流式改动架构面太大（React + Streamdown + 滚动虚拟化都要动），收益不对等。
- (b) 的 50000 行覆盖 99% 真实场景（包括用户反馈的 10 万字符样例），同时 10MB 字节硬上限作为第二道 DoS 防线。截断提示让用户知道"我在看一个子集"，不会误判。

**延伸：** 二进制文件前 4KB 检测 + Null 字节/非 UTF-8 拒绝，属于同一设计哲学：**用户看到的要么是完整/可靠的内容，要么是明确的错误**，不要悄悄显示垃圾。

### 决策 4：PreviewPanel 编辑是核心能力，不是附带功能

**场景：** Markdown 文件在 PreviewPanel 里可以只看不改，还是要能编辑？

**初版决定：** 只看。
**修正决定：** 能编 + 自动保存。

**修正原因：** 测试阶段发现只看 = 半残。用户在预览里发现笔误，本能反应是"在这里直接改"，切到 Obsidian 再回来的流程反人类。所以加 `Edit` 视图模式 + CodeMirror 6 + 1 秒 debounce 自动保存。

**进一步合并：** 原先 ViewModeToggle 是 `Source | Preview`，对 Markdown 来说 `Edit` 和 `Source` 在视觉上高度重合（都是源码），所以合并为 `Edit | Preview` 两个按钮。代码文件保持 `Source | Preview`（没有 Edit 能力）。

### 决策 5：TSX 预览第一版叫"单文件 React 预览"

**这个命名是产品边界的锚点，后续扩展都基于此。**

**能做（MVP）：**
- 单文件 `.jsx` / `.tsx`，自包含的 React 组件
- React hooks
- 白名单 npm 依赖（`react`/`react-dom`/`lucide-react`）
- Tailwind utility classes（通过 CDN 注入）

**不能做（后续版本）：**
- 多文件项目（`import './Counter'`）
- CSS import（`import './style.css'`）
- 项目别名（`import { Button } from '@/components/ui/button'`）
- 图片/字体 import
- 自定义 `tsconfig.json`

**为什么这条边界？** Sandpack 理论上支持多文件/别名/CSS，但每一条"能支持"都要做映射层的虚拟文件系统 + alias resolver + style injection，工作量一下膨胀成一个小构建系统。第一版如果不划这条线，产品范围会变成"我们做了一个 Vite in browser"，用户期望失控。

**演进路径：** 虚拟文件系统 → alias resolver → CSS import → 真实 npm install。每一步都是独立产品决策，基于用户实际需要的场景（而不是"先支持上"的工程冲动）。

**UX 配合：** 当 Sandpack 报错（比如找不到 `@/components/ui/button`），ErrorBoundary fallback 显示的不是 bundler 原生栈，而是一句**"预览仅支持单文件 React（不含别名 / CSS import / 多文件）"**。这样用户知道这是能力边界，不是 bug。

### 决策 6：长图导出复用隐藏 BrowserWindow，不走外部 SaaS

**场景：** 如何生成长图？

**备选：**
- (a) Puppeteer / headless Chromium —— 独立二进制
- (b) 第三方 SaaS（screenshotapi.net 等）—— 网络依赖 + 数据跑出本机
- (c) Electron `widget:export-png` 的隐藏 BrowserWindow —— 复用现成基建

**选 (c)。理由：**
- 我们已经有 `widget:export-png`（Dashboard widget 导出用）。同一套 hidden BrowserWindow + 独立 session partition + data URL 加载的配方，把 4000px 上限去掉就能做长图。
- (a) 增加二进制依赖 + 打包复杂度。
- (b) 数据跑出本机是隐私敏感问题（用户可能在导出内含敏感信息的 HTML），违背 CodePilot 的"本地优先"定位。
- 隐藏窗口 + `webContents.debugger` + CDP `Page.captureScreenshot({ captureBeyondViewport: true })` 一次 API 拿全页，无需拼接。

**TSX 导出的缺席：** 第一版只对 `.html`/`.htm` 开放导出按钮。因为把 Sandpack 渲染结果转成能送进 BrowserWindow 的 HTML 需要"Sandpack files → esbuild → 独立 HTML"这条链路，属于产品决策 5 的"虚拟文件系统"范畴，留作后续。

---

## 失败 / 回头路

这些是迭代中走过的弯路，留下作为经验。

### 弯路 1：追 Sandpack 缓存三轮都没对症

**现象：** 点 A.tsx 显示 A，切 B.tsx 还显示 A。

**误判：** 以为是 Sandpack bundler 缓存没 invalidate。连加 3 层：`providerKey` 加 `mountToken` 随机 → 加 content hash → 改 mount path 为 `/App.${token}.tsx`。前两层没用；第三层直接让 Sandpack 预览空白。

**真因：** Sandpack 的 `react-ts` template 硬编码 `/index.tsx` 入口 → `import App from './App'`。我把用户代码挂在 `/Counter.tsx` 并设 `activeFile=/Counter.tsx`，但 `activeFile` 只影响编辑器光标，**运行入口仍然是 `/App.tsx`**（template 的默认）。所以切不切文件都渲染 template 的默认 App。

**教训：** "缓存问题" 是工程师最爱的归因，但很多"缓存问题"的 bug 根因是数据流本身错了。下次先画一下"数据在哪里、从哪进、到哪出"，再假设缓存。

### 弯路 2：先做 SkillEditor 不做 PreviewPanel 编辑

**现象：** 用户要的是"文件树里的 Markdown 可编辑"，我做成了 "Skills 页面的 Markdown 可编辑"。

**真因：** 我把 MarkdownEditor 接到了 SkillEditor（Skills 也是 .md 文件，"顺手升级"），但用户核心诉求是 PreviewPanel 里的 .md 编辑。SkillEditor 改动算副产物，不算核心交付。

**教训：** 用户明确说"文件树里"就是"文件树里"，不要脑补"顺手把相邻场景也升了"——会错过真正的需求。

---

## 架构约束的副产品

### 约束 1：Electron 模式和 dev server 模式并存

- Phase 3 长图导出是 Electron IPC，dev server 模式不可用（`artifact.exportLongShot` 在 web 环境是 undefined）。
- Web 环境下按钮点击 alert "unavailable"。
- 这不是 bug，是 feature：CodePilot 本身是 Electron app，dev server 是开发便利。

### 约束 2：Worktree 下 dev server 需要独立 node_modules

- Turbopack 不允许跨文件系统根的 symlink，所以初次做 worktree 时用 `ln -s` 软链主目录 node_modules 会失败。
- 必须在 worktree 里独立 `npm install`。
- 对个人开发者就是多跑一次 install，可接受。

---

## 数字与验证

Phase 1-5 交付的量化指标：

| 维度 | 改动前 | 改动后 |
|------|--------|--------|
| Markdown 预览上限（Markdown/文本类） | 1000 行 | 50000 行 + 10MB 字节 |
| 可预览扩展 | `.md/.mdx/.html/.htm` | 加 `.jsx/.tsx`（Sandpack） |
| PreviewPanel 视图模式（可编辑扩展） | `Source / Preview` | `Edit / Preview`（Source 被 Edit 替代） |
| 自动保存 | 无 | 1 秒 debounce |
| 文件 I/O 安全 | 无统一合同 | `validateFsAccess` helper 统一所有路由 |
| 新建文件 UX | 无 | 文件树顶部 New File / New Folder（VS Code 风格） |
| Shiki LRU | 聊天 + 预览各自一套（无界 Map） | 共享 `code-block.tsx` 的 LRU（10+200 上限） |

---

## 未来演进

不在当前项目范围内但与此项目相关的想法：

1. **切文件时保存未提交的编辑** — 当前是丢弃，对快速切换场景不够友好。
2. **Artifact 历史 / 多版本切换** — AI 多次修改同一文件时，提供 diff 浏览 + rollback。
3. **多文件 TSX 预览** — 基于决策 5 的演进路径。
4. **导出长图支持 Markdown / TSX** — 需要 Sandpack/Streamdown → HTML 的离线序列化。
5. **文件树右键菜单 rename / delete** — 当前只有 API，UI 还没做（需要 ContextMenu 原语）。

这些都是独立产品决策，各自再走一遍"用户痛点 + 备选 + 选择 + 理由"的流程。
