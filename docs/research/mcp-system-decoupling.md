# MCP 系统脱离 claude-agent-sdk 独立实现 — 深度调研

> 创建时间：2026-04-06
> 关联执行计划：decouple-claude-code

## 1. CodePilot 内置 MCP Server 功能清单

CodePilot 有 7 个内置 MCP Server（21 个 tools）：

### 1.1 codepilot-memory（memory-search-mcp.ts）
- **注册条件**：Always-on，assistant 模式
- **Tools**：
  - `codepilot_memory_search` — 关键词搜索工作区记忆，支持时间衰减、tag/type 过滤、AI reranking
  - `codepilot_memory_get` — 读取工作区内指定文件（路径安全检查）
  - `codepilot_memory_recent` — 最近 3 天日记和长期记忆摘要

### 1.2 codepilot-notify（notification-mcp.ts）
- **注册条件**：Always-on
- **Tools**：
  - `codepilot_notify` — 发送即时通知（toast/system/telegram）
  - `codepilot_schedule_task` — 创建定时任务
  - `codepilot_list_tasks` — 列出定时任务
  - `codepilot_cancel_task` — 取消定时任务
  - `codepilot_hatch_buddy` — 孵化虚拟伙伴

### 1.3 codepilot-cli-tools（cli-tools-mcp.ts）
- **注册条件**：Keyword-gated（CLI 工具/安装/更新相关关键词）
- **Tools**：
  - `codepilot_cli_tools_list` — 列出 CLI 工具
  - `codepilot_cli_tools_install` — 安装 + 注册
  - `codepilot_cli_tools_add` — 手动注册
  - `codepilot_cli_tools_remove` — 移除
  - `codepilot_cli_tools_check_updates` — 检查更新
  - `codepilot_cli_tools_update` — 执行更新

### 1.4 codepilot-dashboard（dashboard-mcp.ts）
- **注册条件**：Keyword-gated
- **Tools**：
  - `codepilot_dashboard_pin` — 固定 widget
  - `codepilot_dashboard_list` — 列出 widget
  - `codepilot_dashboard_refresh` — 读取数据源
  - `codepilot_dashboard_update` — 更新 widget
  - `codepilot_dashboard_remove` — 移除 widget

### 1.5 codepilot-media（media-import-mcp.ts）
- **注册条件**：Keyword-gated
- **Tools**：`codepilot_import_media` — 导入媒体文件

### 1.6 codepilot-image-gen（image-gen-mcp.ts）
- **注册条件**：与 media 同时
- **Tools**：`codepilot_generate_image` — Gemini 生成图片

### 1.7 codepilot-widget（widget-guidelines.ts）
- **注册条件**：Keyword-gated
- **Tools**：`codepilot_load_widget_guidelines` — 加载 widget 设计规范

---

## 2. @modelcontextprotocol/sdk 客户端关键 API

项目已安装 `@modelcontextprotocol/sdk@1.27.1`。

### Client 类

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

const client = new Client({ name: 'codepilot', version: '1.0.0' })
await client.connect(transport)

await client.listTools()        // → { tools: Tool[] }
await client.callTool({ name, arguments })  // → { content, isError? }
await client.listResources()    // → { resources: Resource[] }
await client.readResource({ uri })
await client.ping()
await client.close()
```

### 传输层

| Transport | 导入路径 | 场景 |
|-----------|---------|------|
| `StdioClientTransport` | `client/stdio.js` | 本地进程 |
| `SSEClientTransport` | `client/sse.js` | 远程 SSE（兼容） |
| `StreamableHTTPClientTransport` | `client/streamableHttp.js` | 远程 HTTP（推荐） |
| `InMemoryTransport` | 主导出 | 同进程 Client-Server |

### InMemoryTransport（关键桥梁）

```typescript
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
```

若要保持内置 MCP Server 的 MCP 协议兼容性，可用此方案。

---

## 3. MCP Tools → Vercel AI SDK Tools 转换

### OpenCode 方案（已验证）

```typescript
import { dynamicTool, jsonSchema } from 'ai'

