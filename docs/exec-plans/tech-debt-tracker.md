# Tech Debt Tracker / 技术债务追踪

已知技术债务清单。每项标注优先级、影响范围和初步解决思路。

**AI 须知：发现新的技术债务时添加到此文件；解决后标注完成日期。**

## 活跃项

| # | 描述 | 优先级 | 影响范围 | 发现日期 |
|---|------|--------|----------|----------|
| 1 | ESLint 存量 4 个 error（`MessageItem.tsx` hooks 条件调用、`ChatView` impure render、`GalleryDetail` setState in effect） | 中 | CI lint 步骤需 `continue-on-error` | 2026-03-04 |
| 2 | `conversation-registry` / `permission-registry` 运行态依赖内存 Map，重启后丢失 | 中 | 长时间运行的会话、Bridge 模式 | 2026-02-26 |
| 3 | 消息 fallback 上下文固定最近 50 条，无动态 token 预算截断 | 低 | 长会话上下文质量 | 2026-02-26 |
| 4 | `context-storage-migration` Phase 0 剩余：`projects` 表未建、`canUpdateSdkCwd` 未实现 | 低 | 多项目隔离 | 2026-03-04 |
| 5 | Bridge 的 `/mode plan` 在会话权限档位为 `full_access` 时仍会被 `bypassPermissions` 覆盖，导致 Plan 语义失效；需让 bridge 与桌面聊天一致，显式以 Plan 优先于 full_access | 中 | Bridge 远程会话的权限/安全语义 | 2026-03-25 |
| 6 | Electron 主进程行为（外链拦截、窗口管理等）无自动化测试覆盖。现有 Playwright 测试只覆盖 Next.js web 层，需要搭建 `@playwright/test` + `_electron.launch()` 的 Electron E2E 测试框架 | 低 | Electron 主进程回归风险 | 2026-03-30 |

## 已解决

| # | 描述 | 解决日期 | 解决方式 |
|---|------|----------|----------|
| — | （暂无） | | |
