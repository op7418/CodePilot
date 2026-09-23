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

当前新增：[TokenDance 接入](active/tokendance-integration.md)（已随 v0.67.15 Shipped；正式 CI、20 资产与包内接口/图标复核通过，真实生成与 packaged 授权 smoke 待执行）。

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
| [memory-runtime-decoupling.md](active/memory-runtime-decoupling.md) | Runtime 无关记忆核心/来源更正遗忘/成功回合生命周期；辅助凭据与遥测治理，用户授权全部问题修复 | Shipped v0.67.17；第三轮 Review passed，5704 pass / 1 skip、隔离UI、正式CI与公开20资产审计通过；真账号 smoke / Sentry发布后观察待验 |
| [active/gemini-native-ai-studio.md](active/gemini-native-ai-studio.md) | AI Studio Gemini 3.8 Flash Native 接入、历史状态/思考参数/截断提示与 AI SDK 能力审计 | Shipped v0.67.17（含数字枚举修复）；SDK执行校验、正式CI与公开20资产审计通过，full 5704 pass / 1 skip，真实Gemini问候通过；完整工具执行与Windows会话smoke待执行 |
| [active/astra-openai-oauth-compatibility.md](active/astra-openai-oauth-compatibility.md) | **Astra / OpenAI OAuth / Fable 5.1 兼容修复**：刷新并发、非阻塞目录、恢复提示、冷缓存能力与 Fable 协议 | 🟡 Code complete + Tests pass：5518 pass / 1 skip、后续旧聊天 E2E 2 pass；真实账号 smoke 待验证 |
| [active/cli-maintenance-and-release-notes-rendering-2026-08-28.md](active/cli-maintenance-and-release-notes-rendering-2026-08-28.md) | **CLI 更新提醒、一键升级与 Release Notes 安全渲染**：按 selected binary/package-root 证明 Claude/Codex 安装渠道，same-channel latest、Windows shim/WinGet/standalone 更新、provider maintenance lease、app-update/quit lifecycle latch 与 post-version 验证；GitHub Atom HTML 经 strict sanitize 渲染 | 🟡 Review accepted，已随 `v0.67.11` Shipped；正式 package/资产门禁通过，真实 UpdateDialog、CLI before→after 与 Windows clean VM smoke 待执行 |
| [active/post-sentry-scan-remediation-2026-08-27.md](active/post-sentry-scan-remediation-2026-08-27.md) | **2026-08-27 Sentry 生产问题修复闭环**：原 updater/utility/token/DB/media 修复；09-07 增补 collector 异常所有权、保存失败双语提示与快捷建议冷却 | Shipped v0.67.16；最终 full 5584 pass / 1 skip、UI 5/5；初始 DB 空读、Windows EOF 与生产停增验证仍开放 |
| [active/windows-unsigned-native-auto-update-2026-08-26.md](active/windows-unsigned-native-auto-update-2026-08-26.md) | **Windows 无签名原生自动更新与差分下载**：不申请 Microsoft/Azure/PFX 签名，固定 GitHub 单一信任根；stable 发布 `latest.yml` + NSIS blockmap，Linux 保持手动 | ✅ `v0.67.10` bootstrap 与 `v0.67.11` 后继 stable 均已 Shipped；20 资产 Latest immutable Release、Mac/Windows metadata、blockmap/checksum/provenance 已复核；Windows 真实差分/完整回退 smoke 待执行 |
| [active/composer-model-route-permission-consolidation.md](active/composer-model-route-permission-consolidation.md) | **Composer 模型路线、能力参数与权限入口收口**：Favorites 精确组合 + Runtime 左栏、Provider 分组模型右栏、能力描述符、上下文/Send 末端布局与权限档位双向映射 | 🟡 本轮 UI/定向 unit/scoped E2E 通过；三 Runtime 真实 effective-wire smoke 待执行（Tier 2） |
| [active/runtime-thread-ownership-and-handoff.md](active/runtime-thread-ownership-and-handoff.md) | **Runtime 会话所有权、交接与成本可见性（P0/P1）**：首次执行锁定 Runtime；完整路线原子写入；同 Runtime 在原聊天跨服务商换模型并承接历史；目录校验对齐执行层；普通 Picker 不创建或跳转聊天 | 🟡 9 月 5 日两项 P2 续接修复 Tests pass：5485 pass / 1 skip、E2E 3/3；已有原聊天切换 Dev smoke；真实视觉 smoke、独立复审与原计划其他长历史 smoke 待跑 |
| [active/workspace-surface-sidebar-pin-and-inspector.md](active/workspace-surface-sidebar-pin-and-inspector.md) | **Workspace Surface Sidebar**：Files/Git/Browser 等模块统一注册、项目级 pin、瞬时“+”与 tab own close、Primary + Inspector 双 lane、`canonicalWorkspaceKey` 与 v13 可逆迁移 | 🟡 Add/Pin/Unpin/own-close/reload scoped E2E 通过；Diff/Artifact → Inspector 人工验收仍待执行 |
| [active/browser-webcontentsview-poc.md](active/browser-webcontentsview-poc.md) | **Browser WebContentsView 技术 POC**：验证三平台 bounds/IME/overlay/shortcut/zoom/crash/session/permission/download；只交付 Smoke Ledger、风险矩阵与 go/no-go，不合入产品代码 | 🧭 BLOCKED / INCONCLUSIVE，已被 `<webview>` MVP 路线取代；Windows/Linux 未跑，不伪造 GO |
| [active/browser-surface-mvp.md](active/browser-surface-mvp.md) | **Browser Surface MVP**：hardened `<webview>`、Main attach gate、workspace partition、tabs/navigation/permission/download policy 与统一 Surface 接入 | 🟡 Code complete / macOS dev smoke passed；packaged、Windows/Linux、下载与 tab 恢复待执行 |
| [active/v0.67.1-production-feedback-signing-auto-update-2026-08-23.md](active/v0.67.1-production-feedback-signing-auto-update-2026-08-23.md) | **v0.67.1 生产反馈闭环 × macOS 签名与自动更新（Windows/Linux 手动分发）**：GLM legacy identity、Sentry/SQLite/ABI、macOS 身份门禁、原子 update assets 与 Main-owned updater | ✅ `v0.67.7` mixed distribution 已 Shipped：正式 run 全绿、18 资产 Latest Release、Mac `latest-mac.yml` 唯一指向 universal ZIP；Windows/Linux 保持手动包。完整三模型请求与跨版本 smoke 不冒充通过 |
| [active/macos-safe-storage-signing-remediation-2026-08-12.md](active/macos-safe-storage-signing-remediation-2026-08-12.md) | **macOS Safe Storage 反复授权修复**：正式/preview 包改为 Developer ID + 精确 Team ID fail-closed；v0.67.7 不可读 Provider secret 热修阻断 ambient OAuth 串线并提供删除旧服务商、同 Key 重加的恢复入口 | ✅ v0.67.7 Shipped：Code complete + Tests pass + Build pass + official CI pass；用户已用同一真实 GLM Key 验证删除重加恢复，完整三模型 smoke 作为已接受发版风险保留 |
| [active/production-observation-remediation-2026-08-07.md](active/production-observation-remediation-2026-08-07.md) | **0.65 生产观察修复闭环**：补 Sentry IP/Geo null tombstone、Electron 启动 session、Windows 外链 Promise 失败反馈，以及 Native 残缺 tool-call 历史的诚实配对修复 | 🔄 Phase 0 完成，Phase 1–4 实施中；新 stable packaged/Sentry cohort 待发布后验收 |
| [active/windows-review-remediation-2026-08-07.md](active/windows-review-remediation-2026-08-07.md) | **Windows 适配独立审查修复闭环**：修复 Provider secret 迁移启动阻断、无 `rg` 正则回退卡死、macOS `//`/`/mnt` 路径误判与非 Windows PowerShell 恢复文案；P2 逐项修复或登记 | 🟡 Code complete + Tests pass + Review passed；Windows packaged smoke 待执行 |
| [active/harness-home-user-owned-core.md](active/harness-home-user-owned-core.md) | **Harness Home Umbrella**：用户所有的 Assistant files/services、跨 Runtime Capability Packages 与 Assets；普通文件始终可读，助理自动服务显式激活，能力通过 Broker 相互调用，不再建设独立审美/workflow 系统 | 🔄 Program A/B foundation 与默认助理切片已落地；当前 Program C 按用户纠正重写，待 Claude 审查 |
| [active/default-assistant-heartbeat-system-notification.md](active/default-assistant-heartbeat-system-notification.md) | **P0 默认助理 → 心跳 → 系统通知纵向闭环**：新用户默认用户自有助理目录、老路径 no-touch、零会话侧栏入口、heartbeat desired/actual 自愈、全 priority Main-owned durable native notification、交互任务完成/审批提醒与点击回会话 | 🟡 P0.5 Review accepted，已随 `v0.67.11` Shipped；三平台 packaged native show/sound/click smoke 待完成 |
| [active/harness-home-core-adapters.md](active/harness-home-core-adapters.md) | **Program A — Harness Core / Repository / Adapter Kits**：file-backed canonical repository、单写者/事务写/外部编辑对账、SecretStore、L0/L1 HarnessAdapter conformance、L2/L3 RuntimeAdapter 与 CodePilot Full Reference | 🟡 A1–A4 code/tests + recursive neutrality/repository hardening 完成；真实凭据 Tier 2 smoke 待最终验收 |
| [active/harness-home-asset-library.md](active/harness-home-asset-library.md) | **Program B — Producer-backed Asset Library**：复用 Gallery/media pipeline，按真实 producer 注册 kind，完成 backfill、lineage、typed reference、HTML bundle materialization 与 trust/CSP；无 producer 的 component/document 不进首版 schema/UI | 🟡 B0–B3、Codex media 去重、真实本地 Browser smoke 与 review hardening 完成；packaged/human UI gate 待最终验收 |
| [active/harness-home-context-capability-routing.md](active/harness-home-context-capability-routing.md) | **Program C — Assistant 服务激活与统一能力包**：窄 assistant binding 只门控 Memory 自动服务/Heartbeat，不限制目录文件；Skill/MCP/CLI/builtin/renderer/model adapter 归入一个 Capability Package，通过 Broker 相互调用；`creative` 验证可视化效果、policy 与图像/视频模型扩展，推荐页后移 | 📋 按用户纠正与竞品调研重写完成，待 Claude Code 审查；P0 服务激活 → P1 Package/Broker → P2 creative |
| [active/same-runtime-multi-model-subagents.md](active/same-runtime-multi-model-subagents.md) | **同 Runtime 多模型 Sub-agent MVP**：当前会话模型保持父 Agent；三 Runtime exact Provider+Model child；logical run/attempt、settling、结构化结果与 lifecycle 详情 | ✅ 三 Runtime managed 依赖链 code/tests/smoke 完成；identity-bearing native collab、entitlement cache、individual cancel 与可靠性长尾待续 |
| [active/qwen-token-plan-and-grok-access.md](active/qwen-token-plan-and-grok-access.md) | **千问 Token Plan 与 Grok 4.6 / Grok Build 接入**：三类千问套餐保持稳定 identity；xAI API Key 以 `grok-4.6` 为当前默认、`grok-4.5` 为 legacy，订阅渠道按 Grok Build browser/device OAuth 合同接入；Phase 7 为 X Search，Phase 8 跟踪账号模型目录与 Imagine 图像/视频工具 | 🟡 第三轮 Review passed（附条件）+ Tests/production build/通用 Smoke pass；XHigh/SDK 错配、动态 redirect、媒体路由/失败语义、实际挂载提示、四入口取消与完成资产保留已闭环。全量已知 telemetry flake 见 tech-debt #86；authenticated `/v1/models` 与真实 4.6/Imagine entitlement smoke 仍待完成 |
| [active/markdown-live-preview-and-file-tree.md](active/markdown-live-preview-and-file-tree.md) | **Markdown Live Preview 统一样式 × 文件树 Explorer 化 × 文件类型图标**：CodeMirror 单页 Live Preview、跨 owner mutation transaction、Explorer 右键/F2/Trash、material-icon-theme 静态 FileTypeIcon 已实现；macOS packaged Trash 可恢复；用户已验收中文 IME、暗色选中态、深色主题及原生磨砂，整窗材质按反馈从 `menu` 调轻为 `under-window` | ✅ v0.62.0 已发布，Mac/Windows CI 打包与 packaged server 门禁通过；仅保留用户的 Windows 发布后实机验证待办 |
| [active/codebase-health-audit-2026-06.md](active/codebase-health-audit-2026-06.md) | **代码健康审计与修复计划（2026-06）**：6 路并行审计（流式核心 / Codex / DB+API / 前端 / Electron+构建 / 测试覆盖）产出 bug、性能、安全加固、测试补洞四个 Phase；关键发现已现场核验并逐条标注核验状态与验证分层；v2 已按 Codex 静态审查订正 7 处事实偏差与执行边界 | 🔄 Phase A 已完成（A1–A6），B/C/D 待实施（Codex 负责审查/用例设计） |
| [active/codex-cli-discovery-refresh.md](active/codex-cli-discovery-refresh.md) | **Codex CLI 发现与刷新修复**：适配当前 `ChatGPT.app` 内置 CLI，保留旧 `Codex.app`，修复进程级路径缓存与设置页假刷新，并让实际 selected binary/version 与登录失败可见 | 🟡 production UI、签名 arm64 `.app`/DMG/ZIP 与 packaged Codex status smoke 已完成；仅真实双安装终验待完成 |
| [completed/windows-runtime-path-compatibility.md](completed/windows-runtime-path-compatibility.md) | **Windows Runtime / 路径兼容性收口**：修复中文/空格/合法特殊字符工作目录、原生 Shell 与搜索回退、Bridge/后台任务 CWD 分叉、Codex 桌面包误判及 Windows 开发脚本 | ✅ 已完成（真实计费会话未执行） |
| [active/windows-codex-loopback-proxy.md](active/windows-codex-loopback-proxy.md) | **Windows Codex Loopback Proxy 502 修复**：保留外网 system proxy，同时在 Electron server 与 Codex app-server 两道 child env 强制 loopback bypass，修正 Windows proxy key 优先级并增加专用 502 诊断 | 🟡 Code complete + Tests pass；真实 Windows + Clash packaged smoke 待跑 |
| [active/v0.56.x-stability-trust.md](active/v0.56.x-stability-trust.md) | **v0.56.x Stability / Trust 总计划**：从 Notion GPT Pro 产品审查、当前 GitHub Issues / PR 治理状态、用户最新体验反馈汇总出的稳定性 umbrella plan；先收 codebase-health Phase A，再治理 session/context/stream/composer、文件引用安全、安装更新、CI 与 GitHub triage | 🚧 Phase 0/1 ✅ 已完成；Phase 2 进行中（Composer/Context 主链路 #1–#5 闭环；#629 已关闭 🟢、#635 代码层完成 🟡（待真实 smoke）、#632 假% 已修 item3 待续；stream 终态原因码 / 压缩回滚 / 诊断字段待续）；Phase 3 主问题 #628 已关闭 🟢；Phase 7 已细化为 GitHub 旧 issue 清库存 + 保守机器人治理批次，待 Claude Code 执行；Codex 持续核验 |
| [active/codex-stop-recovery.md](active/codex-stop-recovery.md) | **Codex Stop Recovery / 终止后恢复发送**：调研并修复 Codex Runtime 下 Stop 只切断前端 stream、未必调用 Codex app-server `turn/interrupt`，导致后台 collect / session lock / runtime status 未收口，下一条同会话指令无法拉起的问题；外部 Codex issues 只作症状旁证，不采信其根因推测 | 📋 待 Claude Code 接手修复 |
| [active/development-harness-optimization.md](active/development-harness-optimization.md) | **开发流程 Harness 优化（v2 + 2026-06-28 对账）**：Codex 初稿 + ClaudeCode 按用户"可审核"约束重组。方向上 Skill 化暂缓、主推自动检查脚本（docs drift / hook 配置）+ guardrails 八类必读 + Smoke Ledger 模板 + 测试矩阵补洞；2026-06-28 新增 Step 0 规则体系瘦身（顶层规则分工 / Ruler-compatible / 测试分层 / 简化汇报协议），并对账校准各 Step 真实状态；每个 Step 以"用户能看到什么 / 不做什么 / 怎么验收"开头 | 🔄 进行中（2026-06-28 对账 + Step 0/5 落地 + Step 6 核实）：Step 0-3 ✅、Step 4 🔄 部分（on-touch）、Step 5 ✅、Step 6 ✅（核实已覆盖）；仅剩 Step 4 持续填充 |
| [active/documentation-authority-lifecycle-reset.md](active/documentation-authority-lifecycle-reset.md) | **文档可信度与生命周期收口**：解决历史细文档被 Agent 当成当前事实的问题；建立 current/reference/historical 三层权威，先试点压缩 handover 与应急文档，再补历史降权、事件驱动复核和审查基线合同 | 📋 待启动（Phase 0 清单与风险分级） |
| [active/model-capability-reasoning-refresh.md](active/model-capability-reasoning-refresh.md) | **模型目录与推理强度统一适配**：GLM、Kimi、GPT-5.6、Claude Sonnet 5 / Opus 5、DeepSeek、Grok 与聚合边界；按模型、SDK 与网关真实 wire capability 驱动强度选择 | 🟡 2026-08-26 已增量适配 GLM-5.3-Flash（1M/vision/双 Runtime wire）；B-031 仍保持打开，受影响用户升级与真实 GLM 凭据 smoke 未完成 |
| [active/runtime-permission-modes.md](active/runtime-permission-modes.md) | **跨 Runtime 权限模式**：在“按规则询问 / 完全访问”之间加入真正的“替我审批”；Claude/Codex 接上游 auto reviewer，Native AI SDK 先做 fail-closed POC，不把 tool approval 或 bypass 冒充代审 | 🚧 Claude/Codex code + contract tests 已闭合；Codex 已有 Runtime 分流、版本门与响应回显，真实 approve/deny/MCP smoke 仍待完成 |
| [active/automatic-chat-titles.md](active/automatic-chat-titles.md) | **自动会话命名**：先统一两套首消息截断与 UI 刷新，再以同 session provider 后台生成语义标题；provenance/CAS 保证手动、系统、导入标题不被覆盖 | ✅ Phase 0–2 code/tests 完成，真实凭据 smoke 待跑；Codex 仅有 name/set 写入原语，无内置 auto-title API，首版 fallback |
| [active/issue-tracker.md](active/issue-tracker.md) | **统一问题跟踪**：所有 Bug / Feature Request / Sentry 监控的活动看板 | 持续维护 |
| [active/sentry-telemetry-reliability.md](active/sentry-telemetry-reliability.md) | **Sentry 遥测可信度与错误分诊**：隔离官方 stable、development 与 Fork，统一 Browser/Next/Electron 初始化和匿名 opt-out，建立脱敏 allow-list、Outcome 分类、默认 stack / normalized fingerprint 双轨分组与三层 source-map 发布闭环；先阻断安装包携带 map，SDK 升级独立可回滚，真实产品缺陷在 72h 干净数据后分拆移交 | 🚧 v0.64.0 / v0.65.0 已正式发布，Phase 6 进行中；source map/native/package 已实证，4xx/DNS/NoOutput/in-band 与 ToolLoop rejected-promise review findings 已 code complete 且本地 gates 通过；只读 credential 已验证，待新 stable 真实 smoke 与单 release cohort 复核 |
| [active/codex-model-refresh-utility-process-oom-recovery.md](active/codex-model-refresh-utility-process-oom-recovery.md) | **Codex 模型刷新异常 × Utility Process OOM 恢复**：用户日志确认 Next utility child 四次 V8 `Zone Allocation failed` / exit 5；区分上游 model refresh timeout、transport frame/持久化状态与 packaged V8 条件，并补独立错误面、warmup 熔断、single-owner 与有限自愈 | 🟡 Code complete / Tests pass / Review passed / Crash smoke passed（本地范围，2026-08-11，未启动 loop）：ad-hoc arm64 `.app` 的单次恢复、三次 restart budget 与 live-Codex blocked/quit-only 均通过；根因归 F（本地未复现），active-turn UI 与 15/60 分钟 soak 待跑 |
| [active/log-bloat-codex-runtime-crash.md](active/log-bloat-codex-runtime-crash.md) | **日志暴涨与 Codex Runtime 闪退调研**：确认 12.5G 主日志不正常，主因是 Codex app-server INFO tracing 洪水、无 size-based rotation、主进程 `serverErrors` 无界累积；该 logging 链路已做 rotation/ring/降噪和 crash breadcrumb，本次 utility OOM 另立计划 | 🟡 P0+P1 代码与单测完成；真实 Codex approval/network smoke 待跑 |
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
| [superseded/harness-home-design-method.md](superseded/harness-home-design-method.md) | CodePilot Design Method / Taste Memory / Creative Orchestration 独立产品化；foundation 已落地，剩余 Method v0/golden/human-gate 不再推进 | [active/harness-home-context-capability-routing.md](active/harness-home-context-capability-routing.md) P2：`creative` Capability Package + media model layer |

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
| [completed/issue-685-route-identity.md](completed/issue-685-route-identity.md) | #685：保持已选路由、同 Provider 唯一 upstream 兼容；targeted 27/27，发版 full 5584 pass / 1 skip；Shipped v0.67.16、Windows 会话真机待验 | 2026-09-14 |
| [completed/site-visual-refresh-2026-09-04.md](completed/site-visual-refresh-2026-09-04.md) | 官网与 README 视觉更新；Phase 8 恢复完整中英文 Dev 截图（接受系统标记）、两层连续贝塞尔圆角；typecheck/lint/UI smoke 通过，未部署 | 2026-09-05 |
| [completed/windows-runtime-recovery-hardening.md](completed/windows-runtime-recovery-hardening.md) | **Windows Runtime 诊断、恢复与凭据加固**：统一 Path Identity 与三 Runtime Doctor，展示 Codex sandbox 真实阶段；desktop_only 恢复入口经 Windows DEV 用户验收；Provider key 从明文 SQLite 迁到 safeStorage 保护的版本化密文；跨机真实凭据与 standalone sandbox 矩阵保留为复查清单 | 2026-08-07 |
| [completed/codex-thread-storage-isolation.md](completed/codex-thread-storage-isolation.md) | **Codex 会话存储隔离**：CodePilot-owned `CODEX_HOME` / SQLite、只迁移 `codex_codepilot` 历史、Harness live mirror 与凭据降级模式可观察；真实 app-server resume/索引 smoke 通过 | 2026-08-03 |
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
