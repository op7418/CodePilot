# 项目看板（Dashboard）系统

> 产品思考见 [docs/insights/dashboard-generative-ui.md](../insights/dashboard-generative-ui.md)
> Widget 渲染基础设施见 [docs/handover/generative-ui.md](./generative-ui.md)

## 核心架构

看板是生成式 UI 的持久化层。聊天中的 widget 是一次性的，看板把它们变成项目级的持续监控工具。

```
用户对话
  → AI 生成 widget（show-widget 代码围栏）
  → 用户点 Pin / AI 调 MCP 工具
  → widget 代码 + 数据契约 + 数据源 持久化到 .codepilot/dashboard/dashboard.json
  → 看板面板渲染 → 刷新时按数据源获取最新数据 → AI 保持设计只更新数据
```

## 目录结构

```
src/lib/
├── dashboard-mcp.ts          # MCP Server（5 工具 + system prompt）
├── dashboard-store.ts        # 文件 CRUD（读写 .codepilot/dashboard/dashboard.json）
├── dashboard-file-reader.ts  # glob 解析 + 文件读取（共享给 MCP 和 API route）
├── dashboard-cli-reader.ts   # CLI 命令执行（10s 超时，50KB 上限）
├── dashboard-export.ts       # Widget 导出 PNG（Electron BrowserWindow 截图）

src/types/
├── dashboard.ts              # DashboardDataSource（file|mcp_tool|cli）、Widget、Config

src/app/api/dashboard/
├── route.ts                  # GET/PUT/DELETE（读配置、设置+排序、删除）
├── refresh/route.ts          # POST（file 数据源自动刷新）

src/components/layout/panels/
├── DashboardPanel.tsx         # 右侧面板 UI

electron/
├── main.ts                   # widget:export-png IPC handler（隔离 BrowserWindow）
├── preload.ts                # electronAPI.widget.exportPng bridge
```

## 数据模型

```typescript
type DashboardDataSource =
  | { type: 'file'; paths: string[]; query?: string }
  | { type: 'mcp_tool'; serverName: string; toolName: string; args?: Record<string, unknown> }
  | { type: 'cli'; command: string; query?: string };

interface DashboardWidget {
  id: string;                // "w_{timestamp}_{random}"
  title: string;             // 人类可读，匹配用户语言
  widgetCode: string;        // 原始 HTML/JS/CSS
  dataContract: string;      // 自然语言：展示什么数据、如何提取
  dataSource: DashboardDataSource;
  pinnedFrom?: { sessionId: string; messageId: string };
  createdAt: string;
  updatedAt: string;
  order: number;
}
```

存储路径：`{projectDir}/.codepilot/dashboard/dashboard.json`

## MCP Server（codepilot-dashboard）

5 个工具，全部 auto-approved（refresh 不执行命令所以安全）：

| 工具 | 功能 | 安全说明 |
|------|------|---------|
| `codepilot_dashboard_pin` | Pin widget 到看板 | 纯写文件 |
| `codepilot_dashboard_list` | 列出所有 widget | 只读 |
| `codepilot_dashboard_refresh` | 读取数据源返回给模型 | file 读文件；cli 返回命令文本让模型用 bash 执行（不自己 execSync）；mcp_tool 告诉模型调对应工具 |
| `codepilot_dashboard_update` | 更新 widget 代码/标题/契约 | 纯写文件 |
| `codepilot_dashboard_remove` | 删除 widget | 纯写文件 |

**关键词门控**（claude-client.ts）：`/dashboard|仪表盘|看板|pin.*widget|refresh.*widget|固定.*组件|刷新.*组件|codepilot_dashboard/i`

**System prompt 注入**：`DASHBOARD_MCP_SYSTEM_PROMPT` 描述工具用法和数据源类型。

**Dashboard context 注入**（context-assembler.ts Layer 6）：当 session 有 working_directory 时，读取看板配置，把 widget 标题 + 数据契约作为 `<active-dashboard>` 注入 system prompt（≤500 字符），让 AI 知道用户在追踪什么。

## Pin 流程

```
用户点 Pin 按钮（WidgetRenderer 工具栏）
  → PinnableWidget dispatch 'widget-pin-request' 事件（携带 widgetCode + title）
  → ChatView 监听 → 调 sendMessage（完整 widget 代码给 AI，UI 显示"📌 固定到看板"）
  → AI 收到指令 → 调 codepilot_dashboard_pin MCP 工具
  → MCP 工具构建 DashboardWidget → addWidget() 写入 JSON
  → DashboardPanel 轮询检测到变化 → 显示新卡片
```

没有独立的 pin API 路由——所有 pin 操作通过对话 + MCP 完成，AI 在完整上下文中推断 dataContract 和 dataSource。

## 刷新流程

**按钮刷新**（API route，只处理 file 类型）：
```
用户点刷新 → POST /api/dashboard/refresh
  → file 类型：resolveGlobs → readSourceFiles → mtime 检查 → generateTextViaSdk → updateWidget
  → mcp_tool / cli 类型：return null（跳过，只能通过对话刷新）
```

