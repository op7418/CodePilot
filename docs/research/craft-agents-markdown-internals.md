# Craft Agents 内部 Markdown 实现调研

> 调研日期：2026-04-16
> 对标仓库：`/Users/op7418/Documents/code/资料/craft-agents-oss-main`（craft-agents-oss）
> 姊妹文档：
> - [markdown-editor-tiptap-evaluation.md](./markdown-editor-tiptap-evaluation.md) — CodePilot 自己的 Markdown 栈与 Tiptap 可行性
> - [artifact-preview-ai-elements.md](./artifact-preview-ai-elements.md) — Artifact 预览（本文发现的"代码块 language 拦截"是另一条轻量路径）
> - craft-agents-docs-system-review.md — craft 对外治理文档对标
>
> 三层结构：**[craft 事实]** 带 `file:line`；**[CodePilot 事实]** 带本仓库路径；**[推断]** 标注。

---

## 1. 调研动机

craft 是"文档驱动的 Agent"——Skills / Agent 配置 / Source Guides / Session 输出全部以 Markdown 文件承载；聊天窗口本身也是 Markdown 渲染器。和 CodePilot 现状高度可对照。前一份 Markdown 调研（`markdown-editor-tiptap-evaluation.md`）中留下的三个关键问题，正好能用 craft 的实战选型来交叉验证：

1. Tiptap 在"文档驱动 Agent"里到底用在哪里？渲染侧、编辑侧、还是两侧？
2. 流式长文档卡顿有无工程化的 memo 策略参考？
3. 复杂内容类型（Mermaid / LaTeX / Diff / 数据表 / PDF 预览 / HTML 预览）的扩展机制，是走自定义 Markdown 语法，还是走代码块 language 路由？

本文用 craft 的源码回答这三题。

---

## 2. Craft 的 Markdown 栈全景（craft 事实）

### 2.1 依赖清单（实测自 `packages/ui/package.json`）

| 库 | 版本要求 | 用途 |
|----|---------|------|
| `react-markdown` | `>=9.0.0` | **消息与文档的主渲染引擎** |
| `remark-gfm` | `>=4.0.0` | 表格、任务列表、删除线 |
| `remark-math` | `>=6.0.0` | 数学块解析 |
| `rehype-katex` | `>=7.0.0` | KaTeX 数学渲染 |
| `rehype-raw` | `>=7.0.0` | 允许原始 HTML（配合 safe proxy） |
| `shiki` | `^3.21.0` | 代码语法高亮（VS Code 引擎） |
| `unified` | `^11.0.0` | AST 处理框架（自建插件依赖） |
| `beautiful-mermaid` | `*` | Mermaid 图表 |
| `@tiptap/starter-kit` | `^3.20.0` | **编辑器**基础（仅编辑，不渲染聊天） |
| `@tiptap/markdown` | `^3.20.0` | Tiptap 官方 Markdown |
| `tiptap-markdown` | `^0.9.0` | 遗留编辑器引擎（并存） |
| `gray-matter` | `^4.0.3` | YAML frontmatter 解析 |
| `unist-util-visit` | `^5.0.0` | AST 遍历 |
| `marked` | `^17.0.1` | 辅助解析 |
| `markitdown-js` | `^0.0.14` | 外部文档转 Markdown（读取侧） |
| `react-pdf` | `^10.3.0` | PDF 块预览 |
| `@pierre/diffs` | `^1.0.4` | Diff 块预览 |
| `@uiw/react-json-view` | `^2.0.0-alpha.40` | JSON 块预览 |

[推断] craft 明确把"渲染侧"压在 react-markdown + unified 生态，"编辑侧"压在 Tiptap 生态，**两者不交叉**。

### 2.2 `packages/ui/src/components/markdown/` 子系统（32 个文件，~5500 行）

