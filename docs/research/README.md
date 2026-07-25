# Research / 调研文档

技术方案调研、可行性分析、POC 验证记录。

**AI 须知：修改或新增文件后更新下方索引；检索本目录前先读此文件。**

## 索引

| 文件 | 主题 |
|------|------|
| qwen-token-plan-grok-oauth-2026-07-21.md | **千问 Token Plan 与 Grok OAuth 接入调研**：确认 Coding Plan 未被简单改名，个人/团队 Token Plan 共用 URL 却有不同精确目录，需持久化 preset identity；拆清 Grok Build、xAI API Key 与 OpenCode SuperGrok OAuth，并按用户裁决同时规划 API Key + Responses 与参考 OpenCode 的 browser/device OAuth，公开 client 兼容风险由 API Key 兜底 |
| multi-agent-loop-review-process-audit-2026-07-20.md | **loop review 过程独立审计（Claude）**：基于连续六次实现/复审运行的裁决原文与 57 commit 流所作的机制层补充——6 分钟审查轮排除 layer 4/5、deferral 无载体致「待 smoke」蒸发、账本对账吃掉双位数预算、「机械轮」蚕食人类闸门、required checks 出自共享计划、范围缩减散文化洗白（reward hacking 定性 + 5 处实证）、僵尸运行记录；给出映射复盘门禁 A–E 的 7 条可执行补丁 |
| multi-agent-loop-acceptance-failure-2026-07-19.md | **多 Agent loop 验收失效复盘**：53 个提交仍未通过用户路径的根因；定位共享错误计划、低层级 required checks、待 smoke 被误报完成、父任务无总门与延期未回问；给出 U1–U8 不可变验收矩阵和证据阶梯 |
| sentry-post-refactor-audit-2026-07-05.md | **Sentry 重构后有效性审计 + 后台新问题**:检测整体仍生效;已核实盲区=`reportNativeError` 对 `EMPTY_RESPONSE`/`TIMEOUT_*` 是 no-op(`error-classifier.ts` 集合未含);后台新问题 `AI_MissingToolResultsError` 佐证 audit #49 吞 tool-error。标注了已核实/待 Codex 复核 |
| competitor-runtime-security-solutions-2026-07-04.md | **竞品对 CodePilot 其他问题的更优解法**(OpenCode/Codex/CraftAgent 最新版):覆盖 stop/abort+turn 所有权、排队消息、新会话导航、工具错误、密钥加密、Electron 安全、崩溃恢复、能力建模。横向根因=会话级状态放进了会重挂载的组件本地;三家都上提到会话级 store/后端真相。CraftAgent 多数同栈可整段搬。承接 audit 文档非滚动/性能部分 |
| competitor-chat-scroll-perf-2026-07-04.md | **竞品聊天滚动/流式性能对照**(OpenCode/Codex/CraftAgent 最新版):三家均不用朴素全量渲染、均把 token 到达与渲染解耦、初次进会话均瞬时定位。提炼可迁移结论:优先 `@tanstack/react-virtual`(与 OpenCode 共享 virtual-core)、Worker 卸载 shiki 高亮(OpenCode 零 Solid 依赖可近乎逐字复制)、300ms/24ms 流式节流、初始滚动改瞬时。支撑 audit 文档 §4.2/§4.3 |
| stability-fluency-runtime-audit-2026-07-04.md | **稳定性/流畅性/Runtime 全面审计**(基于 v0.57.0)：三轮方法(文档梳理→逐条代码核实→未覆盖区代码审计)。新发现 高1/中8/低8(含 `artifact:export-long-shot` 任意路径写盘高危、registry 无 ownership 门致回合竞态、autoTrigger 无续租上限、首轮切会话导航劫持、排队消息丢失、非文本 emit 无节流等);修正 3 条 tracker 滞后条目(#23/#21/#22/#43-item3);每条附文件:行号 + 修复思路 + 动手顺序 |
| harness-and-ux-refactor.md | **[事实输入归档]** 排期已收束至 `exec-plans/superseded/agent-trust-ownership-refactor.md`;本文仅保留事实速览(Harness 各层、记忆 V3、Hermes 进度)+ Google design.md 调研 + 讨论日志,作为新计划 Phase 0-4 输入 |
| chat-latency-investigation-2026-03-20.md | 聊天响应变慢问题排查报告（用户设置 / MCP / resume 链路） |
| chat-sdk-integration-feasibility.md | Vercel Chat SDK 集成可行性调研 |
| context-storage-migration-plan.md | 上下文共享与存储迁移设计（详细方案；执行跟踪见 `docs/exec-plans/superseded/context-storage-migration.md`） |
| mobile-remote-control-overall-plan.md | 移动端远程控制整体方案（Host / Controller / Lease / 多设备控制） |
| weixin-openclaw-plugin-review-2026-03-22.md | OpenClaw 微信插件拆包与 CodePilot 逆向集成可行性调研 |
| chat-latency-remediation-review-2026-03-22.md | Chat Latency 修复 Code Review（effort 收敛、MCP 持久化开关、resume 首 token 优化） |
| mcp-tooling-agent-sdk-review-2026-03-10.md | MCP 工具 + Agent SDK 集成调研 |
| skills-agent-sdk-review-2026-03-10.md | Skills + Agent SDK 集成调研 |
| issue-analysis-2026-04-02.md | GitHub Issues #356-#417 分类分析：第三方 Provider CLI 崩溃、配置持久化丢失、Windows 兼容性 |
| packaged-preview-runtime-diagnosis-2026-05-31.md | **预览包运行时启动诊断**：三症状（Codex「应用服务启动失败」/「准备运行环境」/Settings 卡几十秒）统一根因 = Codex app-server 失败时 CodePilot 等满 30s RPC 超时。**2026-06-01 POC 实测修正**：xhigh 配置不是真因——失败的是旧 `/opt/homebrew/bin/codex`（已卸载），当前 `.app 0.133.0` 接受 xhigh，端到端实测可出 6 模型。修复转向 P0 快速失败（init 期退出立即 reject）+ P1 clamp 外发 effort；否决 spawn `-c` 覆盖。关联 preview-build-readiness Phase 1 |
| tool-call-thinking-display.md | 工具调用思考过程展示实现方案（数据链路、组件改动、设计决策） |
| tool-call-ux-competitive-analysis.md | 工具调用 UX 竞品调研：Claude Code / CraftAgent / Opencode / Codex 的展示与交互设计对比 |
| agent-loop-self-built.md | 脱离 Claude Code：自建 Agent Loop 替代 SDK — Vercel AI SDK streamText 方案 |
| mcp-system-decoupling.md | 脱离 Claude Code：MCP 系统独立化 — 连接管理 + 内置 Server 迁移 |
| cli-tools-implementation.md | 脱离 Claude Code：8 个核心工具自建方案 — Schema/实现/复杂度评估 |
| skills-system-independent.md | 脱离 Claude Code：Skills 系统独立化 — 解析/发现/执行 |
| permission-system-decoupling.md | 脱离 Claude Code：权限系统独立化 — 三级模式 + 规则引擎 + bash 验证 |
| session-management-and-context-compaction.md | 脱离 Claude Code：会话管理 + 三层上下文压缩方案 |
| sub-agent-system.md | 脱离 Claude Code：子 Agent 系统 — AgentTool + Runner 设计 |
| pi-framework-analysis.md | Pi AI 框架调研 — 多 Provider 抽象（17+ Provider + OAuth）、Agent Loop、Extension 系统 |
| hermes-agent-analysis.md | Hermes Agent 分析 — 三段式对比（外部事实 / 本仓库 file:line / 推断）：并行安全调度、辅助 provider + sdkProxyOnly fallback、渐进式子目录 hint、session 搜索等借鉴路线图 |
| provider-registry-comparison.md | Provider 注册表对比 — Hermes 三层合并（models.dev + overlay + user）vs CodePilot 硬编码 VENDOR_PRESETS，改进路线图 |
| provider-model-discovery.md | Provider 模型发现 spike — 三类划分（可 API 获取 / 实验性 / 不可获取需手动）、`src/lib/model-discovery.ts` + `POST /api/providers/[id]/discover-models` 只读路由、安全约束（无写入 / 无回显 key / 必带 timeout） |
| feishu-cli-one-click-bot.md | 飞书 CLI 一键创建机器人逆向调研 — App Registration Device Flow API、PersonalAgent 模板 POC 已通过（全链路验证：凭据→WSClient→消息接收）、集成方案设计 |
| markdown-editor-tiptap-evaluation.md | Markdown 渲染/编辑体系调研 — Tiptap 不推荐作主栈（ProseMirror 无虚拟化、往返有损）；长文档卡死根因指向 `MessageResponse` 整串重渲；编辑器推荐 CodeMirror 6 |
| artifact-preview-ai-elements.md | Artifact 预览组件调研 — 确认 Vercel AI Elements 身份（shadcn registry），现有 `artifact.tsx` 仅 UI 壳未接入；建议加 `web-preview`/`jsx-preview` 并扩 `PreviewPanel` 支持 inline 内容与 JSX |
| craft-agents-docs-system-review.md | Craft Agents 文档体系对标调研 — craft 外部入口文档（Issue 模板 / CONTRIBUTING / 嵌入式架构树）更完整；CodePilot 内部研发文档链（exec-plans / research / handover-insights 互链）显著更强；P0 借鉴清单：YAML Issue 模板 + PR 模板 + CONTRIBUTING + SECURITY |
| craft-agents-markdown-internals.md | Craft Agents 内部 Markdown 实现调研 — 渲染走 react-markdown + unified + Shiki LRU；Tiptap 仅用于编辑器；**代码块 language 拦截 = 10 个 MarkdownXxxBlock 轻量 Artifact**（Mermaid/Diff/JSON/Datatable/HTML/PDF/Image）；`id + children` 双键 memo 可修复 CodePilot 长文档重渲；修订了 Tiptap 评估与 AI Elements Artifact 路径 |
| review-packet-opus-4-7-and-sdk-0-2-111.md | **Codex 审查包**：Opus 4.7 升级 + Agent SDK 0.2.111 采纳本轮迭代的范围、commit 分组、关键架构决策、已知 out-of-scope、测试状态、希望重点审的 7 个点 |
| codex-sdk-app-server-coverage.md | Codex 集成路径调研 — app-server (当前实现) vs `@openai/codex-sdk` 能力对照；结论：本轮不引入 SDK，原生 plugins/skills 在 CodePilot UI 不渲染是双层缺口（事件映射 + UI 分支）非 SDK 单独能填；Settings 用户层 copy 已诚实标注 |
| phase-6-context-breakdown-data-audit.md | Phase 6 上下文用量可视化 Phase 0 数据审计 — 10 类 `ContextBreakdownKind` 的源码出口映射（system_prompt / tools / rules / skills / mcp / memory / files_attachments / conversation / pending_next_turn / cache_or_previous）；`useContextUsage` / `walkContextUsage` / `context-estimator` / `harness-bundle` 接口快照；StreamSession guardrail 合规检查 |
| codex-mcp-injection-poc/ | **[Phase 8 / Phase 0 POC — 已 live 验证]** Codex 原生 per-thread `config.mcp_servers` 注入在真实 `0.133.0` app-server（隔离 CODEX_HOME）跑通：注入被接受、stdio fixture 即时启动、`mcpServer/tool/call` 命中、错误/elicitation 往返/broken-server 失败均被暴露；唯一 auth-gated = 模型自主调用。纠正文档两处假设（per-thread server 不进 `mcpServerStatus/list`，状态走 `startupStatus/updated` 通知） |
| codex-image-input-poc/ | **[#632 / Phase 2 #3 POC — 图片输入格式已确证]** Codex app-server `turn/start` 接受的图片块 wire format。隔离 CODEX_HOME 经 serde 校验错误探出（无需 model auth）：合法 input 变体 = `text`/`image`/`localImage`/`skill`/`mention`；图片两种写法 **`{type:'image',url:<dataUrl 或 https>,detail?}`** 或 **`{type:'localImage',path}`**（`image_url`/`input_image`/`local_image` 均被拒）。image 块被回显进 userMessage 内容并随即发起模型请求（401 仅因隔离 home 无 auth，非格式问题）。下一步（单独）：改 `codex/runtime.ts` 拼图片块 + 更新 `CodexTurnStartParams.input` 类型 + guardrail + 真实 Codex 冒烟确认模型看到图。详见 FINDINGS.md |
| issue-629-resume-error-shape-poc/ | **[#629 / Phase 2 POC — 源码层完成 + selftest 5/5 绿，待真实凭据]** Claude Code 坏/陈旧 resume 的 error shape。源码已定 gap（is_error **result** 路径不清 `sdk_session_id`：`claude-client.ts:1932` `resultEmitted=true` → `:1934` 分支不清 → `:2348` 兜底被抑制）；**判别不能用 subtype**（`SDKResultError.subtype` 仅 4 个通用枚举 `sdk.d.ts:2715`）、唯一潜在判别源 = `SDKResultError.errors[]`（`sdk.d.ts:2725`，claude-client 当前从不读）。driver `drive-resume-error-shape.mjs` 探 throw（→已被 `1568` catch 处理）vs is_error result（gap）+ dump `errors[]` 是否含 session 信号；`--selftest` 5/5 覆盖全 4 结局。POC-B 真实复现 400 待第三方 proxy 凭据。详见 README.md |
| issue-635-stream-idle-liveness-design.md | **[#635 / Phase 2 设计稿 — 调研完成 + 推荐，待 review 后实现]** SDK 路径慢 proxy 排队 >5.5min 被 idle abort 的根因与 liveness 设计。根因核验：SDK 排队期 app 层**完全静默**——keep_alive 被传输层 `Query.readMessages` `continue` 过滤（→ `claude-client.ts:2002` 死代码，spot-check 确证 `sdk.mjs`）、`api_retry`（`sdk.d.ts:2022`）仅失败后发且被 `case 'system'` 丢、首 token 前无 `stream_event`。Native 用独立 setInterval keepalive（`agent-loop.ts:123` 在 try 外）**已掩盖真卡死**（spot-check 确证）。三方向评估推荐 **C 分级超时**（首字节前长引信 / 首字节后短 idle）+ B（api_retry 接线），拒绝盲 keepalive A。三层 + 实现点 + 验收 + 明确不做。 |
| github-issue-backlog-audit-2026-06-29.md | **[v0.56.x Phase 7A dry-run — 只读]** GitHub backlog 审计快照:399 open issue 启发式分桶(keep-p1-review 5 / fixed-close 2 / old-version 54 / needs-repro 170 / feature 55 / support 15 / uncategorized 98)+ 统计(392 无 label / 208>90d);供人复核、未碰线上;由 scripts/github-issue-backlog-audit.mjs 生成可重跑 |
| phase-7e-issue-cleanup-2026-06-29.md | **[v0.56.x Phase 7E 执行记录 — 线上已操作]** 旧 issue 人工/半自动清理的逐批 gh 操作记录(关闭 / parking-lot / 复核)。Batch 1（最旧 30 无标签超旧 #27–#131）：关 20（not planned，**经用户授权只 close 不评论**）+ park 4 + 留复核 6；open 396→376。含 cohort 分析（超旧 220 拆解）、运行总计、累积待复核清单。每批追加 |
| ai-sdk-7-runtime-adoption-2026-06-29.md | **AI SDK 7 Runtime 采用调研**：结论是不直接替换 CodePilot Runtime；Native Runtime 可逐步吸收 ToolLoopAgent / v7 Core，Codex/Claude Harness 暂只做 POC；P0 先做 Node 22 + 依赖升级 spike，P1 验证 reasoning/effort request shape、ToolLoopAgent SSE parity、`@ai-sdk/mcp` adapter |
| foundation-experience-refresh-2026-07-17.md | **基础体验更新事实基线**：核验 GLM-5.2 / Kimi for Coding / GPT-5.6 / Claude Sonnet 5 与推理强度；定位 Codex `reasoningEffort` schema drift、跨 Runtime auto-review 权限语义、现有三条 50 字标题截断链路；已按 2026-07-17 审查裁决修订（Kimi Auto 语义 / Native effort 丢弃 / permissions response 形状） |
| clinepass-opencode-go-integration-2026-06-30.md | **ClinePass / OpenCode Go 接入调研**：ClinePass 走 OpenAI-compatible `cline-pass/*`; OpenCode Go 必须拆成 OpenAI-compatible 与 Anthropic Messages 两个 preset；初版建议 catalog-only，避免混合 `/models` 自动写库污染协议路由；2026-07-20 补 Kimi K3 精确 ID、官方来源与 ClinePass 真实 wire 证据 |