**对话刷新**（MCP 工具）：
```
用户说"刷新看板" → AI 调 codepilot_dashboard_refresh
  → file 类型：读文件返回内容
  → cli 类型：返回命令文本，AI 自己用 bash 执行（用户看到命令可以拒绝）
  → mcp_tool 类型：告诉 AI 调对应 MCP 工具
  → AI 生成新 HTML → 调 codepilot_dashboard_update 保存
```

## 面板 UI

**排序**：CSS `order` 属性控制视觉顺序，DOM 顺序按 ID 排序不变。避免 React 重排导致 iframe 重载。持久化发送绝对 `widgetOrder`（ID 列表），不发相对 up/down，避免竞态。

**轮询**：streaming 期间每 3 秒检测 widget 数量变化；streaming 结束后做一次 final fetch。

**标题点击**：dispatch `dashboard-widget-drilldown` 事件 → ChatView 发送分析指令给 AI。

## Widget 导出

**Electron 路径**（正式）：
1. `dashboard-export.ts` 构建独立 HTML 页面（含 CSP + CDN + 脚本执行 + `__scriptsReady__` 信号）
2. IPC 发到主进程 → 创建隔离 BrowserWindow（`show:false`、独立 `partition`、`sandbox:true`、无 preload、导航阻断）
3. `capturePage()` 截图 → 返回 PNG base64 → 销毁窗口

**安全**：CSP `img-src data: blob:; font-src data:; connect-src 'none'`；`will-navigate` + `setWindowOpenHandler` 阻断所有导航。

**Web**：不支持，抛错。

## Cross-Widget 通信

**发布**：widget 内调 `window.__widgetPublish('topic', data)` → postMessage 到父窗口

**中转**：DashboardPanel 监听 `widget-cross-publish` 事件 → 验证 `sourceIframe` 在 panelRef 内 → 广播 `widget:crossFilter` 到面板内其他 iframe

**接收**：iframe 收到 `widget:crossFilter` → dispatch `widget-filter` CustomEvent → widget 内代码监听并更新

**隔离**：发布端和接收端都限定在 dashboard 面板内，不泄漏到聊天 widget 或预览面板。

## CDN 脚本执行（widget-sanitizer.ts）

```
finalizeHtml(html):
  分离 scripts → 视觉 HTML 写入 root
  → CDN scripts: 逐个 appendChild, onload/onerror 计数
  → 全部 CDN 完成后: _appendInline() 执行一次 inline scripts
  → inline 执行完: widget:scriptsReady 信号（导出依赖此信号）
  → 无 CDN: 直接 _appendInline()
```

**不重复执行**（`_appendInline` 只调一次），**不超时锁死**（无 flag、无 setTimeout fallback）。

## Widget 解析（MessageItem.tsx）

**Fence-agnostic 解析器**：不依赖特定反引号格式。用正则匹配任意 `` `{1,3}show-widget `` 标记，然后用 JSON brace matching（`findJsonEnd`）提取完整 JSON 对象。处理所有模型变体：
- ` ```show-widget\n{...}\n``` `（标准）
- `` `show-widget`\n```json\n{...}\n``` ``（GLM 变体 A）
- `` `show-widget\n{...}\n` ``（GLM 变体 B）
- 以及任何未来变体

## 涉及文件完整清单

| 文件 | 作用 |
|------|------|
| `src/lib/dashboard-mcp.ts` | MCP Server（5 工具） |
| `src/lib/dashboard-store.ts` | 文件 CRUD + moveWidget + reorderWidgets |
| `src/lib/dashboard-file-reader.ts` | glob 解析 + 文件读取 |
| `src/lib/dashboard-cli-reader.ts` | CLI 命令执行 |
| `src/lib/dashboard-export.ts` | Widget 导出 PNG |
| `src/types/dashboard.ts` | 类型定义 |
| `src/app/api/dashboard/route.ts` | GET/PUT/DELETE API |
| `src/app/api/dashboard/refresh/route.ts` | 刷新 API |
| `src/components/layout/panels/DashboardPanel.tsx` | 面板 UI |
| `src/components/chat/MessageItem.tsx` | PinnableWidget + fence-agnostic 解析器 |
| `src/components/chat/ChatView.tsx` | pin/drilldown 事件监听 |
| `src/components/chat/WidgetRenderer.tsx` | extraButtons + widget:publish + finalizedCodeRef |
| `src/lib/widget-sanitizer.ts` | CDN 脚本执行 + __widgetPublish + widget:capture |
| `src/lib/widget-guidelines.ts` | rule 12-14 |
| `src/lib/claude-client.ts` | MCP 注册 + auto-approval |
| `src/lib/context-assembler.ts` | Layer 6 dashboard context |
| `electron/main.ts` | export IPC handler |
| `electron/preload.ts` | electronAPI.widget bridge |
| `src/hooks/useToast.ts` | loading toast |
| `src/components/ui/toast.tsx` | loading 图标 |
