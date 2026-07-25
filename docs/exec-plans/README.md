# Exec Plans / 执行计划

中大型功能的执行计划，包含分阶段目标、进度状态和决策日志。

> **重构已完成并随 v0.55.0 / v0.55.1 发布。** 原重构总控板已归档为 [completed/refactor-closeout.md](completed/refactor-closeout.md)（重构收口历史）。当前在推进的计划以维护中的「Active — 当前推进」表为准；ClaudeCode / Codex **只从 `active/` 领任务**，不从 `completed/` / `deferred/` / `superseded/` 自行开支线。
>
> **查历史细节：`completed/refactor-phase-*.md` + `completed/phase-4-markdown-artifact.md` + `completed/phase-5*.md`**——总控板里的"历史归档"列直接 link 过去。Phase 1（模型同步与渠道扩展）/ Phase 2（Runtime 与会话执行）/ Phase 3（后台常驻、定时任务、通知）/ Phase 4（Markdown 数据层 + Artifact 表现层）/ Phase 5（Codex Runtime + Harness 架构）已完成的计划文本与全部决策日志按 Phase 归档，不要去 active 总控板里翻。

**AI 须知：**
- 新建执行计划放在 `active/`；按下面「目录语义」流转到 `completed/` / `deferred/` / `superseded/`
- 纯调研/可行性分析仍放 `docs/research/`
- 修改或新增文件后更新下方索引
- 检索本目录前先读此文件

## 目录语义（四类目录）

`docs/exec-plans/` 下的执行计划分四类，**AI 只从 `active/` 领任务**：

| 目录 | 含义 | 当前任务入口 |
|------|------|--------------|
| `active/` | 真正在推进的当前计划 | ✅ 是 |
| `completed/` | 已完成，留作历史执行日志与决策证据 | ❌ 否 |
| [`deferred/`](deferred/README.md) | 用户明确暂缓、未来可能重启 | ❌ 否 |
| [`superseded/`](superseded/README.md) | 被新计划接管、仅作历史参考 | ❌ 否 |

`deferred` / `superseded` 里的文件顶部都有 `Archive note`，说明移出原因和重启方式；恢复工作由用户主动发起、再 `git mv` 回 `active/`。

## 什么时候需要执行计划

- 涉及数据库 schema 变更
- 跨 3 个以上模块的功能
- 需要分阶段交付的中大型功能
- 重构或迁移类任务

## Signal → Triage → Fix → Verify → Guardrail

中大型功能进入执行后，所有 P1/P2 review finding、用户反馈、CDP 失败、测试失败、日志暴露的问题，都按同一个闭环处理，避免问题只停留在聊天记录里。

| 阶段 | 要求 | 产物 |
|------|------|------|
| Signal | 记录触发信号：review finding、用户反馈、CDP 截图、测试失败、日志证据 | finding / issue / plan note |
| Triage | 判断根因、影响范围、是否阻断用户路径、是否已有同类历史 | 修复范围 + 优先级 |
| Fix | 做最小必要改动；Claude Code 不得借小修复扩成无关重构 | commit / patch summary |
| Verify | 跑相关测试；UI 改动必须实际验证（CDP 仅作深度诊断备用，验证强度按 [CLAUDE.md](../../CLAUDE.md) 测试分层 Tier 0/1/2）；说明验证场景 | test output / 验证记录 |
| Guardrail | 同类问题第二次出现，或涉及 schema/runtime/default/log/security，必须沉淀防线 | guardrail doc / tech-debt tracker / plan update |

**Claude Code 交付说明必须包含：**

- 上下文：用户原始诉求、讨论过程、关键判断、被否掉的方案和原因。不要只贴最终结论；尤其是跨 Runtime / provider / permission / schema / security 的任务，必须让下一个读计划的人知道为什么这么做。
- 根因：为什么会出错。
- 改动：按文件或模块说明改了什么。
- 验证：跑了哪些测试 / smoke / 浏览器或 CDP 路径（如有）。
- 防回归：新增测试、文档、guardrail，或说明为什么暂不需要。

**Codex review 规则：**