```
Markdown.tsx                       598 行 — 总入口 + 三种 mode（minimal/full/terminal）+ 语言拦截路由
CodeBlock.tsx                      234 行 — Shiki 高亮 + LRU 缓存
safe-components.tsx                111 行 — 恶意/无效 HTML 标签 Proxy 防御
remarkCollapsibleSections.ts       129 行 — 自建 remark 插件：按 heading 包成 <section>
CollapsibleMarkdownContext.tsx      61 行 — 折叠状态 Context
CollapsibleSection.tsx             103 行
linkify.ts                         284 行 — URL 后处理
annotation-resolver.ts             172 行 — 注解解析
link-target.ts                      59 行
math-options.ts                      9 行 — 仅启用双美元 $$ 避免货币冲突

块级 Artifact 组件（10 个 MarkdownXxxBlock）：
  MarkdownDatatableBlock.tsx       718 行 — 大数据表
  MarkdownSpreadsheetBlock.tsx     317 行 — 电子表格
  MarkdownImageBlock.tsx           281 行 — 图片卡
  MarkdownHtmlBlock.tsx            263 行 — HTML 沙箱 iframe
  MarkdownMermaidBlock.tsx         260 行 — Mermaid SVG
  MarkdownPdfBlock.tsx             250 行 — PDF 预览
  ImageCardStack.tsx               219 行
  MarkdownJsonBlock.tsx            205 行 — JSON 可展开树
  MarkdownDiffBlock.tsx            163 行 — Diff 卡
  MarkdownLatexBlock.tsx            43 行 — LaTeX 单独块
  RichBlockShell.tsx                40 行 — 富块统一外壳

编辑器（Tiptap 生态，独立于上面）：
  TiptapMarkdownEditor.tsx         — 总入口（估算 ~400 行）
  TiptapSlashMenu.ts               545 行 — / 命令菜单
  TiptapBubbleMenus.tsx            531 行 — 选中浮窗
  TiptapCodeBlockView.tsx          323 行 — 编辑器内代码块视图
  TiptapHoverActions.tsx            52 行
  tiptap-editor.css

表格导出：
  table-export.ts                  261 行 — CSV/JSON 导出
  TableExportDropdown.tsx           75 行
```

### 2.3 渲染入口链路

- 消息气泡 `packages/ui/src/components/chat/TurnCard.tsx:25` → `<Markdown>` 组件
- 总入口 `packages/ui/src/components/markdown/Markdown.tsx:1-598`
- 流式缓存包装 `Markdown.tsx:576-593`：`MemoizedMarkdown` 自定义 memo，比较 `id` + `children` 双键
- 代码块 language 路由 `Markdown.tsx:226-283`：`mermaid / latex / math / json / diff / datatable / spreadsheet / html-preview / pdf-preview / image-preview` 拦截，落到对应 `MarkdownXxxBlock`
- 未命中语言 → 普通 `<CodeBlock>`（Shiki）

---

## 3. 关键实现细节

### 3.1 流式 memo 策略：`id + children` 双键

- `Markdown.tsx:576-593` 的 `MemoizedMarkdown` 要求外部传 `id` prop（消息 ID 或段落 ID），memo 比较同时看 `id` 与 `children`。
- [推断] 对流式场景的意义：同一条消息每次 chunk 来时 `id` 不变、`children` 变，触发重渲；**不同消息共享同一渲染器但 `id` 不同**，避免相邻消息误命中缓存。
- 对比：CodePilot 现状 `src/components/ai-elements/message.tsx:349` 的 memo 只比 `children` 引用，没有 id 维度。长消息 + 多消息列表时缓存粒度偏粗。

### 3.2 Shiki LRU 缓存（200 项）

- `packages/ui/src/components/markdown/CodeBlock.tsx:46-119` 维护一个 LRU `highlightCache`，容量 200，key 由语言 + 代码内容哈希组成。
- 预加载 21 种常见语言 `CodeBlock.tsx:23-28`；语言别名映射 `CodeBlock.tsx:31-43`（`js → javascript` 等）；未命中降级为 `text`。
- `ShikiThemeContext`（`packages/ui/src/context/ShikiThemeContext.tsx:1-68`）解决"深色专属主题在浅色系统模式下 fallback 错乱"问题——不靠 DOM class 嗅探，而是 Context 显式传主题名。

### 3.3 代码块 language 拦截 = 轻量 Artifact（非常重要）

