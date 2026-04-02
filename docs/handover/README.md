# Handover / 交接文档

系统架构、数据流、关键设计决策的持久化记录，供后续开发者（含 AI）快速上手。

**AI 须知：修改或新增文件后更新下方索引；检索本目录前先读此文件。**

## 索引

| 文件 | 主题 |
|------|------|
| agent-tooling-todo-bridge.md | SDK → SSE → DB 事件流、TodoWrite 字段映射、去重策略 |
| bridge-system.md | 多 IM 远程桥接系统架构（目录结构、数据流、设计决策） |
| assistant-workspace.md | 助理工作区：人格/记忆文件、对话式引导、自动触发、确定性落盘 |
| theme-system.md | 主题家族系统：两层架构、JSON schema、代码高亮三条渲染链、12 个主题清单 |
| cli-tools.md | CLI 工具管理：静态 catalog、系统检测、一键安装、AI 描述、聊天上下文注入、输入框选择器 |
| ui-governance.md | 设计模式治理：四层架构、ESLint 规则、图标/颜色统一、组件拆分记录、新增文件清单 |
| git-terminal-layout.md | Git 集成 + 终端 + 统一布局重构：四层布局、Git 后端/前端、终端抽屉、ResizeHandle 统一、已知债务 |
| onboarding-setup-center.md | 首次引导 Setup Center：三卡片引导流程、Claude Code 环境检测与冲突处理、Provider 三条凭据来源、目录校验回退链、Toast 系统、Windows 适配 |
| generative-ui.md | 生成式 UI Widget 系统：代码围栏触发、receiver iframe 渲染、CSS 变量桥接、流式预览、高度缓存、安全模型、UX 优化清单 |
| media-pipeline.md | 媒体管线：MCP image/audio 回显、Gallery 视频支持、文件树媒体预览、CLI 工具导入、MediaBlock 类型、入库机制、安全模型 |
| dashboard.md | 项目看板：MCP Server（5 工具）、数据源（file/mcp_tool/cli）、排序（CSS order）、导出（Electron 隔离窗口）、cross-widget 通信、CDN 脚本执行、fence-agnostic 解析器 |
| provider-error-doctor.md | Provider/Auth/Error 全链路修复 + Doctor 诊断中心：16 类错误分类、Provider 生效修复、Auth Style 自动分流、5 探针诊断引擎、修复动作、runtime-log 脱敏、CI arm64 原生构建 |
| memory-system-v3.md | 记忆系统 V3/V3.1：对话式 Onboarding、HEARTBEAT_OK 心跳协议、Memory Search MCP、时间衰减、Obsidian 感知、渐进式文件更新、Telegram 静默、transcript 裁剪 |
| buddy-gamification.md | Buddy 游戏化系统：生成/进化/3D 视觉、心跳双模式（完整 tick + 软 hint）、定时任务调度器健壮性、通知队列/轮询/Electron IPC、symlink 安全、cron 4 年扫描 |
