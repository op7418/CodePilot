# MCP Guardrail

> **Status: Stub** — 七节模板占位。首次真实改动触发时由实施 Agent 按 [`README.md`](./README.md) 的七节模板填充。
> **为什么先读**：MCP server 加载 / provider resolution / 持久化跨多个 API 路由；`/api/plugins/mcp/status?sessionId=xxx` 自动从 session.provider_id 解析，前端不需要显式传 providerId（memory 已固化的关键模式）。
> **已知关键文件**：`src/app/api/plugins/mcp/*`、MCP server 加载相关 lib、`src/lib/db.ts` MCP 配置表。

## 词汇表

- `MCP` — Model Context Protocol，第三方工具/资源接入协议。
- `mcp/status` — Session-level MCP 状态查询接口。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|--------|--------|
| 1 | `GET /api/plugins/mcp/status?sessionId=xxx` 自动从 `getSession(sessionId).provider_id` 解析 providerId；前端不需要也不应该显式传 | `src/app/api/plugins/mcp/status/route.ts` |
| 2 | provider_id 为空的 session 回退到 'env' | 同上 |
| 3 | Native Runtime 连接池按配置的稳定序列化（command / args / env / url 等，键顺序无关）比较；配置变了先断开再重连，没变不重连 | `src/lib/mcp-connection-manager.ts` `syncMcpConnections` |
| 4 | 连接失败的 server 在 `MCP_FAILED_RETRY_COOLDOWN_MS`（60 秒）内不被 `syncMcpConnections` 重试，因为 agent-loop 每轮对话都调同步；配置变更立即重试；`connectServer` / `reconnectServer`（toggle、reconnect 路由等用户主动操作）不受冷却限制 | 同上 |
| 5 | `connectServer` 失败时必须关闭 transport，否则 stdio 子进程会泄漏；对同名 server 再次 `connectServer` 先关闭旧 client | 同上 `connectServer` |

## 改动检查表

- [ ] 改 MCP status 路由时确认仍自动解析 providerId
- [ ] 加 MCP 配置字段时同步 schema migration
- [ ] 改 server 加载逻辑时考虑 Bridge 模式 / 后台常驻
- [ ] （待填充）

## 常见坑

- tech-debt #2 — `permission-registry` / `conversation-registry` 运行态依赖内存 Map，重启后丢失；MCP 相关运行态如果用同样模式要注意。
- tech-debt #5 — Bridge 的 `/mode plan` 在 `full_access` 时会被 `bypassPermissions` 覆盖；MCP 相关权限 / 模式控制要保持一致。

## 测试覆盖

| 契约 | 测试文件 |
|------|----------|
| 3、4、5 | `src/__tests__/unit/mcp-connection-manager.test.ts` |

## 设计决策日志

- 已实现：`/api/plugins/mcp/status` 自动 providerId 解析（memory 已固化）。