function convertMcpTool(mcpTool, client) {
  const schema = {
    ...mcpTool.inputSchema,
    type: 'object',
    properties: mcpTool.inputSchema.properties ?? {},
    additionalProperties: false,
  }
  return dynamicTool({
    description: mcpTool.description ?? '',
    inputSchema: jsonSchema(schema),
    execute: async (args) => {
      return client.callTool({ name: mcpTool.name, arguments: args })
    },
  })
}
```

关键点：
- 用 `dynamicTool()`（运行时 JSON Schema）而非 `tool()`（Zod）
- `additionalProperties: false` 必须
- `jsonSchema()` 包装 MCP 的 JSON Schema

### Craft Agents 方案

集中式 `McpClientPool`，`mcp__{slug}__{toolName}` 命名，pool.callTool 路由。

---

## 4. 内置 MCP Server 迁移策略

### 方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 直接转为 AI SDK tool | 最简单、零协议开销 | 失去 MCP 兼容性 |
| B. McpServer + InMemoryTransport | 架构不变 | 额外序列化开销 |
| C. 混合 | 灵活 | 两套模式 |

### 推荐方案 A

理由：
1. 21 个 tools 都是纯函数调用，无 resources/prompts/subscriptions
2. 转换工作量小：`tool(name, desc, schema, handler)` → `tool({ description, parameters, execute })`
3. Keyword-gating 在 Agent Loop 层实现更合理

### 迁移示例

**Before：**
```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
export function createNotificationMcpServer() {
  return createSdkMcpServer({
    name: 'codepilot-notify',
    tools: [tool('codepilot_notify', 'Send notification...', { title: z.string() }, handler)],
  });
}
```

**After：**
```typescript
import { tool } from 'ai';
export const notificationTools = {
  codepilot_notify: tool({
    description: 'Send notification...',
    parameters: z.object({ title: z.string() }),
    execute: handler,
  }),
};
```

---

## 5. 外部 MCP Server 连接管理方案

### McpConnectionManager 设计

```
McpConnectionManager
├── connect(name, config) → Client + Transport → listTools()
├── disconnect(name)
├── sync(desiredConfigs) → 增删连接
├── getTools() → Map<serverName, Tool[]>
├── callTool(serverName, toolName, args) → result
└── status() → Map<serverName, 'connected' | 'failed' | 'disabled'>
```

### 传输层映射

| config.type | Transport |
|------------|-----------|
| `stdio` | `StdioClientTransport({ command, args, env })` |
| `sse` | `SSEClientTransport(url, { headers })` |
| `http` | `StreamableHTTPClientTransport(url, { headers })` |

### Tool 命名约定

- 外部 MCP：`mcp__{serverName}__{toolName}`
- 内置：保持原名（如 `codepilot_notify`）

### 错误处理

- 连接失败标记 `failed`，不影响其他 Server
- 提供 `reconnect` API
- OAuth：`@modelcontextprotocol/sdk/client/auth.js` 的 `UnauthorizedError`

---

## 6. 改动点清单

### 新增

| 文件 | 说明 |
|------|------|
| `src/lib/mcp-connection-manager.ts` | 外部 MCP 连接池 |
| `src/lib/mcp-tool-adapter.ts` | MCP Tool → AI SDK Tool 转换 |

### 重写

| 文件 | 说明 |
|------|------|
| `src/lib/memory-search-mcp.ts` | 导出 AI SDK tool 定义 Map |
| `src/lib/notification-mcp.ts` | 同上 |
| `src/lib/cli-tools-mcp.ts` | 同上 |
| `src/lib/dashboard-mcp.ts` | 同上 |
| `src/lib/media-import-mcp.ts` | 同上 |
| `src/lib/image-gen-mcp.ts` | 同上 |
| `src/lib/widget-guidelines.ts` | 同上 |
| `src/lib/claude-client.ts` | 移除 toSdkMcpConfig() 和 MCP 拼接逻辑 |
| `src/lib/agent-sdk-capabilities.ts` | MCP 状态改为查 ConnectionManager |
| `src/app/api/plugins/mcp/status/route.ts` | 查 ConnectionManager |

### 保留

- `src/app/api/plugins/mcp/route.ts` — 配置 CRUD 不变
- `src/app/api/plugins/mcp/[name]/route.ts` — 单 Server CRUD 不变

### 依赖变化

- 保留 `@modelcontextprotocol/sdk`
- 移除对 SDK 的 `createSdkMcpServer` 和 `tool` 导入
- 新增使用 `ai` 包的 `tool`、`dynamicTool`、`jsonSchema`