`Markdown.tsx:226-283` 里，代码块 renderer 检查 ` ```{language}`：

| language | 渲染为 | 对应组件 |
|----------|--------|---------|
| `mermaid` | SVG 图表 | `MarkdownMermaidBlock` |
| `latex` / `math` | KaTeX 公式 | `MarkdownLatexBlock` |
| `json` | 可展开树 | `MarkdownJsonBlock` |
| `diff` | Diff 卡 | `MarkdownDiffBlock`（基于 `@pierre/diffs`） |
| `datatable` | 大数据表（列排序/筛选） | `MarkdownDatatableBlock` |
| `spreadsheet` | 电子表格 | `MarkdownSpreadsheetBlock` |
| `html-preview` | 沙箱 iframe | `MarkdownHtmlBlock` |
| `pdf-preview` | PDF 预览 | `MarkdownPdfBlock` |
| `image-preview` | 图片卡 | `MarkdownImageBlock` |
| 其他 | Shiki 高亮 | `CodeBlock` |

[推断] 这是**用"魔法 language 标签"代替自定义 Markdown directive** 的实现策略：LLM 只需输出 ` ```html-preview\n<html>...</html>\n``` `，前端就能自动 Artifact 化。**比自建 remark directive 简单一个数量级**，且对纯文本模式降级为普通代码块，兼容性极好。

### 3.4 Mermaid 同步 + CSS 变量主题继承

- `MarkdownMermaidBlock.tsx:63-76`：`beautiful-mermaid` 同步返回 SVG（不用 web worker），通过在 Mermaid 配置里传 `var(--background)` 等 CSS 变量引用，SVG 天然跟随 app 主题切换，不需要重渲 SVG。

### 3.5 Safe Proxy 防 LLM 输出乱 HTML

- `safe-components.tsx:76-111` 的 `wrapWithSafeProxy` 用 JS Proxy 拦截所有未定义组件名；对含非法字符（`<sq+qr>`、`<user@foo>`）的标签，直接退化为 `UnknownTag` 文本组件。
- [推断] 由于启用了 `rehype-raw`（允许原始 HTML），需要这层防御否则 LLM 一旦输出怪标签会炸。CodePilot 的 `streamdown` 对类似问题默认保守转义，严格性不同但都需要考虑。

### 3.6 自建 Collapsible remark 插件

- `remarkCollapsibleSections.ts:1-130` 遍历 AST，按 heading 深度把后续节点包进 `<section data-section-id="...">`。
- 前端 `CollapsibleMarkdownContext.tsx` + `CollapsibleSection.tsx` 消费 `data-section-id`，实现"按标题折叠"。
- [推断] 很实用的长文档阅读体验，相当于 Obsidian / Notion 的折叠。CodePilot 的 Streamdown 默认无此能力，可作为独立扩展点。

### 3.7 Tiptap 仅用于编辑器侧

- 编辑器入口：`TiptapMarkdownEditor.tsx`（235 行左右的主体 + 五个配件）。
- **双引擎并存**：`tiptap-markdown`（遗留，0.9.0） vs `@tiptap/markdown`（官方，3.20.0），通过 `markdownEngine` flag 切换。
- 配套组件：`TiptapSlashMenu`（斜杠命令）、`TiptapBubbleMenus`（选中浮动工具栏）、`TiptapCodeBlockView`（编辑器内代码块）、`TiptapHoverActions`（悬停操作）。
- **编辑器不参与聊天消息渲染**——聊天渲染走 react-markdown。

### 3.8 Skills / Agent / Source 全部 `.md` 文件

- 存储格式：`{workspace}/skills/{slug}/SKILL.md`（`packages/shared/src/skills/storage.ts:17-142`）。
- 解析：`gray-matter` 提取 YAML frontmatter，body 为 Markdown。
- 必填字段：`name`、`description`；可选：`globs`、`alwaysAllow`、`icon`、`requiredSources`（`storage.ts:68-95`）。
- Source Guides：`{workspace}/sources/{slug}/guide.md`。
- [推断] 和 CodePilot 的 Skills 设计几乎一致，互相印证此模式是事实上的行业惯例。

### 3.9 未发现的能力（避免误学）

- **无虚拟滚动**：SessionViewer 全量渲染所有 turns，对长会话（>1000 条）大概率有性能问题。
- **无 wikilinks / @mention 扩展**：Obsidian 风格双链不支持。
- **无 Callout `> [!note]`**：Obsidian 语法不支持。
- **无导出为 PDF / DOCX**：只做读取（`markitdown-js`）和内联预览，不做反向导出。
- **Tiptap 编辑器无 split-view 源码模式**：WYSIWYG only，不适合习惯源码的用户。

---

## 4. 与 CodePilot 现状对照

| 维度 | craft | CodePilot |
|------|-------|-----------|
| 聊天渲染库 | `react-markdown` + `unified` 生态 | `streamdown`（专为流式设计） |
| 代码高亮 | Shiki 3.21 + 200 项 LRU + 21 预加载 | **Shiki LRU 已存在**：`code-block.tsx:163-170` 的 `highlighterCache`（10 项）+ `tokensCache`（200 项）；[待核验] `MessageResponse` 这条 Streamdown 渲染链是否复用了该 LRU 未确认 |
| 数学 | `remark-math` + `rehype-katex`，只启 `$$` | `@streamdown/math` |
| Mermaid | `beautiful-mermaid` 同步 SVG | `@streamdown/mermaid` |
| Diff / JSON / Datatable / Spreadsheet / PDF / HTML / Image 专用块 | **10 个 `MarkdownXxxBlock` + 代码块 language 路由** | **无**（仅 HTML/Markdown/媒体走独立 `PreviewPanel`） |
| memo 粒度 | `id + children` 双键 | 仅 `children` 引用 |
| 原始 HTML 支持 + 安全层 | `rehype-raw` + `safe-components` Proxy | streamdown 默认转义，更保守 |
| Collapsible sections | 自建 remark 插件 | 无 |
| 编辑器 | Tiptap v3（+ 斜杠菜单 + 浮动工具栏） | 原生 `<textarea>`（Skills）+ 无通用编辑器 |
| Skills 存储 | `skills/{slug}/SKILL.md` + frontmatter | 同构（互相印证） |
| Frontmatter 解析 | `gray-matter` | `skill-parser.ts:43-59` 已有 |
| 长文档虚拟化 | **无** | **无** |
| 导出 | 仅读取（markitdown-js），无反向导出 | [推断] 未系统化 |

---

## 5. 修订前文结论

### 5.1 对 `markdown-editor-tiptap-evaluation.md` 的修订

前文结论"Tiptap 不推荐作主栈；编辑器推荐 CodeMirror 6"。**craft 的工程实践部分修正这个结论**：

- craft 选 Tiptap 做**编辑器**（斜杠菜单、浮动工具栏、富文本所见即所得），选 react-markdown 做**渲染**——与前文判断"Tiptap 不适合作渲染主栈"一致。
- 但 craft 用 Tiptap 做编辑器而非 CodeMirror，说明在"文档驱动 Agent"场景下，**WYSIWYG 的 Markdown 编辑确实是一种可行选型**，不只有 CodeMirror 源码模式一条路。
- [推断] 选型决策因子是**目标用户**：craft 面向偏产品向用户（类 Notion 体验），CodePilot 面向创作者 + 开发者（需要源码模式），两者不同。前文推荐 CodeMirror 6 对 CodePilot 仍然成立，但应补一句"若未来做面向非技术用户的笔记场景，Tiptap 是备选"。
- craft 的 Tiptap 迁移留下**双引擎并存**（`tiptap-markdown` + `@tiptap/markdown`），说明升级成本不可忽视——对我方是警示。

### 5.2 对 `artifact-preview-ai-elements.md` 的修订

前文推荐路径是 "AI Elements 只抄 UI 原语 + 运行时自建（iframe srcDoc / JSXPreview / Sandpack）"。**craft 提出了一条更轻量的第三条路**：

- **代码块 language 拦截**：LLM 输出 ` ```html-preview`、` ```image-preview`、` ```pdf-preview`、` ```datatable`、` ```diff` 等魔法 language，前端直接路由到对应富组件。无需侧边 Artifact 面板、无需 iframe 弹窗，全部内联。
- 证据：`Markdown.tsx:226-283` + 10 个 `MarkdownXxxBlock` 组件。
- 优势：
  1. LLM 只需学会在 language tag 里写关键词，提示词零额外成本；
  2. 不支持的语言自动降级为普通代码块，兼容性强；
  3. 不需要改后端流式协议（仍是标准 Markdown）。
