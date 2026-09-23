# Guardrails 目录

模块级开发契约。每份文档锁住一个跨多个文件的不变量集合，目的是让未来改这块代码的人（AI 或人类）能在动手前快速校准"这里有哪些不能碰的边"。

## 文件清单

### 已成稳定契约（七节完整填充）

- [`Runtime.md`](./Runtime.md) — Provider / Model / Composer 的 runtime 过滤契约。改 `chat-runtime.ts` / `runtime-compat.ts` / `useProviderModels.ts` / `ChatView` 任意一个前必读
- [`ProviderManagement.md`](./ProviderManagement.md) — Settings > Providers 信息架构、preset 匹配、provider_models 表关系、删除安全。改 `ProviderManager.tsx` / `ProviderCard.tsx` / `provider-presets.tsx` / `provider-catalog.ts` / `/api/providers/*` 前必读
- [`ModelDiscovery.md`](./ModelDiscovery.md) — discover-models 三步流（probe / confirm / apply）+ user_edited 守护 + classification 分类。改 `model-discovery.ts` / `applyDiscoveryDiff` / refresh dialog 前必读
- [`ComposerModelSelection.md`](./ComposerModelSelection.md) — useProviderModels resolved pair 契约 + ChatView 三道 send gate + new chat page 自治路径。改 `useProviderModels.ts` / `MessageInput.tsx` / `ChatView.tsx` / `chat/page.tsx` / `useAssistantTrigger.ts` 前必读
- [`WorkspaceSidebar.md`](./WorkspaceSidebar.md) — Workspace Sidebar 的瞬时 Tab / 项目 Pin / shell collapse 分层、Primary + Inspector 与 legacy 只读迁移。改 `useWorkspaceSidebar.tsx` / `WorkspaceSidebar/*` / workspace surface persistence 前必读
- [`i18n.md`](./i18n.md) — typed dictionary / 局部双语 pair / 风险与计费承诺一致性。改任何 UI 文案前必读
- [`DatabaseSchema.md`](./DatabaseSchema.md) — additive migration、conservative backfill、`preset_key` 稳定身份。改 schema 前必读
- [`Onboarding.md`](./Onboarding.md) — OpenAI/xAI OAuth refresh、原子 bundle、loopback/device flow、bearer host 防泄漏。改凭据相关代码前必读
- [`ElectronMain.md`](./ElectronMain.md) — Electron 构建/packaged server 与 OAuth loopback 跨平台门禁。改 `electron/*`、打包脚本或 browser OAuth 前必读
- [`PermissionBoundary.md`](./PermissionBoundary.md) — `mutationLevel`、子 Agent 权限 ceiling / run 归属、跨 Runtime reviewer 一致性。改权限或 delegation 前必读
- [`StreamSession.md`](./StreamSession.md) — 双入口 stream、snapshot 生命周期、子 Agent tool id / requested-effective / 卡片分流契约。改 `claude-client.ts` / tool stream / Chat 消息渲染前必读
- [`HarnessHome.md`](./HarnessHome.md) — 用户文件事实源、opaque adapter、单写者/journal/manifest-last、SecretRef 与 evidence-only Taste 契约。改 `src/lib/harness-home/**`、接新 Harness 或 canonical projection 前必读
- [`Memory.md`](./Memory.md) — Runtime 中立记忆、读写权限、来源/CAS/撤销、显式绑定与成功回合抽取；改 memory 服务、工具或管理界面前必读
- [`AssistantWorkspace.md`](./AssistantWorkspace.md) — 默认助理 no-touch/CAS、`instructions.md` 中立规则、心跳 desired/actual 分离与系统通知纵向闭环。改助理目录、心跳或通知设置前必读
- [`SentryTelemetry.md`](./SentryTelemetry.md) — official-stable enable、main-only Release Health、default-deny sanitizer、normalized grouping、provider/in-band stream terminal anti-double-capture 与 private source-map 发布契约。改三层 Sentry init、capture、CI map 上传或打包入口前必读
- [`Updater.md`](./Updater.md) — Main-owned updater、stable feed/channel、签名/metadata 前置、活动任务保护、窄 IPC 与手工 fallback。改 updater、preload bridge、更新 UI 或 release feed 前必读
- [`CliMaintenance.md`](./CliMaintenance.md) — Claude/Codex selected-target 渠道证明、same-channel latest、Main-owned 一键更新、provider lease、进程树回收与 app updater/quit 双向互斥。改 CLI 检测、更新入口或 Runtime spawn 前必读

### Stub（尚未被真实改动激活的高风险入口；首次 on-touch 时由实施 Agent 填充）

- [`MCP.md`](./MCP.md) — MCP server 加载 / provider resolution / 持久化跨多 API 路由。改 `/api/plugins/mcp/*` 前必读
- [`Release.md`](./Release.md) — RELEASE_NOTES 格式 / 版本号 / tag / CI 自动发版严格顺序（不能删 tag 否则 Release 变 Draft）。发版前必读

## 写作规范

每份护栏文档至少包含：
1. **词汇表** — 这块代码用的所有专有名词 + 来源
2. **不变量 / 契约表** — 行为规则，越严格越好
3. **关键文件 + 责任** — 哪个不变量由哪个文件守
4. **改动检查表** — 加新功能时必须想到的点
5. **常见坑** — 被踩过的 / Codex review 指出过的反模式
6. **测试覆盖** — 每条契约对应哪个 test，回归时跑哪个文件
7. **设计决策日志** — 关键变更的日期 + 理由（为后人解释"为什么不那样做"）

## 跟其他 docs 的关系

- `design.md`：UI 视觉规范（颜色 / 圆角 / 间距）。本目录管行为契约
- `handover/`：模块完整架构（数据流 / schema / 入口路由）。本目录是其中"不变量"那一节的扩写
- `exec-plans/`：进行中的工作。本目录是已稳定的契约