- Codex 给 ClaudeCode 的执行文案必须共享判断过程：先写用户问题和争议，再写取舍理由，最后才写执行清单。不能只把聊天里的结论压缩成命令，否则 ClaudeCode 重启或上下文变短后会重复旧误判。
- P1/P2 finding 不能只用聊天确认关闭，必须有修复、测试证据或 tech-debt tracker 条目。
- 涉及 Runtime resolver、默认模型、Provider/Models 暴露、日志脱敏、权限边界、DB schema 的改动，优先要求回归测试。
- 文案承诺类问题也算产品 bug：如果按钮/页面承诺了"诊断、修复、导出、安全"，实现必须真的支持，否则降级文案。

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

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

> 跑了真实 smoke 后必须在这里登记一行：Runtime / Provider / Model / 凭据形态 / 场景 / 结果 / 证据。不要把这类信息只留在聊天里——下次切回这个 Phase 时翻不到。
> 第一次跑前可保留下面这行示例不删；跑过后追加真实记录。

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|------|---------|----------|-------|---------|------|--------|----------|
| _示例_ | codex_runtime | OpenRouter | claude-haiku-4.5 | API key | two-turn chat | ✅ | session id / provider id / marker |
```

每个新阶段必须先写清楚：**用户会看到什么变化 / 哪个页面或按钮可以验收 / 本阶段明确不做什么**。说不清用户结果就不能开工（来自 refactor-closeout 审批原则）。

**Smoke Ledger 段是 development-harness-optimization Step 5 起的强制段**。新建 Phase 计划必须保留这段，不追溯已有 active phase（grandfather clause）。下次接入新 Runtime / Provider / 凭据形态时，真实 smoke 结果不再散落在聊天里，而是直接登记在所属 Phase 计划的 Smoke Ledger 表，回头一眼能找到。

## 索引

### Active — 当前推进

| 文件 | 主题 | 状态 |
|------|------|------|
| [active/qwen-token-plan-and-grok-access.md](active/qwen-token-plan-and-grok-access.md) | **千问 Token Plan 与 Grok 4.5 接入**：把百炼 Coding Plan、千问 Token Plan 个人版/团队版建模为三个稳定套餐，修复同 URL identity 串线并增加交互式使用 gate；xAI 同时接 API Key + Grok 4.5 Responses 和兼容 SuperGrok browser/device OAuth | 🟡 Phase 0–5、Tier 0/1、Web smoke 与 Electron build 已完成；真实 Qwen/xAI/SuperGrok 凭据和 packaged macOS/Windows 验收待外部条件 |
| [active/codebase-health-audit-2026-06.md](active/codebase-health-audit-2026-06.md) | **代码健康审计与修复计划（2026-06）**：6 路并行审计（流式核心 / Codex / DB+API / 前端 / Electron+构建 / 测试覆盖）产出 bug、性能、安全加固、测试补洞四个 Phase；关键发现已现场核验并逐条标注核验状态与验证分层；v2 已按 Codex 静态审查订正 7 处事实偏差与执行边界 | 🔄 Phase A 已完成（A1–A6），B/C/D 待实施（Codex 负责审查/用例设计） |
| [active/codex-cli-discovery-refresh.md](active/codex-cli-discovery-refresh.md) | **Codex CLI 发现与刷新修复**：适配当前 `ChatGPT.app` 内置 CLI，保留旧 `Codex.app`，修复进程级路径缓存与设置页假刷新，并让实际 selected binary/version 与登录失败可见 | 🟡 production UI、签名 arm64 `.app`/DMG/ZIP 与 packaged Codex status smoke 已完成；仅真实双安装终验待完成 |
| [active/v0.56.x-stability-trust.md](active/v0.56.x-stability-trust.md) | **v0.56.x Stability / Trust 总计划**：从 Notion GPT Pro 产品审查、当前 GitHub Issues / PR 治理状态、用户最新体验反馈汇总出的稳定性 umbrella plan；先收 codebase-health Phase A，再治理 session/context/stream/composer、文件引用安全、安装更新、CI 与 GitHub triage | 🚧 Phase 0/1 ✅ 已完成；Phase 2 进行中（Composer/Context 主链路 #1–#5 闭环；#629 已关闭 🟢、#635 代码层完成 🟡（待真实 smoke）、#632 假% 已修 item3 待续；stream 终态原因码 / 压缩回滚 / 诊断字段待续）；Phase 3 主问题 #628 已关闭 🟢；Phase 7 已细化为 GitHub 旧 issue 清库存 + 保守机器人治理批次，待 Claude Code 执行；Codex 持续核验 |
| [active/codex-stop-recovery.md](active/codex-stop-recovery.md) | **Codex Stop Recovery / 终止后恢复发送**：调研并修复 Codex Runtime 下 Stop 只切断前端 stream、未必调用 Codex app-server `turn/interrupt`，导致后台 collect / session lock / runtime status 未收口，下一条同会话指令无法拉起的问题；外部 Codex issues 只作症状旁证，不采信其根因推测 | 📋 待 Claude Code 接手修复 |
| [active/development-harness-optimization.md](active/development-harness-optimization.md) | **开发流程 Harness 优化（v2 + 2026-06-28 对账）**：Codex 初稿 + ClaudeCode 按用户"可审核"约束重组。方向上 Skill 化暂缓、主推自动检查脚本（docs drift / hook 配置）+ guardrails 八类必读 + Smoke Ledger 模板 + 测试矩阵补洞；2026-06-28 新增 Step 0 规则体系瘦身（顶层规则分工 / Ruler-compatible / 测试分层 / 简化汇报协议），并对账校准各 Step 真实状态；每个 Step 以"用户能看到什么 / 不做什么 / 怎么验收"开头 | 🔄 进行中（2026-06-28 对账 + Step 0/5 落地 + Step 6 核实）：Step 0-3 ✅、Step 4 🔄 部分（on-touch）、Step 5 ✅、Step 6 ✅（核实已覆盖）；仅剩 Step 4 持续填充 |
| [active/documentation-authority-lifecycle-reset.md](active/documentation-authority-lifecycle-reset.md) | **文档可信度与生命周期收口**：解决历史细文档被 Agent 当成当前事实的问题；建立 current/reference/historical 三层权威，先试点压缩 handover 与应急文档，再补历史降权、事件驱动复核和审查基线合同 | 📋 待启动（Phase 0 清单与风险分级） |
| [active/model-capability-reasoning-refresh.md](active/model-capability-reasoning-refresh.md) | **模型目录与推理强度统一适配**：GLM-5.2、Kimi for Coding、GPT-5.6、Claude Sonnet 5，以及 ClinePass / OpenCode Go 的显式 Kimi K3；按模型与网关真实 capability 驱动输入框右侧强度选择，不显示伪档位 | 🚧 Phase 0/1/2 恢复修复已落地，Kimi for Coding 为 Auto/Low/High/Max；ClinePass / OpenCode Go K3 direct smoke 通过，真实 provider effort smoke 待继续 |
| [active/runtime-permission-modes.md](active/runtime-permission-modes.md) | **跨 Runtime 权限模式**：在“按规则询问 / 完全访问”之间加入真正的“替我审批”；Claude/Codex 接上游 auto reviewer，Native AI SDK 先做 fail-closed POC，不把 tool approval 或 bypass 冒充代审 | 🚧 Claude/Codex code + contract tests 已闭合；Codex 已有 Runtime 分流、版本门与响应回显，真实 approve/deny/MCP smoke 仍待完成 |
| [active/automatic-chat-titles.md](active/automatic-chat-titles.md) | **自动会话命名**：先统一两套首消息截断与 UI 刷新，再以同 session provider 后台生成语义标题；provenance/CAS 保证手动、系统、导入标题不被覆盖 | ✅ Phase 0–2 code/tests 完成，真实凭据 smoke 待跑；Codex 仅有 name/set 写入原语，无内置 auto-title API，首版 fallback |
| [active/issue-tracker.md](active/issue-tracker.md) | **统一问题跟踪**：所有 Bug / Feature Request / Sentry 监控的活动看板 | 持续维护 |
| [active/log-bloat-codex-runtime-crash.md](active/log-bloat-codex-runtime-crash.md) | **日志暴涨与 Codex Runtime 闪退调研**：确认 12.5G 主日志不正常，主因是 Codex app-server INFO tracing 洪水、无 size-based rotation、主进程 `serverErrors` 无界累积；闪退与该链路高相关但需 live approval smoke 和 crash breadcrumb 定案 | 🔴 待 Claude Code 修复 logging 上限 + Codex tracing 降噪 |
| [active/mimo-ultraspeed-openai-compatible-provider.md](active/mimo-ultraspeed-openai-compatible-provider.md) | **MiMo UltraSpeed + OpenAI-compatible 三方 API**：小米 MiMo API 渠道补 `mimo-v2.5-pro-ultraspeed`；恢复通用 OpenAI-compatible provider，限定 CodePilot Runtime + Codex Runtime 可用，并先处理历史 migration 删除 openai-compatible provider 的 P0 阻断 | 📋 待 Claude Code 接手实现 |
| [active/post-0.55.1-issue-triage.md](active/post-0.55.1-issue-triage.md) | **0.55.1 后 Issues 调研与 Claude Code 接手优先级**：核对 #606/#612/#613/#614/#615/#616/#617/#618/#619/#620/#621 以及 #554/#577；确认 MiMo 回退已随 0.55 修复，当前重点为截图被吞、Ollama 误要求 Claude Code、Codex/Opus 模型列表不稳定、概率串会话 | 📋 待 Claude Code 按 P0/P1 接手 |

### Superseded（被接管，历史参考）— `superseded/`

已移到 [`superseded/`](superseded/README.md)（每份顶部有 Archive note）；被 refactor-closeout 接管，仅作历史参考，不再单独推进。

| 文件 | 原主题 | 接管至 |
|------|--------|--------|
| [superseded/opus-4-7-upgrade.md](superseded/opus-4-7-upgrade.md) | Opus 4.7 模型升级（双 SDK / `xhigh` / tokenizer / 字面化回归） | Phase 1（模型同步与渠道扩展） |
| [superseded/agent-sdk-0-2-111-adoption.md](superseded/agent-sdk-0-2-111-adoption.md) | SDK 0.2.111 能力采纳（chip / 限流 UI / WarmQuery / session fork / context usage） | Phase 2（Runtime 与会话执行）+ Phase 6（上下文可视化） |
| [superseded/scheduled-tasks-notifications.md](superseded/scheduled-tasks-notifications.md) | 定时任务 + 通知（Notification MCP / TaskScheduler / Electron 系统通知 / 管理 UI） | Phase 3（助理、定时任务、心跳通知） |
| [superseded/chat-latency-remediation.md](superseded/chat-latency-remediation.md) | 聊天链路提速（模式入口收敛 / MCP 持久 / 首包优化） | Phase 2（Runtime 与会话执行）+ Phase 3 |
| [superseded/context-storage-migration.md](superseded/context-storage-migration.md) | 上下文共享与存储迁移（`message_parts` / `session_runtime_state` / 压缩摘要） | Phase 6（上下文可视化）+ Phase 2 |
| [superseded/agent-runtime-abstraction-revision.md](superseded/agent-runtime-abstraction-revision.md) | Runtime 可插拔抽象层（薄接口、Native / SDK / 未来 Codex / Gemini） | Phase 2（Runtime 与会话执行）+ Phase 5（Codex Runtime） |
| [superseded/agent-trust-ownership-refactor.md](superseded/agent-trust-ownership-refactor.md) | Agent Trust & Ownership Refactor（剩余 Run Cockpit + session-level Runtime + 事件日志） | Phase 2（Runtime 与会话执行）+ Phase 3 |

### Deferred（暂缓，未来可能重启）— `deferred/`

已移到 [`deferred/`](deferred/README.md)（每份顶部有 Archive note）；用户明确暂缓，不是当前任务入口，重启由用户主动发起。

| 文件 | 原主题 | 暂缓原因 |
|------|--------|----------|
| [deferred/chat-run-checkpoint.md](deferred/chat-run-checkpoint.md) | Chat Run Checkpoint（Round 1+2 已完成；Round 3 PermissionPrompt 视觉收编） | Run Checkpoint Round 3（用户 2026-04-30 决定） |
| [deferred/memory-system-v3.md](deferred/memory-system-v3.md) | 记忆系统 V3（Phase 1-3 + V3.1 已完成；Phase 4 Memory Flush + Memory 管理面板） | Memory 管理面板 |
| [deferred/site-and-docs.md](deferred/site-and-docs.md) | 官网 + 文档站（Phase 0-3 已完成；Phase 4-5 packages/ui + 桌面端适配） | 大规模官网 / 文档站 |
| [deferred/weixin-bridge-channel.md](deferred/weixin-bridge-channel.md) | 微信 Bridge 通道一次性交付 | 更多 Bridge 渠道 |
| [deferred/qq-bridge-channel.md](deferred/qq-bridge-channel.md) | QQ Bridge Channel | 更多 Bridge 渠道 |
| [deferred/unified-context-layer.md](deferred/unified-context-layer.md) | 统一上下文层 + 浮窗助理（Phase 1-3 已完成；Phase 4-5 浮窗 + 通知） | 浮窗助理；通知 / 后台能力走 closeout Phase 3；上下文能力顺延 Phase 6 |
| [deferred/git-terminal-integration.md](deferred/git-terminal-integration.md) | Git + 终端集成 | 不在本轮 6 条主线 |

### Completed

> Refactor closeout 的 Phase 1-5 归档在 `completed/refactor-phase-*.md` + `completed/phase-4-markdown-artifact.md` + `completed/phase-5*.md`，由 active 总控板的"历史归档"列直接 link；下方按完成日期倒序排其它独立计划。

| 文件 | 主题 | 完成日期 |
|------|------|----------|
| [completed/document-system-governance.md](completed/document-system-governance.md) | **文档体系治理**：基于 2026-06-05 文档健康审计清理 active 语义污染，建立 deferred / superseded 目录，归档合并与 preview 旧计划，升级 docs drift 防线（结构化 banner + 归档桶内部链接完整性），并修复归档桶 21 处失效相对链接 | 2026-06-05 |
| [completed/refactor-closeout.md](completed/refactor-closeout.md) | **重构收口总控板（历史归档）**：6 大主线 Phase 0-8 收口；重构主体随 v0.55.0 / v0.55.1 发布 | 2026-06-04 |
| [completed/main-merge-readiness.md](completed/main-merge-readiness.md) | **重构分支合并主分支**：integration 演练 + 4 冲突手解 + 回归，main ff-only 合并并发布 | 2026-06-04 |
| [completed/merge-blockers-chat-ownership-openrouter.md](completed/merge-blockers-chat-ownership-openrouter.md) | **合并前收口**：侧栏新建对话入口已交付；OpenRouter 静默 Opus→Sonnet = tech-debt #37 已修（Codex 复审通过）| 2026-06-04 |
| [completed/preview-final-blockers.md](completed/preview-final-blockers.md) | **Preview 最终 blocker 修复**：Windows Codex .cmd / 中断后发送 / single-instance / full-access / 双 X / MiMo 等已收口 | 2026-06-03 |
| [completed/preview-build-readiness.md](completed/preview-build-readiness.md) | **预览包发布前收口**：已被正式 v0.55.x 发布流程取代 | 2026-06-04 |
| [completed/phase-7b-macos-native-visual-profile.md](completed/phase-7b-macos-native-visual-profile.md) | **Phase 7b macOS 平台视觉层**：Phase 0-2 + 7c 已落地；Phase 3-5 用户决定不做 | 2026-05-29 |
| [completed/post-refactor-cleanup.md](completed/post-refactor-cleanup.md) | **重构收尾后遗留清理**：Opus 4.8 接入 + Sonnet 4.6 别名 (#23) / Mac 通知链路确认 (#34) / pin 误报修复 (#27) / Plan 模式 Widget (#26) / Windows shell 默认 PowerShell (#28) / pre-commit enforce + 测试 flake 根治 (#30) / design.md 横切三节 (E)；13 React Compiler error 拆 #35；Preview 打包属独立下一阶段 | 2026-05-31 |
| [completed/phase-8-codex-mcp-context-injection.md](completed/phase-8-codex-mcp-context-injection.md) | **Phase 8 Codex MCP / Memory 注入**：`config.mcp_servers` 注入链路 + 5 项核心能力（Memory / Widget / Tasks+Notify / Dashboard / CLI）在 Codex Account 下真账号 smoke 通过 + 按能力区分的 elicitation 审批策略（read 自动 / write 弹审批）+ Codex 原生图片入库对齐素材库；Image/Media 与用户自定义 MCP 用户决定 defer | 2026-05-29 |
| [completed/phase-7-icon-system.md](completed/phase-7-icon-system.md) | **Phase 7 图标体系与表意校准**：CodePilot semantic icon layer（一概念一 glyph）+ HugeIcons 主库 + LobeHub 品牌图标保留 + Brain/Lightning/Terminal 冲突裁决 + eslint guardrail；96 文件迁到 CodePilotIcon | 2026-05-29 |
| [completed/phase-7c-card-primitive.md](completed/phase-7c-card-primitive.md) | **Phase 7c 浮动卡片 layout primitive**：CardFrame / CardSurface / ResizeGutter 三个单职责组件收敛四张浮动卡片的 shadow / clip-path / gutter 几何；sidebar 改 row-level card、AssistantPanel 接入、真实 DOM gutter 几何 e2e；验收证据见 [handover/macos-visual-profile.md](../handover/macos-visual-profile.md) Phase 7c 章节 | 2026-05-26 |
| [completed/phase-6-context-visualization.md](completed/phase-6-context-visualization.md) | Phase 6 上下文用量可视化：点阵式 Context Breakdown、来源分解、剩余上下文、三 Runtime context-accounting smoke；真实数据契约见 [context-accounting-runtime-contract.md](completed/context-accounting-runtime-contract.md) | 2026-05-20 |
| [completed/context-accounting-runtime-contract.md](completed/context-accounting-runtime-contract.md) | Context Accounting Runtime Contract：三 Runtime context_breakdown 持久化、ToolInvocation 抽象、真实 smoke evidence 与 Phase 6 数据源收口 | 2026-05-20 |
| [completed/phase-5-codex-runtime.md](completed/phase-5-codex-runtime.md) | Phase 5 Codex Runtime 接入：Codex app-server / Codex Account / Runtime adapter / approval + file events / provider proxy translator / OpenRouter + OAuth 收口 / installed_idle 状态文案 | 2026-05-19 |
| [completed/phase-5c-codex-tool-bridge.md](completed/phase-5c-codex-tool-bridge.md) | Phase 5c CodePilot Tool Bridge：Codex Runtime 下桥接 Memory / Tasks / Widget / Image / Media，unsupported 能力在 Settings 与工具结果中诚实降级 | 2026-05-18 |
| [completed/phase-5d-harness-capability-contract.md](completed/phase-5d-harness-capability-contract.md) | Phase 5d Harness Capability Contract：Capability registry / Context Compiler / Runtime adapter facade / Artifact contract / New Runtime Playbook | 2026-05-18 |
| [completed/phase-5d-phase-2-context-compiler.md](completed/phase-5d-phase-2-context-compiler.md) | Phase 5d Phase 2 Context Compiler：三 Runtime 统一上下文编译，Runtime 只 adapt 不 redefine | 2026-05-18 |
| [completed/phase-5d-phase-6-codex-account-harness.md](completed/phase-5d-phase-6-codex-account-harness.md) | Phase 5d Phase 6 Codex Account Harness 调研计划：已归入 Phase 5e 的 provider-aware Settings / 能力降级收口 | 2026-05-18 |
| [completed/phase-5e-runtime-harness-architecture.md](completed/phase-5e-runtime-harness-architecture.md) | Phase 5e Runtime Harness Architecture：Runtime / Provider / Harness 三层边界、三层 HarnessBundle、User/External scanner、Settings 能力清单、mutationLevel 权限分级、Native 基础盘补齐、Codex 不支持能力诚实降级、New Runtime Playbook 收口 | 2026-05-18 |
| [completed/phase-4-markdown-artifact.md](completed/phase-4-markdown-artifact.md) | refactor-closeout Phase 4 归档：Markdown 数据层（trust tier / quiet refresh / 编辑冲突）+ HTML 表现层（同源路由 / CSP 4 轮）+ Markdown 原地风格 + Artifact code-fence / dev-output 引用 | 2026-05-12 |
| [completed/refactor-phase-3-background-tasks-notifications.md](completed/refactor-phase-3-background-tasks-notifications.md) | refactor-closeout Phase 3 归档（菜单栏常驻 + 全局定时任务 + 本机通知 + Bridge 解耦 + 后台 Agent 任务 + 心跳后台化 + dev-server 内存收口） | 2026-05-10 |
| [completed/refactor-phase-2-runtime-session.md](completed/refactor-phase-2-runtime-session.md) | refactor-closeout Phase 2 归档（Runtime 与会话执行：session.runtime_pin + composer 切换面板 + 409 banner + transcript marker） | 2026-05-07 |
| [completed/refactor-phase-1-models-providers.md](completed/refactor-phase-1-models-providers.md) | refactor-closeout Phase 1 归档（默认模型契约 + 套餐型白名单 + OpenRouter search-and-add + 自定义模型入口） | 2026-05-06 |
| [completed/openrouter-search-and-add.md](completed/openrouter-search-and-add.md) | OpenRouter 取消全量目录物化 → 独立 search-models + validate-models 路由 + 「整理早期导入的目录」opt-in 入口；关闭 tech-debt #13 | 2026-05-06 |
| [completed/tooling-assistant-surface-cleanup.md](completed/tooling-assistant-surface-cleanup.md) | Phase 2D Skills / MCP / CLI 三入口收敛到 `/plugins`（2D.0 + 2D.1 + 2D.2 + 2D.4 完成；2D.3 推迟、2D.5 独立） | 2026-05-01 |
| [completed/markdown-artifact-overhaul.md](completed/markdown-artifact-overhaul.md) | Markdown 渲染/编辑 × Artifact 网页预览扩展 | 2026-04-21 |
| [completed/composer-refactor.md](completed/composer-refactor.md) | Composer 重构 + 单聊天权限 + 远程桥接联动 | 2026-04-29 |
| [completed/context-chips-phase-1.md](completed/context-chips-phase-1.md) | Chat composer 显式上下文 chips Phase 1 | 2026-04-29 |
| [completed/workspace-sidebar-tabs.md](completed/workspace-sidebar-tabs.md) | Workspace Sidebar Tabs（Git / Widget 固定 + Markdown / Artifact / 文件预览动态） | 2026-04-30 |
| [completed/runtime-auto-and-onboarding.md](completed/runtime-auto-and-onboarding.md) | Runtime auto 简化 + 错误归一翻译 + 入口拦截 + 百炼 catalog 替换 | 2026-04-15（已发布 v0.50.x） |
| [completed/cc-switch-credential-bridge.md](completed/cc-switch-credential-bridge.md) | cc-switch 凭据桥接（per-request shadow `~/.claude/`） | 2026-04-15（已发布 v0.50.2） |
| [completed/electron-port-stability.md](completed/electron-port-stability.md) | Electron 端口稳定化（修主题 / 默认模型 / dismiss 状态重启失效） | 2026-04-15（已发布 v0.50.2） |
| [completed/decouple-claude-code.md](completed/decouple-claude-code.md) | 脱离 Claude Code 依赖 — 自建 Agent Runtime（Provider/Loop/Tools/MCP/Permission/Session/Skills/SubAgent） | 2026-04-07（Phase 0-7 + 4 闭环 + Phase 8 ✅） |
| [completed/decouple-test-plan.md](completed/decouple-test-plan.md) | 脱离 Claude Code 功能测试方案（配套 decouple-claude-code） | 2026-04-07 |
| [completed/provider-governance.md](completed/provider-governance.md) | 服务商系统治理（Preset 声明式 + Schema 校验 + 连通性验证 + meta 引导 + 错误恢复 + 模型目录动态化） | 2026-04 |
| [completed/provider-resolver-refactor.md](completed/provider-resolver-refactor.md) | Provider Resolver 统一（Phase 1-5 完成） | 2026-03 |
| [completed/v0.48-post-release-issues.md](completed/v0.48-post-release-issues.md) | v0.48.0/0.48.1 发版后问题追查（已归档至 issue-tracker.md） | 2026-04 |
| [completed/open-issues-2026-03-12.md](completed/open-issues-2026-03-12.md) | 早期 GitHub Issues triage 快照（已合并至 issue-tracker.md） | 2026-04 |
| [completed/hermes-inspired-runtime-upgrade.md](completed/hermes-inspired-runtime-upgrade.md) | Hermes 借鉴的 Runtime 能力升级（6 核心 + 12 额外） | 2026-04-12 |
| [completed/engineering-quality-assurance.md](completed/engineering-quality-assurance.md) | 工程质量保障体系（Harness Engineering） | 2026-03-04 |
| [completed/skills-mcp-tooling-fix.md](completed/skills-mcp-tooling-fix.md) | Skills / MCP / Tooling 修复 | 早期 |
| [completed/cli-upgrade-proxy.md](completed/cli-upgrade-proxy.md) | CLI 升级代理 | 早期 |
| [completed/assistant-workspace.md](completed/assistant-workspace.md) | 助理工作区 | 早期 |