- 局限：
  1. 仅适合"内联富块"场景，不能替代侧边"全屏 Artifact 面板"（craft 也补了 `overlay/ImagePreviewOverlay` 等全屏组件作为 Fullscreen 模式）；
  2. 魔法 language 需产品约定清单，LLM 训练/提示词得同步；
  3. 对大尺寸预览（React 工程、Sandpack）仍需独立面板。

**结论**：推荐 CodePilot 采用**双轨制**——
- **轨 A（内联富块，借鉴 craft）**：代码块 language 拦截，覆盖 Mermaid / Math / Diff / JSON / PDF / Image / DataTable 等内联场景，收益高成本低。
- **轨 B（侧边 Artifact，前文方案）**：AI Elements `<Artifact>` + `WebPreview` + `JSXPreview`，覆盖 React 预览、URL 劫持、大尺寸 HTML。

### 5.3 对流式长文档卡顿根因的修订

前文 `markdown-editor-tiptap-evaluation.md` 第 2.4 节对根因候选做了三种推断。craft 的 `MemoizedMarkdown` 给出**第四种视角**，但**只是缓存边界修正，不是长文档重 parse 的核心解法**：

- craft 的 memo 要求调用方传 `id`，形成"消息 ID 维度"的缓存边界。CodePilot 当前 `src/components/ai-elements/message.tsx:338-350` 的 memo 只比 `children` 引用。
- **关键纠正**（基于 Codex review）：同一条消息流式追加时，`children` 字符串每次都变，`messageId` 相同——加 `id` 维度**不能阻止整串重 parse**。它的真实价值是：**列表里多条消息共享 `<MessageResponse>` 实例时，确保相邻消息不会误命中缓存**；同时便于上层拆分"稳定前缀 + 流式尾部"两段时给每段独立 key。
- **长文档重 parse 的真正核心解法**（按收益从高到低）：
  1. **稳定前缀 + 流式尾部分段渲染**：把已完成的上文段落独立 memo，只让尾部那几段随流追加重渲。`messageId` + 段落索引做复合 key。
  2. **超长 code fence 保护**：单个 code block 超阈值（如 5k 字符）降级为无高亮 `<pre>`，跳过 Shiki 异步 highlight。
  3. **整条消息虚拟化**：对超阈值消息（如 > 30k 字符）切换到"文档阅读模式"或 viewport 虚拟列表。
  4. **会话级虚拟化**：`react-virtuoso` / `@tanstack/react-virtual` 包一层消息列表。
