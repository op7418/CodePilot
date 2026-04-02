# Exec Plans / 执行计划

中大型功能的执行计划，包含分阶段目标、进度状态和决策日志。

**AI 须知：**
- 新建执行计划放在 `active/`，完成后移至 `completed/`
- 纯调研/可行性分析仍放 `docs/research/`
- 修改或新增文件后更新下方索引
- 检索本目录前先读此文件

## 什么时候需要执行计划

- 涉及数据库 schema 变更
- 跨 3 个以上模块的功能
- 需要分阶段交付的中大型功能
- 重构或迁移类任务

## 执行计划模板

```markdown
# {功能名称}

> 创建时间：YYYY-MM-DD
> 最后更新：YYYY-MM-DD

## 状态

| Phase | 内容 | 状态 | 备注 |
|-------|------|------|------|
| Phase 0 | ... | 📋 待开始 / 🔄 进行中 / ✅ 已完成 / ⏸ 暂缓 | |

## 决策日志

- YYYY-MM-DD: 决策内容及原因

## 详细设计

（目标、技术方案、拆分步骤、依赖项、验收标准）
```

## 索引

### Active

| 文件 | 主题 | 状态 |
|------|------|------|
| active/chat-latency-remediation.md | 聊天链路提速 + 模式入口收敛 + MCP 持久开关 | Phase 0 完成，Phase 1-4 待开始 |
| active/context-storage-migration.md | 上下文共享与存储迁移 | Phase 0 部分完成，Phase 1-3 待开始 |
| active/site-and-docs.md | 官网 + 文档站（apps/site） | Phase 0-1 进行中 |
| active/weixin-bridge-channel.md | 微信 Bridge 通道一次性交付方案 | One Shot 待开始 |
| active/unified-context-layer.md | 统一上下文层 + 浮窗助理 + 产品架构演进 | Phase 1-3 已完成，Phase 4-5 待开始 |

### Completed

| 文件 | 主题 | 完成日期 |
|------|------|----------|
| completed/engineering-quality-assurance.md | 工程质量保障体系（Harness Engineering）— 验证闭环、AI 文档、CDP、执行计划 | 2026-03-04 |
