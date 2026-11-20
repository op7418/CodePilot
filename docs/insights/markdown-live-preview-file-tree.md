# Markdown Live Preview × Explorer 文件树：产品取舍

## 为什么取消“主题选择”

预览区的五套 presentation 样式制造了一个假命题：用户看见的 Markdown 到底是聊天里的版本、预览里的某个主题，还是导出模板。它增加选择，却没有增加编辑价值。

这次把聊天与文件预览下沉到同一个中立 Markdown contract。聊天仍可叠加复制代码等交互，导出仍可拥有独立模板，但用户日常阅读只有一套 CodePilot 语言。明暗模式仍属于应用主题，不属于 Markdown 内容主题。

## 为什么选择 CodeMirror Live Preview

用户真正需要的不是“左边编辑、右边看结果”，而是阅读与修改之间少一次视线和模式切换。活动行显示源码、其他内容呈现排版，能同时保住两个关键价值：

- 原文始终可见、可保存、可 diff，工具和 AI 不会面对一份有损富文本副本。
- 长文阅读时不必一直承受标记噪声，表格、公式、图和代码仍然可读。

Milkdown/Tiptap 一类 ProseMirror 方案更适合富文本成为主数据的产品；这里 Markdown 文件本身就是用户资产，往返无损和 CodeMirror 的长文虚拟化更重要。因此采用 CM6 官方 syntax tree / decoration API 自研一层薄视图，而不是引入完整富文本模型。

最低渲染 parity 是出货门禁，不是“以后再说”：图片、表格、代码、Mermaid、数学任一类只能看源码时，就不能诚实地说旧 Preview 已被替代。

## 为什么文件操作需要事务，而不只是右键菜单

右键菜单只是入口，难点是同一个路径同时存在于编辑器、自动保存 timer、tab、preview source 和展开状态里。先改磁盘、再让各组件“听事件自己更新”会产生最危险的一类 bug：文件已经改名或删除，旧路径上的延迟 autosave 又把它写回来。

所以 rename/delete 被视为一个跨 owner transaction：先暂停并等待保存，磁盘操作成功后等待所有 owner acknowledgement，再释放 guard；失败则恢复旧状态。这个工程成本不是为了架构好看，而是为了让“移动到废纸篓可恢复”这句承诺真的可信。

## 为什么文件夹不要图标，文件要类型图标

文件名被截断后，后缀往往最先消失。同名的 `index.md`、`index.ts`、`index.html` 只靠文本无法快速区分。文件夹已有展开箭头这个强结构信号，再叠一个文件夹图标只是重复占宽。

因此两类节点使用互斥的前导槽位：

- 有箭头就是文件夹，不再放 folder glyph。
- 没箭头就是文件，前导槽位显示类型图标。

这比给所有节点都塞图标更安静，也让窄侧栏里的每一个像素有明确职责。完整相对路径放在 tooltip，解决截断后的识别问题。

## 为什么用 material-icon-theme 的静态子集

HugeIcons 的 semantic layer适合“设置、运行时、插件”这类产品概念，但没有足够细的 Markdown、YAML、Docker、Go、Rust 等文件类型 artwork。运行时加载完整主题或联网 Iconify 又会增加包体、故障面和许可边界。

`material-icon-theme` 提供成熟映射与 MIT 源资产；本项目只在构建期提取 50 个固定 SVG，并提交 manifest、MIT LICENSE 和品牌标识免责声明。它是文件格式识别的受控例外，不改变 CodePilot 自有语义图标体系。

## 已知边界

- 外部 Finder/终端改名删除还没有 watcher；树需要主动刷新。
- 文件树未做多选、拖放和大型目录虚拟化。
- 真正的中文 IME 候选框仍需要人工按发布矩阵复验，自动化只能覆盖 composition state。
- Windows Trash 必须由 Windows 打包 smoke 证明；macOS 结果不能外推。