- **`messageId` memo 改造本身**工作量约 1 人时，属于 P1 健壮性改进，不要被描述为性能核心解法。

---

## 6. 可直接抄的清单（按实施成本排序）

每条都带 craft 的 `file:line` 证据以便下游查证。

1. **`MessageResponse` 引入 `messageId` 维度的 memo**（1 人时，定位为"缓存边界修正"而非性能核心解法）
   - 证据：`Markdown.tsx:576-593` 的 `MemoizedMarkdown` 双键比较。
   - **注意**：单独做这一条**不能解决长文档流式重 parse**，需配合"稳定前缀 + 流式尾部分段"（本文 5.3 节）。
2. **核对 Streamdown 渲染链是否复用 `code-block.tsx:163-170` 的 LRU 缓存**（先验证再决定动作）
   - CodePilot 已有 `highlighterCache` + `tokensCache`，但不确定消息流里的代码块是否走同一条高亮通路。若未复用，则对齐；若已复用，本条无需改动。
3. **`ShikiThemeContext` 显式主题传递**（1-2 人时，解决暗色主题 fallback）
   - 证据：`packages/ui/src/context/ShikiThemeContext.tsx:1-68`。
4. **代码块 language 拦截框架**（1-2 天，基础）
   - 证据：`Markdown.tsx:226-283`，从最简单的 `mermaid` / `json` / `diff` 开始。
5. **`MarkdownDiffBlock` 接入**（0.5 天）
   - 证据：`MarkdownDiffBlock.tsx:1-60` + `@pierre/diffs`；CodePilot git diff 展示可直接复用。
6. **`MarkdownJsonBlock` 接入**（0.5 天）
   - 证据：`MarkdownJsonBlock.tsx` + `@uiw/react-json-view`；LLM 返回 JSON 的展示体验显著改善。
7. **Collapsible remark 插件**（1 人天）
   - 证据：`remarkCollapsibleSections.ts:1-130` + `CollapsibleSection.tsx:1-103`。
8. **Safe HTML Proxy 防御**（0.5 天）
   - 证据：`safe-components.tsx:76-111`；只要项目支持原始 HTML 就应有一层此防御。
9. **Skills frontmatter 字段规范对齐**（核对即可）
   - 证据：`packages/shared/src/skills/storage.ts:68-95`；CodePilot 已有 frontmatter 解析，比对字段集查漏。
10. **Datatable / Spreadsheet 富块**（各 1-2 天，可选）
    - 证据：`MarkdownDatatableBlock.tsx:1-718` / `MarkdownSpreadsheetBlock.tsx:1-317`。
11. **表格导出 CSV/JSON**（0.5 天）
    - 证据：`table-export.ts:1-261` + `TableExportDropdown.tsx:1-75`。
12. **Tiptap 仅作编辑器备选方案记录**（不做改动，仅备忘）
    - 证据：`TiptapMarkdownEditor.tsx` + 5 个配件；如未来做非技术用户笔记场景再启用。

---

## 7. 未决事项

1. 代码块 language 拦截的完整语言清单需要与 CodePilot 产品侧对齐（哪些必要，哪些暂缓）。
2. LLM 提示词需要同步学会输出魔法 language；需落一份 system prompt 说明。
3. craft 的 `markitdown-js` 做"外部文档 → Markdown"转换，CodePilot 是否需要对应能力（PDF 拖进来自动转 Markdown）需产品判断。
4. 长会话虚拟化 craft 也没做，此问题仍需 CodePilot 独立解决，参考前份 `markdown-editor-tiptap-evaluation.md` 第 5.2 节。
5. Tiptap 双引擎迁移（`tiptap-markdown` vs `@tiptap/markdown`）的成本教训需在任何未来 Tiptap 选型 POC 里留心。

---

## 8. 参考路径索引（craft 仓库，全部带 `file:line`）

- `packages/ui/package.json`（Markdown 相关 peer deps）
- `packages/ui/src/components/markdown/Markdown.tsx:1-598`（总入口、三种 mode、language 路由、`MemoizedMarkdown`）
- `packages/ui/src/components/markdown/CodeBlock.tsx:1-234`（Shiki + LRU + 别名）
- `packages/ui/src/components/markdown/safe-components.tsx:1-111`（Proxy 防御）
- `packages/ui/src/components/markdown/remarkCollapsibleSections.ts:1-129`
- `packages/ui/src/components/markdown/MarkdownMermaidBlock.tsx:1-260`
- `packages/ui/src/components/markdown/MarkdownDiffBlock.tsx:1-163`
- `packages/ui/src/components/markdown/MarkdownJsonBlock.tsx:1-205`
- `packages/ui/src/components/markdown/MarkdownHtmlBlock.tsx:1-263`
- `packages/ui/src/components/markdown/MarkdownPdfBlock.tsx:1-250`
- `packages/ui/src/components/markdown/MarkdownImageBlock.tsx:1-281`
- `packages/ui/src/components/markdown/MarkdownDatatableBlock.tsx:1-718`
- `packages/ui/src/components/markdown/MarkdownSpreadsheetBlock.tsx:1-317`
- `packages/ui/src/components/markdown/MarkdownLatexBlock.tsx:1-43`
- `packages/ui/src/components/markdown/math-options.ts:1-9`
- `packages/ui/src/components/markdown/table-export.ts:1-261`
- `packages/ui/src/components/markdown/TiptapMarkdownEditor.tsx`
- `packages/ui/src/components/markdown/TiptapSlashMenu.ts:1-545`
- `packages/ui/src/components/markdown/TiptapBubbleMenus.tsx:1-531`
- `packages/ui/src/components/markdown/TiptapCodeBlockView.tsx:1-323`
- `packages/ui/src/context/ShikiThemeContext.tsx:1-68`
- `packages/ui/src/components/chat/TurnCard.tsx:25`
- `packages/shared/src/skills/storage.ts:17-142`
