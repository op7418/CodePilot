# Issue Tracker — 统一问题跟踪

> 创建时间：2026-04-13
> 最后更新：2026-08-26（新增 B-032：Composer 权限收口的三 Runtime 真实 effective-wire smoke 仍是合并/发布门禁）
> 合并自：`open-issues-2026-03-12.md` + `v0.48-post-release-issues.md` + GitHub Issues 最新盘点

**AI 须知：**
- 发现新 bug 或用户报告时更新此文件，不要新建分散的跟踪文档
- 修复后标注状态、修复版本、关键 commit
- 定期检查 Sentry 和 GitHub Issues 是否有新增项
- 状态说明：🔴 未修复 | 🟡 部分修复 | 🟢 已修复 | ⚪ 需验证 | 🔵 设计如此

---

## 〇、v0.56.x Stability / Trust 治理 issue（2026-06-19 纳入）

GitHub milestone `v0.56.x Stability / Trust`（#1）+ P0/P1 label 体系已建（见 [.github/TRIAGE.md](../../../.github/TRIAGE.md)）。以下 7 个 issue 已用**当前源码**重新核验（不采信 issue 自述根因），逐条证据与修法见 [v0.56.x-stability-trust.md](v0.56.x-stability-trust.md) 的「2026-06-19 Claude Code 源码复核」表，此处只做看板索引、不重复分析。

| Issue | 复核 | label | Phase | 状态 |
|-------|------|-------|-------|------|
| [#635](https://github.com/op7418/CodePilot/issues/635) 频繁自动中断 | 根因已定（SDK 排队期 app 层完全静默：keep_alive 被 SDK 传输层过滤、api_retry 仅失败后发被丢、首 token 前无 stream_event）；分级超时核心已实现（首字节前 600s / 后 330s）+ api_retry 接线 | P0-crash-or-interrupt, needs-repro | 2 | 🟡 分级超时核心已实现（防误杀），待真实慢 proxy smoke + 首条 /chat UI follow-up |
| [#632](https://github.com/op7418/CodePilot/issues/632) 上下文膨胀/>100% | ">100%" 确认显示 bug；跨会话不成立；假%/>100% 已修（effective-base-URL 写入 gate + 渲染期 trusted gate + clamp） | P1-context | 2 | 🟡 假%已修，item3 分母对齐待续 |
| [#629](https://github.com/op7418/CodePilot/issues/629) resume 400 空 assistant | POC-B 实证 4 proxy 文案 → 读 errors[] 判别 + 补 `no conversation found` pattern + claude-client 清 id；Codex 复审 smoke 抓到 route.ts 把 result.session_id **无条件写回覆盖了清理**（P1）+ is_error result 不落错误气泡（P2），已补：route 对 session-state is_error 不写回坏 id + 用 errors 设 errorMessage | P1-runtime-session | 2 | 🟢 已修 + GitHub 已关闭（2026-06-29 Phase 7A，v0.56.2）（Codex 端到端 smoke 通过：两轮坏 resume → 第二轮 fresh、不再 No conversation found） |
| [#628](https://github.com/op7418/CodePilot/issues/628) @file 误改上传副本 | 真实风险（fileResponseToAttachment 丢真实路径 → route 把 mention 也写 .codepilot-uploads 副本 → AI 改副本）；核心已修：FileAttachment 加 originPath、mention 保留真实路径、route 校验 cwd 内（复用 `assertRealPathInBase` + `rejectIfSymlink`，拒 in-tree symlink 逃逸，Codex P1）后引真实路径跳过 copy，AI Read/Edit 落真实文件 | P1-file-reference | 3 | 🟢 已修 + GitHub 已关闭（2026-06-29 Phase 7A，v0.56.2）（Codex 真机 smoke 通过：@file → AI Edit → git diff 真实文件变更；symlink 走降级不逃逸） |
| [#634](https://github.com/op7418/CodePilot/issues/634) Native 工具不可用 | 根因不成立——工具齐全；疑旧版 | P1-runtime-session, needs-repro | — | ⚪ 待 Native smoke + 版本 |
| [#626](https://github.com/op7418/CodePilot/issues/626) 更新提示高 CPU | polling 排除；候选 pulse 动画×backdrop blur | P1-performance | 4 | 🔴 待 profiler |
| [#633](https://github.com/op7418/CodePilot/issues/633) Win11 装不上 | mac 无法复现；NSIS-only+未签名+无 portable+CI 不验安装 | P1-installer-update, needs-repro | 4 | 🔴 待 Windows repro |

---

## 一、活跃 Bug（按优先级排序）

### P0 — 阻断核心功能

#### B-001 Provider 认证路径仍有边缘失败
- **Issues:** [#456](https://github.com/op7418/CodePilot/issues/456), [#461](https://github.com/op7418/CodePilot/issues/461), [#474](https://github.com/op7418/CodePilot/issues/474), [#478](https://github.com/op7418/CodePilot/issues/478), [#476](https://github.com/op7418/CodePilot/issues/476), [#457](https://github.com/op7418/CodePilot/issues/457), [#470](https://github.com/op7418/CodePilot/issues/470)
- **状态:** 🟢 主要路径已修（待 v0.50.2 发布验证），#474 独立子问题待跟进
- **现象:** Provider 诊断 1-5 全 PASS，第 6 项"实际连通测试"报 `PROCESS_CRASH` 或 `No API credentials found`
- **已修复的部分（v0.48.1-v0.48.2）：**
  - `resolveProvider()` 改为尊重 `default_provider_id`，不再依赖 `is_active`
  - `hasAnyCredentials()` 检查全部 Provider
  - auto 模式增加凭据检查（无 Anthropic 凭据 → native runtime）
  - SDK 认证死循环 3 轮迭代修复（env → DB provider → env_only）
- **本轮修复（2026-04-15，待发版）：cc-switch / 外部托管 settings.json 识别**
  - 新增 `src/lib/claude-settings.ts`：读 `~/.claude/settings.json` 的 `env` 块
  - `runtime/registry.ts hasCredentialsForRequest()` 增加 settings.json 作为凭据来源
  - `provider-resolver.ts buildResolution()` env 模式把 settings.json 计入 `hasCredentials`
  - 移除 `provider-resolver.ts:318` 的 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1` 死代码（SDK 0.2.62 不识别该变量，属于早期设计遗留）
  - 改进 `ai-provider.ts` 错误消息：当 settings.json 有凭据但 native runtime 失败时，明确引导用户切 SDK runtime
  - 新增 `claude-settings-credentials.test.ts`（10 个单测）+ 重写 `provider-preset.test.ts` 的 MANAGED_BY_HOST 测试
  - 详细分析见 `cc-switch-credential-bridge.md`
- **#474 独立子问题（未修）：**
  - 用户诊断 JSON 显示 `hasCredentials: true`、base URL `http://model.mify.ai.srv/anthropic` 是内部 DNS
  - runtime logs 仍有 "No provider credentials available" — 说明 agent-loop 调 `createModel({})` 时 providerId 透传丢失
  - Live probe 超时 15s（上游不可达）是另一层问题
  - 跟踪：检查 agent-loop → createModel 的 providerId 传递链路
- **Sentry 关联（14d）：** `No provider credentials available` Top 2 = **1,462 events**；预期本轮修复后 72h 内大幅下降
- **下一步:** v0.50.2 发版后跟踪 Sentry 指纹变化；发版说明里加 cc-switch 用户的"自动识别"升级亮点
- **B-001 Follow-up（已修复）：按 provider group 决定凭据归属 + per-request shadow `~/.claude/`**
  - 第三轮 review 后实施，2026-04-15
  - 规则：env group 完全尊重 Claude Code 来源（settings.json/cc-switch）；DB provider 显式选中时，auth/baseURL/model 仅以 DB provider 为准
  - 实现：`src/lib/claude-home-shadow.ts` 在 DB provider 请求里建临时 HOME，`.claude/settings.json` 剥 `ANTHROPIC_*` env keys（保留 mcpServers/hooks/enabledPlugins/permissions/apiKeyHelper），其余 `~/.claude/` 通过 symlink/junction 镜像
  - `runtime/registry.ts hasCredentialsForRequest()` 同步收紧：DB provider 不再用 settings.json 兜底（避免静默 rescue 配错 key 的 provider）
  - 用户级 MCP / plugins / hooks / CLAUDE.md 仍然完整可用
  - 12 个 shadow 单测 + 3 个 group-ownership 端到端测试覆盖：env+settings、DB+settings 共存、DB 配错 key 不救活、shadow 保留所有非认证字段及子目录、cleanup 真实生效
- **B-001 Follow-up TODO（非阻塞）：DB provider 凭据归属端到端 smoke**
  - 当前覆盖：所有 loader/helper 的输入边界都有单测（settingSources、shadow HOME、`prepareSdkSubprocessEnv`、`loadProjectMcpServers`、`mcpServerOverrides` 等）
  - 未覆盖：真实 claude CLI subprocess + SDK 内部 `qZq()` + 实际 API 请求路由的端到端验证。如果上游 SDK 行为变（例如 settings 加载顺序变化），unit test 不一定能感知
  - 建议方案：搭一个 mock 端点 + 真实 CLI 的 smoke fixture，断言 DB provider 请求实际打到 DB provider 的 base_url / api_key（不是 cc-switch 的）。当前 `package.json` 的 `test:smoke` 是 Playwright UI，不适用此场景，需要单独 harness
  - 优先级：低。属于"上游 SDK 升级回归"防护，不是当前修复正确性的必要条件
  - 触发条件：升级 `@anthropic-ai/claude-agent-sdk` 时主动跑一次

#### B-002 Sentry: AI_NoOutputGeneratedError 持续增长
- **状态:** 🟡 应用侧恢复修复完成，真实 provider 成功 smoke 仍被开发机 DNS 阻断。无 DNS 时已从 111–285s 空等改为约 3.2s 明确失败；正常终态延迟遥测已接入。
- **Sentry 数据:** 107x → 170x（2026-04-11）
- **已修复:** 空响应误报（agent-loop.ts eventCount→hasContent）
- **残留原因：**
  - sdkProxyOnly provider 被 native runtime 错误调用
  - 第三方代理模型 ID 不识别
  - 请求格式不匹配
- **2026-07-19 现场证据：**
  - DeepSeek Claude Code 轮次约 111s，只落 83 字诊断内容，terminal result 为 `error_during_execution`；GLM 约 285s、OpenCode Go 约 206s，后两条均为用户中止。以上是总轮次时间，不能当作 TTFT。
  - Agent SDK 提供的 `stream_event.ttft_ms`、result `duration_ms/duration_api_ms` 现已写入 assistant `token_usage.runtime_latency`；同时记录 CodePilot wall clock、真实 `api_retry` 事件数、terminal subtype 与 fresh/resume/fallback，不记录 prompt/工具参数/凭据。
  - 本机直连 Kimi、GLM、Google Fonts 都卡在 DNS；`scutil --dns` 返回 `No DNS configuration available`，无 HTTP proxy 配置，`127.0.0.1:7890` 也未监听。当前所有真实 provider smoke 都会被网络超时污染。
- **2026-07-19 恢复验证:** Claude Code × GLM 临时真实 route 会话在当前 `No DNS configuration available` 环境中 **3188ms** 返回 `NETWORK_UNREACHABLE`，并自动删除测试 session；不再等待 10 分钟首字 fuse。DNS preflight 只解析 hostname，代理配置/localhost/IP 会跳过，避免破坏代理远端解析。
- **下一步:** 恢复开发机 DNS 后，以同一会话/同一模型重跑并读取持久化的 TTFT、API/总时长、retry、terminal 与 resume 字段。若仍慢，再按 provider/model 与 resume/fresh session 分层定位。

---

### P1 — 功能受损

#### B-003 OpenAI OAuth 登录 403
- **Issues:** [#464](https://github.com/op7418/CodePilot/issues/464)
- **状态:** 🟢 已修（待 v0.50.2 发版验证）
- **现象:** `Token exchange failed: Token exchange failed: 403 - [object Object]`，macOS + Windows 均复现；项目维护者两台机器都不复现
- **本轮修复（2026-04-15）：网络鲁棒性 + 错误序列化**
  - `src/lib/openai-oauth.ts`: `exchangeCodeForTokens` 改为最多 3 次重试，对 403/408/429/5xx 和网络级错误（ECONNRESET / ETIMEDOUT / ENOTFOUND / ECONNREFUSED）做指数退避（1s/2s/4s）
  - 不重试 400/401/404/422 等真正的 auth/config 错误（避免无谓重试）
  - 错误消息改用 `JSON.stringify(j)` 替代 toString，根治 `[object Object]` 序列化 bug
  - 对照参考项目 OpenCode（`资料/opencode-dev/codex.ts:580`）的 polling 容错语义：`if (status !== 403 && status !== 404) return failed`，OpenCode 也把 403 当可重试处理
  - 新增 `openai-oauth-retry.test.ts`（14 个单测）覆盖 retry 分类逻辑
- **根因结论：**
  - 用户在不稳定网络（VPN / 跨境）+ OpenAI auth code 边缘节点 propagation 延迟时，单次请求容易撞 403
  - 维护者两台机器网络稳定，单次请求总是命中已 propagate 的节点 → 不复现
  - 与 client ID / redirect URI / 账号类型无关（之前的猜测排除）

#### B-004 打包版 localStorage 随机端口导致设置丢失
- **Issues:** [#465](https://github.com/op7418/CodePilot/issues/465), [#466](https://github.com/op7418/CodePilot/issues/466) 评论, [#477](https://github.com/op7418/CodePilot/issues/477)（默认模型不生效）
- **状态:** 🟢 根因修复（待 v0.50.2 发版验证）
- **现象：**
  - 模型选择器总是恢复为"自动（列表中第一个）"/ "Default (recommended)"
  - 每次重启显示"设置助理"提醒（promoDismissed 不持久）
  - 主题设置重启失效
  - 输入框默认模型徽标"原来有现在没了"（实质是 localStorage 清空导致 last-provider-id 丢失，即使 DB 有 global default 也匹配不到）
- **根因（已确认）：** `electron/main.ts:515` 的 `getPort()` 用 `server.listen(0, ...)` —— OS 分配随机端口；Electron 渲染进程的 origin 是 `http://127.0.0.1:<random>`；浏览器 localStorage 按 origin 存储 → 每次重启端口不同 → localStorage 整体失效
- **本轮修复（2026-04-15，待发版）：从根因层修，而非逐个迁移 localStorage**
  - `electron/main.ts:510-571` 重写 `getPort()`：先尝试稳定端口范围 `47823-47830`（IANA 未分配，常用程度低）；只在 8 个候选端口全部被占时才 fallback 到 OS-assigned
  - 新增 `isPortFree(port)` helper：用 `server.listen(port, ...)` 探测端口可用性
  - 单端口稳定后，**所有现有 localStorage 持久化代码自动生效**——不需要逐个迁移到 DB
  - 详细分析见 `electron-port-stability.md`
- **影响范围：** 一次性解决以下副作用问题
  - 主题（theme_mode + theme_family）重启保留
  - 默认模型 / 默认 provider 选择重启保留
  - 工作目录记忆（`codepilot:last-working-directory`）
  - 各类 announcement / banner dismiss 状态（已迁移 DB 的不受影响，未迁移的也不再丢）
- **不解决的边缘情况：**
  - 用户同时跑 8+ 个 CodePilot 实例 → 第 9 个会 fallback 到随机端口（极不常见）
  - 系统上其他程序占用 `47823-47830` 全部 8 个端口（极不常见）
  - 这两种情况下都会 console.warn 提示用户 settings 可能不持久

#### B-005 Generative UI 第三方 API 渲染失效
- **Issues:** [#471](https://github.com/op7418/CodePilot/issues/471)
- **状态:** ⚪ 暂无代码 bug 可修，建议用户升 v0.50.x 复测
- **现象：**
  1. show-widget / Generative UI 在第三方 API 上只显示原始 JSON 文本块
  2. OpenRouter 官方预设 + 正确 API Key → Provider 诊断仍无法通过
- **2026-04-15 重新核查（无修复行动）：**
  - Native runtime（处理第三方 API 的路径）实际上**已经**注册了 widget 工具：`src/lib/builtin-tools/widget-guidelines.ts` 提供 `codepilot_load_widget_guidelines` tool，`condition: 'always'`
  - chat/route.ts → `assembleContext({entryPoint: 'desktop'})` → `WIDGET_SYSTEM_PROMPT`（详细版）注入 `finalSystemPrompt`
  - native-runtime → `buildSystemPrompt({userPrompt: finalSystemPrompt})` → 包装在 `# User Instructions` 段
  - agent-loop → `assembleTools()` → 再加 builtin widget 短 prompt + 工具
  - **结论：第三方 API 路径同时拥有 widget 详细系统提示 + tool**，能力上对等
- **未修原因：**
  - 用户 #471 报告时间 2026-04-12，正是 v0.49.0 发布日；可能是 v0.49.0 早期 bug 被 v0.50.x 修了
  - 维护者两台机器 v0.50.1 复测 Generative UI 都正常，反向佐证不是当前代码 bug
  - 第三方某些较弱模型（如部分 GLM/Kimi 变体）确实可能对 `show-widget` 格式遵循度低，但这是**模型能力问题**而非 CodePilot 代码 bug
- **下一步:** 在 issue #471 回复请用户升 v0.50.1+ 重测；如果仍现，索取具体 provider/model 配置

#### B-006 会话切换模型重置
- **Issues:** [#462](https://github.com/op7418/CodePilot/issues/462)
- **状态:** 🟡 可能和 B-004 相关
- **现象:** 第三方 API 用户每次切换会话，模型回到 Claude 默认模型，即使在设置中已设为默认
- **可能原因:** session 的 model 字段没正确持久化，或读取时 fallback 到已被清空的 localStorage
- **下一步:** 和 B-004 一起排查，确认 model 字段的读写链路

#### B-007 Turbopack 环境 CLI 启动失败
- **Issues:** [#470](https://github.com/op7418/CodePilot/issues/470)
- **状态:** ⚪ 有 workaround，非代码 bug
- **现象:** v0.48.2 用户报 `Claude Code CLI not found`，但终端 CLI 正常可用，能读到历史对话和 Skills
- **根因:** Next.js 16 Turbopack 处理 symlink/junction 的 bug（用户评论中找到）
- **Workaround:** 改用 `next dev --webpack` 代替 Turbopack
- **下一步:** 在 FAQ / 文档中说明；考虑默认关闭 Turbopack 或检测并提示

#### B-008 Sentry: Controller is already closed
- **状态:** 🔴 未修复（v0.48.0 前已存在）
- **Sentry 数据:** 28x → 30x
- **根因:** ReadableStream controller 在流结束后仍有写入（keep_alive timer 或 onStepFinish callback 延迟触发）
- **下一步:** 在 controller.enqueue 外加 try-catch 或检查 controller 状态

#### B-009 Sentry: Model not found: sonnet 短别名解析失败
- **状态:** 🔴 未修复
- **Sentry 数据:** 8x → 145x（大增，部分是用户配错模型名如 `gemma:e4b`）
- **根因:** native runtime 的 `createModel()` 短别名映射在某些路径被绕过；第三方代理不接受短别名
- **下一步:** 确保所有路径经过 `isShortAlias()` 映射；对用户输入的无效模型名给出明确错误提示

#### B-028 Codex CLI 安装变化后不会重新发现可用版本
- **状态:** 🟡 代码、Tier 2、production UI、最终签名 arm64 `.app`/DMG/ZIP 的动态发现与刷新 smoke 已完成（2026-07-20）；仅真实 Homebrew 旧版 + ChatGPT.app 双安装终验待完成
- **计划:** [codex-cli-discovery-refresh.md](codex-cli-discovery-refresh.md)
- **现象:** 机器曾同时存在低版本 Homebrew Codex CLI 与客户端内置的新 CLI，CodePilot 实际使用了旧 `/opt/homebrew/bin/codex`；用户卸载旧版本后，设置页刷新仍不会自动切换到客户端内置 CLI。
- **现场证据:** 0.58.1 日志在 2026-07-08 尚能发现 `/Applications/Codex.app/Contents/Resources/codex` 0.142.5，并在两个候选中正确选择新版；2026-07-13 起却把 Homebrew 0.45.0 记为 `reason: 'sole candidate'`。当前真机核实 OpenAI 客户端已变为 `/Applications/ChatGPT.app`（bundle id 仍为 `com.openai.codex`），内置 `/Applications/ChatGPT.app/Contents/Resources/codex` 版本为 0.145.0-alpha.18，而旧 `/Applications/Codex.app` 已不存在。说明主因是客户端 bundle 改名后候选漏检，不是版本比较函数把两个已发现候选排错。
- **源码根因 1（缓存失效）:** `findCodexBinary()` 首次解析后把路径写入进程级 `resolvedBinaryCache`，之后直接返回；既不检查缓存路径是否仍存在，也不发现运行期间新增的更高版本候选。`resetCodexBinaryCacheForTests()` 仅供测试；`disposeCodexAppServer()` 也不清 binary/version cache。
- **源码根因 2（刷新是假刷新）:** `RuntimePanel.refreshCodexStatus()` 只让前端再次 GET `/api/codex/status`；status route 调用 `getCodexAvailability()`，最终仍读取同一缓存。按钮语义是“刷新”，实现却没有重新扫描安装状态。
- **源码根因 3（bundle 改名 + 路径覆盖窄）:** macOS 客户端 fallback 只硬编码旧 `/Applications/Codex.app/Contents/Resources/codex`；没有覆盖当前 `/Applications/ChatGPT.app/Contents/Resources/codex`，也没有覆盖两种 bundle 名的 `~/Applications/...` 用户级安装位置。
- **影响:** 可用的新 CLI 已存在时，Codex Runtime 仍被已删除或过旧的路径锁死，必须完全退出 CodePilot 的 server 进程才可能恢复；如果客户端安装在未覆盖路径，重启也无效。属于 Runtime resolver 的 P1 功能阻断。
- **修复方向:** ① 保留旧 `Codex.app` 兼容，同时加入系统/用户 Applications 下的 `ChatGPT.app` 候选；所有已发现候选仍按可解析版本最高者胜出。② 缓存命中前校验候选集合/已选路径；安装变化时原子清除 binary/version/失败 availability 并重扫。③ 提供 production rescan，由设置页刷新显式触发；已有 healthy app-server/active turn 时不热杀进程，避免“修刷新”引入会话中断。④ UI 展示实际选中的路径与版本，让“正在用哪个 Codex”可验证。
- **验证要求（Tier 2）:** 单测覆盖 `ChatGPT.app` 新路径、旧 `Codex.app` 兼容、“旧 PATH 先缓存→新增较新客户端→显式刷新改选”“已选路径被卸载→自动重扫”“系统/用户 Applications 候选”“两个候选仍选最高版本”；API/component test 断言刷新按钮确实触发后端 rescan；打包 smoke 在两版本共存、运行中卸载旧版本、仅新版客户端三种状态下验证 selected breadcrumb 与 app-server 可用性。
- **已落地:** 新增 `ChatGPT.app` / 旧 `Codex.app` 的系统与用户级四类候选；候选 fingerprint 变化会同步失效 resolution、version probe 与 failure availability；status POST 提供安全强制重扫，healthy app-server 不热切；Runtime 展示真实 CLI path。targeted 104/104、最终全量 unit 4422/4422、typecheck、production build 均通过；本机无 PATH CLI 时已从 `ChatGPT.app` 成功 initialize 到 ready 后正常 dispose。
- **smoke（2026-07-20）:** 仓库 `@smoke` 19/19；production UI 与可启动 arm64 `.app` 均验证临时旧路径 spawn_failed → 路径消失 → 点击刷新改选 ChatGPT.app，失败状态清除。真实 Codex Runtime turn 返回 `SMOKE_OK`，运行中刷新前后 app-server PID 不变；最终 0.58.2 签名 `.app` 的隔离 server smoke 中 health 200，Codex status GET/POST 均返回 `/Applications/ChatGPT.app/Contents/Resources/codex`。临时 shim 不等同真实 Homebrew 0.45.0，因此双安装真机终验仍保留。
- **已知未覆盖:** Windows 仍只覆盖 PATH `.exe` / `.cmd` shim；Windows ChatGPT/Codex 客户端是否内置 CLI、bundle 路径与升级行为尚无真机证据，已作为 tech debt 记录，不阻断本次 macOS 修复。

#### B-029 macOS standalone 误打包工作树内 release，codesign 失败
- **状态:** 🟢 已修复（2026-07-20）；0.58.2 arm64 `.app`/DMG/ZIP 已生成并完成签名、内容与启动 smoke
- **现象:** `electron:pack:mac` 已完成 Next/Electron build、arm64 app layout 与 `better-sqlite3` Electron ABI rebuild，但最终 codesign 递归进入 `CodePilot.app/Contents/Resources/standalone/.claude/worktrees/product-refactor-research/release/.../Electron Framework.framework` 后报 `bundle format unrecognized, invalid, or unsuitable`，命令退出 1。
- **根因证据:** Next/Turbopack 的 instrumentation NFT 不应用 route 级 `outputFileTracingExcludes`，动态 HOME/workspace 文件访问把整个项目根误判为运行依赖。除 `.claude/worktrees/**/release` 的嵌套 Electron 产物外，审计还发现本地 `data/*.db`、`.codepilot`、上传文件与文档被复制进 standalone；前者使递归 codesign 失败，后者构成不可接受的发布数据泄漏风险。
- **修复:** Electron production build 先精确清理 `release/.next/dist-electron`；动态 HOME 扫描增加 Turbopack ignore 边界；Next build 后以严格根目录 allowlist 只保留 `.next`、`node_modules`、`server.js`、`package.json`、`cache-handler.js`，移除其余误追踪内容并 fail-closed 复核。新增 4 条行为/合同测试覆盖安全清理、泄漏阻断、最小 allowlist 与构建顺序。
- **验证:** 最终 0.58.2 arm64 `.app` 的 standalone 只有 Next runtime 5 项，electron-builder 额外加入受控 `public/themes`；包内无本地 DB、上传、`.codepilot/.claude/.git`。`codesign --verify --deep --strict` 通过；DMG `hdiutil verify` 通过；隔离启动最终 packaged server 后 health 200，Codex status GET/POST 均真实选中 ChatGPT.app CLI。生成 `CodePilot-0.58.2-arm64.dmg` 与 `.zip`，B-029 不再阻断发布。

#### B-030 Codex 模型刷新异常后 Next utility process OOM，历史对话/文件树失活并灰屏
- **状态:** 🟡 Mitigations shipped in v0.66.2 / Tests pass / Crash smoke passed / Review passed（2026-08-13 official-signed 跨平台 package gates 与 Release 已通过；2026-08-12 Claude 复核 follow-up `accepted`。P2“SDK ChildProcess abnormal-exit 双报”已修：保留 breadcrumb、`events:[]` 关闭自动 Issue；两条 P3 亦闭环：final `codesign` 15s/60s 硬超时，utility 负 exit code 按平台有界整数保留。2026-08-11/12 ad-hoc arm64 `.app` 的 kill ×1、三次自动重启预算耗尽（第4次 crash 停止）及 live-Codex blocked/quit-only 均通过。持久化 registry 记 tech-debt #85）；根因按 F 类“本地未复现”保持开放，active-turn UI、15/60 分钟 soak 与 stable Sentry cohort 未完成，不能称根因已修复
- **计划:** [codex-model-refresh-utility-process-oom-recovery.md](codex-model-refresh-utility-process-oom-recovery.md)
- **现象:** macOS v0.66 用户点击历史会话后中心显示 `Failed to fetch`、文件树显示 `Failed to load file tree`；再次进入或刷新后只剩透明/灰色窗口。完全退出重开可短暂恢复，但数十秒到数分钟后重复。
- **确定证据:** 用户脱敏主日志在约 12 分钟内记录四次 `OOM error in V8: Zone Allocation failed - process out of memory`；Next server exit code 5，Electron breadcrumb 为 `child-process-gone type=Utility reason=crashed`，随后本地稳定端口持续 `ECONNREFUSED`，chat URL `ERR_CONNECTION_REFUSED`。GC 前 child heap 约 354–360MB，部分 total 约 428MB。
- **已排除:** 不是历史消息损坏的必要结果——fresh `test` 明确 `historyMessageCount: 0` 仍 OOM；不是 Provider 401 的必要结果——前三次未发送新消息已崩溃；不是旧 B-025 日志洪水——本次 `serverErrors` ring 只有约 1.2–8.8KB。
- **高相关前置信号:** 同一运行在首个 OOM 前约四小时至少十二次出现 `codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit`；上游 `openai/codex#34397` 有同形周期性 hang 报告。但 exact allocator / orphan / oversized frame 尚未定案。
- **已落地:** Codex stdout 改为 copy-before-cap 的 32 MiB byte-bounded NDJSON reader；`model/list` deadline abort、server-side single-flight、5 秒 cooldown、连续三次 signal 后 unhealthy idle recycle；Main-owned recovery safe mode 禁止 replacement server 启动 Codex/scheduler，并在 Chat 明示且禁发。Electron Main 新增 1s/2s/4s 有界 supervisor、stable-port health gate、poll pause/resume、self-contained recovery page、脱敏诊断、恢复交接 queue 与 current-generation descendant registry；live/PID-reuse/unverifiable tree 一律不 kill、fail-closed。2026-08-12 再补 stable opt-in、每 generation 一次的 utility fatal normalized Sentry event（只含稳定枚举和数值，raw report 丢弃）；SDK `ChildProcess` 保留 breadcrumb 但关闭自动 event，避免 `abnormal-exit` 双报；exit code 使用独立平台有界整数合同。最终 Developer ID verifier 的 `codesign` inspect/deep verify 有 15s/60s 进程级硬超时。Electron 40.2.1 升到同主版本 40.10.6。
- **验证:** 原实现轮相关 transport/model/supervisor/registry/offline-page 定向测试 108/108，全量 `npm run test` 5179 pass / 0 fail / 1 skip（5180 tests）；`npm run build`、`npm run electron:build` 通过；禁用 Developer ID 自动发现后完整生成 ad-hoc signed arm64 目录包，deep/strict 签名、Resources/app.asar 0 source map 与 packaged `/api/health` verifier 全部通过。2026-08-12 Safe Storage/signing 补丁全量 5193/0/1，Electron 40.10.6 build/package/deep/strict/0-map/health 与 GUI recovery single/budget/blocked 三场通过；telemetry review follow-up 定向 32/32、全量 5193/0/1；P3 follow-up 定向 9/9、全量 5194/0/1（5195 tests），Electron production build 通过。blocked 保持 quit-only。v0.66.1 official CI run 31615349470 证明证书已导入但 `CSC_IDENTITY_AUTO_DISCOVERY=false` 仍令 electron-builder 跳过身份选择；afterSign 按预期 fail-closed，未创建 Release。修正后 v0.66.2 run [`31616811316`](https://github.com/op7418/CodePilot/actions/runs/31616811316) 的 macOS Developer ID 双架构 package/final verifier、Windows、Linux x64/arm64 与 release job 全绿；[Release](https://github.com/op7418/CodePilot/releases/tag/v0.66.2) 为非 draft/非 prerelease且 12 assets uploaded。真实 active-turn/soak/cohort 仍是独立验收。
- **下一步:** 用可控 provider/凭据跑 active-turn interruption、历史 route/文件树恢复；跑 fresh/history 15 分钟和长任务 60 分钟内存曲线；下一 stable 核验 utility fatal event 的脱敏/分组和 Graphite/utility crash cohort。条件允许时在受影响机器执行经批准的 profile/heap/network A/B。未获外部分发/机器 A/B 授权时继续只做本地/合成验证。

#### B-031 GLM-5.3 显示已添加但模型管理仍停在 5.2
- **状态:** 🟡 2026-08-23 候选修复 Code/Tests/Build 已完成；production 用户路径保持打开，直到受影响 0.67.1 用户 smoke
- **重开计划:** v0.67.1 生产反馈闭环 × 全平台签名与自动更新
- **现象:** v0.67.0 用户在 GLM (CN) 的 Add Model 看到 GLM-5.3“已添加”，但 Models 列表仍只有旧 GLM-5.2，composer 也没有可选的 5.3 行。
- **2026-08-23 新 Signal:** 用户明确已升级 `0.67.1`；截图中 GLM-5.3 仍显示“已添加”，Models/模型选择仍找不到，旧 GLM-5-Turbo 继续存在。该证据打回真实 legacy upgrade path；不是“尚未升级”或“仅 UI 未刷新”可以解释。
- **2026-08-24 候选修复:** 新增 catalog `legacyFingerprints` 与五态 presence（current enabled/hidden、legacy upgrade、identity conflict、missing）；从已发布 git 历史补齐真实 sonnet→`sonnet` 的 gen-0 `GLM-4.7`、后续 `GLM-5-Turbo`/`GLM-5.2`，以及 haiku→`haiku` 的 `GLM-4.5-Air` 槽位，删除无历史来源的 sonnet→`glm-5-turbo` 猜测。只有 upstream/display/capabilities 完整吻合且无用户所有权信号的历史系统行才 compare-and-swap 升级。upstream 占用或歧义 fail-closed，不 delete/disable/覆盖用户行。2026-08-24 修复轮 review 曾证明首版遗漏 gen-0；计划先回退为“部分”，补齐 git 证据、三行 fixture 与 conflict 行为断言后才恢复为 Code complete。
- **已确认的 0.67.0 根因:** Runtime/final picker 有当前 catalog 的只读 enrichment，但 per-provider Models GET 只在空表 seed，已有 SQLite 快照不升级；Add Model 又把 stable alias 与 wire id 混作一个“已添加”布尔值。初版热修复审还发现并发 INSERT、同 upstream 双行、hidden 候选无恢复动作，以及 catalog 重加被降级成 manual 空能力行。
- **已确认机制 / 未确认用户行形:** `search-models.getPresence()` 会因 stable `model_id=sonnet` 命中旧 wire 而把 5.3 判“已添加”；旧 merge 又可能因 ownership/identity 保护不升级，这两条已由源码和历史 fixture 确认。该用户的具体 source/user-edited/enable-source/duplicate 组合仍未读取，必须以脱敏四面对账确认，不能把 fixture 冒充用户 DB。
- **修复:** catalog-only plan 的 Models GET 执行非破坏 merge；stable/wire identity 分离并双查重；候选区分 enabled/hidden/missing，hidden 可直接重新启用；精确 catalog POST 从服务端目录恢复 display/upstream/capabilities/source/order；冲突插入与用户排序有反例测试。
- **边界:** 不自动清理历史 user-owned 双行（可能被 session pin），需要未来 preview-first 整理；但 canonical current SKU 已存在时不会因额外旧行整体降级为 conflict。真正 CAS conflict 会返回 model ids，Add Dialog 展示解释与 Models 恢复入口。当前 catalog 项若只想停用应“隐藏”，物理删除后会被目录重新物化。
- **验证:** 定向 210/210；标准全量 5257 pass / 0 fail / 1 skipped（5258 tests）；production build 136 pages；隔离 UI 已验证 `glm-5.3[1m]` 搜索、hidden 恢复、3/3 列表刷新与正确 stable/wire 映射，控制台无 warning/error，真实用户 DB 未写入。
- **发布:** v0.67.1（commit `634a0dc7`；CI `31898968564` 全绿；stable Release 12 assets uploaded）
- **重新关闭门禁:** 必须增加受影响/历史真实 row shape 的 failing-then-passing fixture，Models/Search/Runtime/Composer 四面一致，并由至少一名受影响 0.67.1 用户完成候选版本升级 smoke；isolated pristine fixture 不再足以关闭。
- **当前验证:** gen-0 与后续两组完整三行 published-history fixture 验证 sonnet/haiku 原位升级、各世代非目标 opus 保留；五态/conflict recovery、真实 `identity_conflict` fail-closed 断言与四面合同通过。2026-08-24 收口定向 49/49；标准全量与 build 数字见关联计划最新 Smoke Ledger。真实用户 DB 未写入，最后一条 production smoke 仍待跑。

#### B-032 Composer 权限收口缺三 Runtime 真实 effective-wire smoke
- **状态:** ⚪ Code / unit / UI E2E 已通过；Tier 2 真实 wire 未验，合并/发布门禁保持打开
- **计划:** [Composer 模型路线、能力参数与权限入口收口](composer-model-route-permission-consolidation.md)
- **风险:** 新 UI 已把 legacy `mode + permission_profile` 收成四档，但自动化合同不能替代 Claude Code / CodePilot Native / Codex 三条真实发送路径的 effective wire。若 resolver 或 Runtime adapter 与测试 fixture 漂移，可能出现“只读规划”实际可写，或“请求批准”实际绕过确认。
- **已验证:** 双向映射表、round-trip/no-touch、API 校验、Runtime-first picker、权限文案与 scoped E2E；本轮复审修复失效收藏管理、sidebar hydration、`context_1m` shared-option 污染及 picker 硬编码文案。最终 `npm run test` 5363 pass + 1 skip、scoped Playwright 14/14、smoke 23/23，production build 137 pages；这些自动化结果不替代下述真实 wire 门禁。
- **关闭门禁:** Claude Code、CodePilot Native、Codex 各跑至少一条 `read_only/plan` 与一条 `default` turn，记录 session id、Runtime、resolved provider/model、effective permission/sandbox/tool surface source；逐条证明 plan 只读、default 不比迁移前更少询问。任何一条不一致均保持 blocker。
- **边界:** 在六条真实记录写入计划 Smoke Ledger 前，不得把 Composer 计划标为 `Smoke passed` / `Review passed` / 完成，也不得用 unit mock、源码形状或单一 Runtime 成功代替。

---

### P2 — 体验问题

#### B-010 Windows 发消息弹终端窗口
- **Issue:** [#244](https://github.com/op7418/CodePilot/issues/244)
- **状态:** 🔴 未修复
- **根因:** `child_process.spawn()` 缺少 `windowsHide: true`
- **修复方向:** `claude-client.ts` spawn 调用加 `windowsHide: true`

#### B-011 中文输入法回车误发送消息
- **Issue:** [#225](https://github.com/op7418/CodePilot/issues/225)
- **状态:** 🔴 未修复
- **根因:** `compositionend` 同步重置 `isComposing`，后续 `keydown(Enter)` 看到 false 触发提交
- **修复方向:** `handleCompositionEnd` 用 `setTimeout(0)` 延迟重置

#### B-012 多 Bridge 适配器同时启用互相干扰
- **Issue:** [#455](https://github.com/op7418/CodePilot/issues/455)
- **状态:** ⚪ 需重新诊断（2026-04-14 代码核实：隔离层面看不出问题）
- **代码核实:**
  - `FeishuChannelPlugin` 状态都是 instance 字段（`channels/feishu/index.ts:42-49`），无 globalThis 共享
  - `state.adapters` 是 per-type Map（`bridge-manager.ts:203`）
  - 每个 adapter 有独立 abort controller（`bridge-manager.ts:452`）
  - 错误追踪也是 per-adapter（`adapterMeta`）
- **下一步:** 需向用户收集具体复现步骤和日志——可能是飞书/QQ 单独的问题，或者是 `bridgeModeActive` 这类全局 flag 的交互

#### B-017 Feishu WSClient 长连接稳定性
- **Issues:** [#323](https://github.com/op7418/CodePilot/issues/323), [#288](https://github.com/op7418/CodePilot/issues/288), [#199](https://github.com/op7418/CodePilot/issues/199), [#149](https://github.com/op7418/CodePilot/issues/149), [#148](https://github.com/op7418/CodePilot/issues/148)
- **状态:** ⚪ 需重新诊断
- **现象:** Feishu WebSocket 长连接失败、断连、测试连接失败
- **已知错误码:** `code 1000040345 system busy`（飞书服务端）
- **下一步:** 收集 WSClient 错误日志和复现环境；考虑在 `gateway.ts` 的 `start()` 外层加重连+健康检查
- **关联:** `@larksuiteoapi/node-sdk` v1.59.0 的 WSClient 不提供 clean stop（`gateway.ts:180-186` 注释）

#### B-013 连接测试误报失败
- **状态:** 🟡 部分修复（v0.48.2 修了 masked key 回填）
- **残留:** 测试和实际聊天走的 provider resolution 路径不同

#### B-014 Claude Code 批量导入需逐个手点
- **Issue:** [#465](https://github.com/op7418/CodePilot/issues/465) 附带反馈
- **状态:** 🔴 未修复
- **描述:** 导入 Claude Code 会话需要一个个手动选择，无批量选择

#### B-019 SDK runtime + 慢 provider 首包静默撞 330s Stream idle timeout
- **Issue:** [#499](https://github.com/op7418/CodePilot/issues/499)
- **状态:** 🔴 未修复（长期存在的架构盲点，v0.50.3 runtime auto 简化后暴露面扩大）
- **现象:** Aliyun Bailian + `qwen3.6-plus`（及其他慢首包 provider）发消息后 330 秒固定报 `Stream idle timeout — no response for 330s`
- **代码位置:**
  - `src/lib/stream-session-manager.ts:88` 硬编码 `STREAM_IDLE_TIMEOUT_MS = 330_000`
  - `src/lib/stream-session-manager.ts:242-248` 每 10s `setInterval` 检查 `Date.now() - lastEventTime >= 330s` → abort
  - `markActive()` 覆盖 22+ 个 SSE 事件类型，包括 `onKeepAlive`（line 466-468）——**任何**事件都刷新 lastEventTime
- **根因（架构层）:** **SDK runtime 路径缺 keepalive 兜底**
  - Native runtime `src/lib/agent-loop.ts:76,119-121` 每 **15s** 主动发 `keep_alive` SSE，天然防止 330s 超时
  - SDK runtime `src/lib/claude-client.ts:1451-1452` **只透传** Claude Code SDK 自己发的 `keep_alive`——SDK 与上游中间静默时，我们不补心跳，客户端就真的会 330s 后 abort
  - v0.50.3 的 runtime auto 改成 binary check，**装了 CLI 的用户默认走 SDK runtime**——扩大了暴露面。Bailian Coding Plan 后端有排队机制，首包可能静默几分钟，正好撞上
- **为什么 v0.50.3 才集中爆出:** `STREAM_IDLE_TIMEOUT_MS = 330_000` 常量早就存在，不是本版引入的；但 qwen3.6-plus 是 v0.50.3 新加模型（commit `2d06f50`）+ 百炼首包排队慢 + SDK runtime 成为装了 CLI 用户的默认 = 三者叠加
- **修复方向（二选一或都做）:**
  1. **快修**：把 `STREAM_IDLE_TIMEOUT_MS` 提到 600s 或做成 provider 级可配置（UI 或 `options_json` 字段）
  2. **根治**：在 SDK runtime 的 SSE pipe 侧也加 15s keepalive 定时器，对齐 Native runtime 的兜底节奏
- **推荐:** 先做根治（#2），成本不大、一劳永逸；#1 作为 provider-level override 留给有异常慢后端的场景（少数）
- **下一步:** 下个 hotfix 窗口处理

#### B-020 MiMo 模型配置疑似被回退
- **状态:** 🟢 已修复（worktree `ea860da`，Phase 4 / #577；待 preview 真机复测）
- **本轮修复（2026-06-03，`ea860da`）:** MiMo 可设型号不再被 preset / discovery 回退到默认；成功回答后不再追加 provider error（同 #577）。已确认真实 upstream model id 后才改默认，未臆造。
- **现象:** MiMo 的模型配置不知何时从用户预期的 `2.5 Pro` 被改成了 `V2.5` 和 `V2`；用户认为这是“偷偷改掉”的回归。
- **影响:** Provider 默认模型 / role model 可能不再指向用户实际购买或可用的 MiMo 模型，导致新用户开箱不可用或老用户发送到错误模型。
- **需核查:**
  - `provider-catalog.ts` 中 MiMo preset 的 `model_names` / `roleModels` / default model。
  - Provider 编辑/连接弹窗是否把真实型号保存到 `role_models_json`。
  - 旧 DB 行是否被 preset sync / align / discovery 覆盖。
- **下一步:** preview 真机复测 MiMo 型号选择持久；保留为 provider catalog 回归观察项。

#### B-021 服务商编辑页右上角关闭按钮失效
- **状态:** 🟡 部分修复 / ⚪ 待 Windows 真机验证（worktree `2646f23`，Phase 5）
- **本轮修复（2026-06-03，`2646f23`）:** Windows fullscreen 编辑弹窗的应用内 close 按钮让出系统窗口控制区，消除与系统 X 贴脸 / 重叠（对应 preview blocker「双 X 过近」）；"点击无效"若源于系统按钮覆盖应用按钮则一并缓解。**Windows-only，源码 / 回归 guard 已加，待 Windows packaged 真机 smoke 终验点击可关闭。**
- **现象:** 编辑服务商页面 / 弹窗中，右上角的“×”点击后无法关闭页面。
- **影响:** 用户进入 Provider 编辑后无法正常退出，属于设置页 P1 体验阻断。
- **关联历史:** 近期修过 Windows fullscreen 弹窗关闭按钮与系统窗口控制区重叠问题，但本反馈是“点击无效”，需要重新核查事件处理与 Dialog close wiring。
- **需核查:**
  - ProviderForm / DialogContent fullscreen 分支的 `onOpenChange` / close button 是否被阻断。
  - Windows WCO safe-area 调整后是否造成按钮视觉可见但事件落到错误层级。
  - macOS / Windows 是否表现一致。
- **下一步:** Windows packaged smoke 终验点击可关闭；macOS 侧已确认无回归。

#### B-022 消息队列疑似回归
- **状态:** ⚪ 需验证（同源的 #578「中断后发送无响应」已由 worktree `fcce794` 修复；本条「streaming 期间排队」症状待专项 smoke）
- **本轮进展（2026-06-03，`fcce794`，Phase 2 / #578）:** 中断任务后输入框发送无响应已修（无条件调度 force-abort，清掉卡住的运行锁 / abort controller）。与 B-022 同源——发送入口被未清理的运行锁卡住；但「streaming 期间能否继续排队」未单独验证。
- **现象:** 以前消息发送后，用户可以继续发送下一条，后续消息会进入队列；现在有用户反馈不行。
- **影响:** 长任务期间无法连续追加指令，影响核心聊天工作流。
- **需核查:**
  - `ChatView` 的 `messageQueue` / `isStreaming` 逻辑是否仍允许 streaming 期间排队。
  - `MessageInput` disabled 条件是否因为 runtime/provider gate、provider loading、session incompatible 等状态过宽，导致 streaming 期间输入/发送入口被完全禁掉。
  - `stop` / `force-abort` 修复后是否改变了队列调度顺序。
- **下一步:** 增加 smoke：发送第一条并保持 streaming，再发送第二条，断言第二条进入队列且第一条完成后自动发送。

#### B-023 MCP 设置页可见但运行时不可调用
- **Issue:** [#569](https://github.com/op7418/CodePilot/issues/569)
- **状态:** 🔴 未修复（2026-06-02 用户反馈；2026-06-04 从主分支 tracker 草稿迁入 worktree active 看板，避免合并丢失——GitHub issue 仍是永久记录）
- **现象:** MCP 列表能自动读取 Claude Code 配置，但运行状态里看不到，模型也无法调用；用户补充：必须把 MCP 再配置到项目路径才会识别。
- **影响:** MCP 可见性与可调用性不一致——用户以为已启用但模型实际调不到；属"设置页看得到、运行时不可调用"的假承诺（触及 CLAUDE.md 语义验收）。
- **需核查:** 全局/用户级 Claude Code MCP 配置与 CodePilot runtime 注入 / 运行状态 UI 的来源是否一致；为什么只有配置到项目路径才识别。
- **下一步:** 合并后排查 runtime MCP 注入来源 vs 运行状态 UI 来源；若不修则降级文案，别让设置页假承诺"已启用"。

#### B-024 Codex Runtime 终止后无法拉起新任务
- **计划:** [codex-stop-recovery.md](codex-stop-recovery.md)
- **状态:** 🔴 下版发布前阻断 / 需复现与修复（P1-P3 代码和单测已完成，但真实 Stop smoke 一直未完成；2026-08-25 新 Signal 使发布门禁重新打开）
- **现象:** Codex Runtime 正在执行任务时点击 Stop / 终止后，同一会话后续无法发送新指令，像是进程或 session 挂死；用户需要新建会话、重启或等待未知时间才能继续。
- **2026-08-25 新 Signal（用户原始路径）:** 在“Codex 渠道 → Codex 连接 → GPT-5.6”跑任务时点击一次“终止”，随后整个页面崩溃，刷新也不能恢复。用户紧接着重试未能复现，因此目前只有一次真实用户观察；App 版本、任务所处阶段、session id、`render-process-gone` / `child-process-gone` / utility exit 与错误栈尚未取得。**不得把单次未复现写成已修复，也不得在无日志时断言仍是旧 session lock 根因。**
- **影响升级:** 旧症状主要是同会话无法继续发送；新症状可能跨到 Renderer 崩溃、Next utility 退出/本地端口失活、恢复页失效或 Stop 终态数据触发渲染异常。`刷新无效` 只说明单纯 Renderer reload 没有恢复，不能单独证明是哪一层死亡。
- **修复前本地核实（2026-06-06）:** 三因素根因：#578 的 `stream-session-manager.ts` force-abort 兜底只保证前端 stream 离开 active；当时 `src/app/api/chat/interrupt/route.ts` 只调用 native 和 SDK conversation interrupt，未调用 `getRuntime('codex_runtime')?.interrupt(sessionId)`；`chat/route.ts` 已把 abortController 传到 Codex Runtime，但当时 `src/lib/codex/runtime.ts` 不读 `options.abortController?.signal`。而 Codex Runtime 已有 `turn/interrupt` 实现，说明中断能力存在但两条入口没接上。
- **已落地但未完成真实验收:** route fan-out、Codex abort/turnId race 与精确 lockId watchdog 已实现并通过单测；真实 Codex Stop smoke 没有完成，所以不能证明这些修复覆盖 2026-08-25 的新 crash Signal。
- **原机制影响:** Stop 后后台 Codex turn 可能继续运行，`chat/route.ts` 的后台 `collectStreamResponse` 不结束，session lock 的 60s renew interval 不会 clear，会持续续租 600s lock，下一条同会话 send 可能被无限期 `SESSION_BUSY` 或 runtime running 状态阻塞。
- **需核查:**
  - `/api/chat/interrupt` 是否对 `native` / `codex_runtime` / SDK conversation 都做 best-effort fan-out。
  - 用户很快点 Stop 时，`turn/start` 尚未返回 turnId，`activeCodexTurns` 还没 set，Codex Runtime interrupt 是否会 no-op 并丢失中断。
  - Stop 后 `collectStreamResponse`、session lock、runtime status 是否在 terminal/interrupted 路径完成收口；即使上游没有 terminal event，也要有精确 lockId 的 bounded cleanup。
  - 新 Signal 必须区分 Main/Renderer/Next utility/Codex app-server 四层存活状态，并核对 Stop 前后最后事件、interrupt route 结果、turn id、utility health、本地端口和 crash breadcrumb。
- **发布前门禁:** 用拟发布 packaged build 按“刚发送后 / reasoning 中 / tool 执行中 / permission 等待中”重复 Stop；每次都断言页面不崩、刷新可恢复、同会话能继续发送、无 renderer/utility crash、session lock 与 runtime status 收口。命中一次即保留日志并进入 `Signal → Triage → Fix → Verify → Guardrail`；未复现也必须补齐针对性诊断并留下真实重复 smoke 证据，不能靠这次手工重试关闭。
- **下一步:** 先对当前 P1-P3 实现跑 GPT-5.6 的真实 packaged Stop 矩阵并收集四层日志；依据证据修复实际 crash plane，再补 failing-then-passing 回归。P5/P6 是否展开由本次证据决定，不再默认后置。

#### B-025 主日志 12G 暴涨与 Codex Runtime 闪退
- **计划:** [log-bloat-codex-runtime-crash.md](log-bloat-codex-runtime-crash.md)
- **状态:** 🟡 P0+P1 已落地并通过单测；真实 Codex approval/network live smoke 待跑（2026-08-10 状态校准）
- **现象:** 用户另一台电脑 `codepilot-main` 日志达到约 12.5G；Codex Runtime 下客户端偶发闪退，最近一次疑似发生在突破沙盒权限、需要网络授权/搜索文件时。
- **当时本地核实:** 用户日志尾部 50MB 中约 70,000 行里 69,253 行是 Codex app-server `codex_core::tasks` enter/exit tracing；修复前 `electron/main.ts` 没有 size-based rotation，`src/lib/codex/app-server-manager.ts` 默认 `RUST_LOG=info`，且修复前 `serverErrors.push(msg)` 无界累积。
- **历史影响判断:** 日志暴涨会吃磁盘；修复前无界 `serverErrors` 也会把 tracing 噪声留在主进程内存里，因此当时被列为闪退/卡死的高置信候选。原样本没有 `panic` / OOM / uncaught 栈，未能把闪退类型定案。
- **已落地:** 主日志 size rotation、`serverErrors` 双上限 ring、Codex tracing 默认降级/过滤、`render-process-gone` / `child-process-gone` / uncaught crash breadcrumb 已实现并有单测。2026-08-10 新事故已拿到明确 Utility OOM，但该 child 的内存不来自旧 Main `serverErrors` 洪水，另由 B-030 跟踪。
- **下一步:** 保留真实 Codex `require_escalated` / network approval smoke 验证债；不要把 B-030 的 Next child OOM重新归因到已经封口的 logging 链路。

#### B-026 Kimi for Coding 首轮不会生成语义会话标题
- **状态:** 🟢 已修复，真实 provider wire smoke 通过；待用户用新会话复验 UI 即时同步（2026-07-19）
- **现象:** Kimi for Coding 能正常回复，侧栏标题却一直停在首条消息 fallback；同版本 GLM + Claude Code 可正常生成标题。
- **根因:** Kimi Code `/coding/` 模型为 always-thinking；标题辅助调用却强制 `MAX_THINKING_TOKENS=0`，且 `CLAUDE_CODE_MAX_OUTPUT_TOKENS=16` 由 thinking 与 final 共享，8 秒 timeout 也短于现场普通回复约 10 秒。错误被自动命名的静默降级合同吞掉，所以 UI 只呈现 fallback。
- **修复:** 按精确官方 endpoint（`api.kimi.com/coding/`）选择 provider-managed thinking profile：移除继承的 `MAX_THINKING_TOKENS`，输出预算 2048，后台 timeout 30 秒；不按可编辑 provider 名称或 Moonshot 品牌猜测。默认 provider 继续保持 16 tokens / 8 秒 / thinking disabled，用户可见标题始终钳到 50 grapheme。
- **验证:** 标题相关定向测试 68/68；真实现有 Kimi 凭据 synthetic wire smoke 4043ms 生成可用标题；详见 automatic-chat-titles.md Smoke Ledger。旧 session 已消耗一次 attempt，不自动重试，避免重复外发首条消息。

#### B-027 Codex Account 添加失败时点击无可见反馈
- **状态:** 🟢 UI 修复、targeted guardrail、production UI 与可启动 arm64 `.app` 失败 smoke 均完成（2026-07-20）
- **现象:** 执行引擎页显示 Codex「应用服务启动失败」；服务商 → 添加服务 → 点击 Codex Account 后添加弹窗关闭，但没有登录弹窗、错误提示或后续动作，用户感知为“点击卡片没反应”。
- **现场根因:** 该机器只剩 `/opt/homebrew/bin/codex`（日志为 `reason: 'sole candidate'`；历史 probe 明确是 `codex-cli 0.45.0`），而 `~/.codex/config.toml` 含 `model_reasoning_effort = "xhigh"`。旧 CLI 仅接受 `minimal/low/medium/high`，`app-server` 启动即 fatal；0.58.1 的快速失败防线正确 kill 子进程，但多个 status/login/models 请求仍会再次 spawn。
- **UI 根因:** `ProviderManager.handleCodexLogin()` 失败时会 `setCodexError(...)`，但添加卡片的 `onClick` 先执行 `setAddServiceOpen(false)`；而 `codexError` 只渲染在 `(openaiAuth?.authenticated || codexAccount?.kind === 'logged_in')` 条件内。首次配置且未登录任何 OAuth 服务时该 section 不存在，所以错误被状态树吞掉。
- **影响:** 环境/版本错误本可操作（升级 Codex CLI，或临时把旧 CLI 不支持的配置降到 `high`），UI 却不给原因和恢复入口；同时重复点击/刷新产生 app-server 重启风暴。属于 Provider/Runtime 状态的假静默，违反用户可见状态须有真实 source breadcrumb 的语义验收规则。
- **修复方向:** ① 添加服务请求失败时保持弹窗并显示 inline error，或使用页面级 toast；错误呈现不能依赖已有 OAuth 连接。② 将 app-server 的原始失败分类为可操作提示，至少展示选中的 binary 路径、探测版本和不兼容配置字段，避免只写「启动失败」。③ 对确定性的启动期 fatal 增加短期失败缓存/单航班，刷新或用户显式重试再解除，避免同一页面多个消费者反复 spawn。
- **验证要求（Tier 2）:** targeted component test 覆盖 `logged_out + POST /api/codex/login 失败`，断言错误可见且入口可重试；app-server manager/status/login 并发测试断言同一 fatal 不产生 spawn 风暴；`npm run test`；打包或等价 UI smoke 覆盖首次配置 Codex、旧 CLI + 不兼容 config、升级后刷新恢复三条路径。
- **已落地:** Codex Account 添加卡片不再在请求前关闭弹窗；只有登录启动成功才切换到登录弹窗，失败会在当前 Add Service 弹窗以 `role=alert` 展示后端错误，按钮解除 loading 后可直接重试。targeted source/component guardrail 已通过。

---

#### B-018 macOS 启动 / 新对话时弹 "找不到用于储存 'apple' 的钥匙串" 对话框
- **Issue:** [#501](https://github.com/op7418/CodePilot/issues/501)
- **状态:** 🟡 第二分支 Shipped in v0.66.2；official-signed CI 与 Release 已通过，待旧 ad-hoc 安装首次升级及下一同 Team ID 版本不重复授权验收（2026-08-13）
- **Signal:** v0.50.3 已有用户在启动/新对话时看到 `Cannot find keychain to store 'apple'`；2026-08-05 又收到会话生成阶段的真实截图，文本为“找不到用于储存 `kevinyoung` 的钥匙串”，按钮仅“取消/还原为默认”。用户名随报告者变化，说明它不是固定 service name。
- **更正后的根因:** 旧诊断把弹窗归因于 Chromium 且建议 `password-store=basic`，现已被直接调用链证据推翻。当前 bundled Claude CLI 会在每个 CLI subprocess 启动时以 `process.env.USER || os.userInfo().username` 作为 `-a`，并通过 PATH 调用 `security find-generic-password ... -s 'Claude Code*'` 做两次 eager prefetch；截图中的 `kevinyoung` 正好是该 account 参数。旧报告发生于 CodePilot 引入 `safeStorage` 之前，也排除了 provider secret 是历史主因。v0.65+ 的 Electron `safeStorage` 现在构成第二条可能触发链，需一并前置门控。
- **Fix:** 新增只读 `/usr/bin/security default-keychain -d user` 探测，只解析配置路径并检查文件存在，不读取/解锁/创建/修复任何 credential item。确认 default keychain 缺失、未配置或 probe 失败时：① Electron Main 在进入 `safeStorage` 前跳过 provider DEK 初始化；② packaged Next child 收到脱敏状态码；③ 每个 Claude subprocess 的 PATH 前置 packaged `security` shim。shim 只对 `Claude Code*` service 的 find/add/delete 和无参数 `show-keychain-info` 非交互返回失败，让 Claude 使用已有环境变量/文件 fallback；其余命令以固定 `/usr/bin/security "$@"` 原样转发。健康 keychain 不改 PATH、不改变 OAuth/Provider 行为。复核所有 SDK `query()` 后又关闭一条“偶发”漏口：`CONTEXT_TOO_LONG` 压缩重试原先直接复制 `process.env`，现复用同一 request 已构建的 guarded/provider-isolated env。
- **明确不采用:** 不设置 `password-store=basic`——Chromium 该 switch 的 `basic` backend 是 Linux 路径，不能作为 macOS 修复；不设置 `CLAUDE_CODE_SIMPLE` / `--bare`——它会同时关闭 hooks、插件同步、项目指令发现等正常能力。
- **Verify:** `macos-keychain-guard.test.ts` 覆盖 available/missing/unconfigured/timeout、非 macOS no-op、shim 精确拒绝与 argv 固定转发、bundled Claude CLI 仍经 PATH lookup；`provider-secret-electron-contract.test.ts` 锁定 unavailable 分支在 safeStorage 之前；`electron-packaging-hygiene.test.ts` 锁定资源进包；源码钉禁止 reactive retry 重新使用 raw `process.env`。定向回归 58/58、Tier 1 全量 5131 pass / 0 fail / 1 skip，Electron Main one-shot bundle、targeted ESLint、hook/docs-drift lint 均通过。本机真实 default-keychain probe 为 `available`。维护者未破坏/改写本机钥匙串来制造复现；发布前仍需在报告者或隔离 macOS 账户上做 packaged smoke。
- **可观测性:** Main log 只记录 `default_keychain_*` 原因码；Provider Doctor 增加 `auth.macos-default-keychain-unavailable` warning，不记录用户名、keychain 路径或凭据。系统 modal 本身仍不进入 Sentry。
- **2026-08-12 新 Signal / 根因分支:** 第二台 default keychain 健康的 Mac 出现“使用 `codepilot Safe Storage` 中的机密信息”；本机 recovery smoke 也阻塞在 `SecItemCopyMatching`。复核发现 stable 与两条 preview workflow 都关闭 identity auto discovery 且没有证书 secrets，`after-sign.js` 又静默回退 ad-hoc，因此正式包和测试包都会随每次构建改变 designated requirement（无 Team ID、绑定 CDHash），访问旧 Safe Storage ACL 时触发系统授权。修复改为三条 macOS workflow 必须 Developer ID + exact Team ID，afterSign 和最终 bundle 双层 fail-closed；ad-hoc 仅允许显式本地隔离包。详见 `macos-safe-storage-signing-remediation-2026-08-12.md`。已由旧 ad-hoc 包创建条目的机器首次切换稳定签名仍可能需要一次授权，不承诺无迁移地恢复旧 ACL。
- **2026-08-13 CI 校准:** v0.66.1 stable run 31615349470 没有绕过门禁，但证书 step 同时关闭 auto discovery，导致证书导入后没有 identity selector，electron-builder 跳过签名并由 afterSign 阻断。修复只从三个含 `CSC_LINK` 的签名 step 移除该开关；无证书 build/local ad-hoc 路径继续禁用 discovery。失败 tag 保留且不重建，v0.66.2 作为修正版重跑。
- **2026-08-13 发布证据:** v0.66.2 run [`31616811316`](https://github.com/op7418/CodePilot/actions/runs/31616811316) 的 macOS arm64+x64 Developer ID package、exact Team ID/deep-strict、native ABI、packaged server 与 checksums 全部通过；[Release](https://github.com/op7418/CodePilot/releases/tag/v0.66.2) 已发布 12 个 uploaded assets。发布签名链已闭合，旧 ACL 迁移体验仍按真实受影响机器观察，不以 CI 代替。

---

### P3 — 低优先级

#### B-015 Bridge 斜杠命令不识别
- **Issues:** [#231](https://github.com/op7418/CodePilot/issues/231), [#229](https://github.com/op7418/CodePilot/issues/229)
- **状态:** 🔴 未修复
- **根因:** Bridge 走 SDK `query()`，斜杠命令不被 CLI 处理

#### B-016 Windows 卸载卡住
- **Issue:** [#454](https://github.com/op7418/CodePilot/issues/454)
- **状态:** 🔴 未修复（NSIS 已知问题，非代码 bug）

---

## 二、已修复（归档）

| ID | 问题 | 修复版本 | 关键 commit/文件 |
|----|------|----------|-----------------|
| ~~B-F01~~ | #456 主路径认证死循环 | v0.48.1-v0.48.2 | sdk-runtime.ts 3 轮迭代 |
| ~~B-F02~~ | AI_NoOutputGeneratedError 误报 | v0.48.1 | agent-loop.ts eventCount→hasContent |
| ~~B-F03~~ | 看板 Widget 样式丢失 | v0.48.1 | widget-sanitizer.ts overflow:hidden |
| ~~B-F04~~ | SqliteError FOREIGN KEY | v0.48.1 | db.ts 事务清理 outbound_refs |
| ~~B-F05~~ | Codex API 超时 | v0.48.1 | ai-provider.ts 30s 超时+代理提示 |
| ~~B-F06~~ | #449 Provider test masked key | v0.48.2 | 回填真实 key |
| ~~B-F07~~ | #447 default_provider_id 不生效 | v0.48.2 | resolveProvider 改造 |
| ~~B-F08~~ | #341 CLI 检测失败 | v0.38.4 | findClaudeBinary() |
| ~~B-F09~~ | #343/#346 切换 Provider 崩溃 | v0.38.4 | PATCH 自动清 stale sdk_session_id |
| ~~B-F10~~ | #347 默认模型回退 | v0.38.4 | global default model |
| ~~B-F11~~ | FeatureAnnouncement 重启后重现 | v0.49.0 | DB + localStorage 双写 |
| ~~B-F12~~ | OpenAI OAuth 基础流程 | v0.48.2 | commit 38fe566 |
| ~~B-F13~~ | 长对话中模型"幻觉调用工具"（假 tool_use，文件未动用户却被告知已改）| v0.50.2 | `context-pruner.ts` RECENT_TURNS 6→16 + `[Pruned <toolName> result: <摘录>]` marker |

### B-F13 症状识别（便于未来快速判断类似现象）

**用户可见症状:**
- 长时间任务进行到后段，AI 回复里出现 "I used Bash / Edit / Write..." 等工具调用描述
- 界面把这些文本渲染成了工具卡片样式，但实际**文件没变 / git 没提交 / 命令未执行**
- 用户被迫反复提醒"你都没调用 git"、"文件没改"等；AI 回复一轮通常会"恢复"（真的去执行），但下次长任务又复现

**根因链:**
1. v0.49.0 Hermes 升级把 `context-pruner.ts` 的 `RECENT_TURNS_TO_KEEP` 从 **16 降到 6**
2. 旧 `tool_result` 被替换为裸 `[truncated]` 占位（没有工具名、没有摘录）
3. 长对话中一个工具密集轮次（多个 `tool_use` block）的 `tool_result` 很快被挤出 recent 窗口
4. 模型看到"我曾经调用过什么但看不到结果"的残缺上下文，**开始生成文本形式的"假"工具调用描述**（不是真正的 `tool_use` block）
5. 前端 Markdown/SSE 渲染层会把 `(used Bash: {...})` 这种格式**当成**工具调用卡片展示（尤其是从别的 Agent 回放来的历史），但实际上 `agent-loop` 并未向 Vercel AI SDK 发出 `tool_use` request

**漏洞窗口:** v0.49.0 ~ v0.50.1（含），v0.50.2 恢复 16 轮 + 工具名+200 字摘录的 Pruned marker 后**不再复发**

**未来类似现象的判断清单:**
- 是否 v0.49.0 ~ v0.50.1 区间的用户？→ 引导升级到 0.50.2+
- 仍在 v0.50.2+ 发生？→ 可能是**超长任务导致 recent 16 轮也覆盖不住**，需要考虑把 `tool_use`/`tool_result` 的保留优先级提到最高（永不 prune 配对的 block），或给 UI 加"context 已压缩"告警让用户主动续接
- 相关代码位置: `src/lib/context-pruner.ts:28,52-77`

---

## 三、Feature Requests（按活跃度排序）

| Issue | 描述 | 状态 | 备注 |
|-------|------|------|------|
| [#469](https://github.com/op7418/CodePilot/issues/469) | 一键导入 + 浏览 Claude Code 对话历史 | 🟡 部分满足 | v0.49.0 `codepilot_session_search` 解决了搜索，可视化浏览未做 |
| [#473](https://github.com/op7418/CodePilot/issues/473) | 语音交互 STT/TTS | 📋 待评估 | |
| [#460](https://github.com/op7418/CodePilot/issues/460) | 定时任务 | 📋 待评估 | |
| [#459](https://github.com/op7418/CodePilot/issues/459) | 左侧 UI 采用 Codex 文案风格 | 📋 待评估 | |
| [#458](https://github.com/op7418/CodePilot/issues/458) | 多 OpenAI OAuth 账号 | 📋 待评估 | |
| [#463](https://github.com/op7418/CodePilot/issues/463) | 代码界面可编辑 + 语法高亮 | 🔵 设计如此 | Claude Code 理念：AI 写 100% 代码 |
| [#246](https://github.com/op7418/CodePilot/issues/246) | 应用内自动更新 | 🚧 Mac 已发布；Windows unsigned updater 本地完成、待仓库保护/RC；Linux 延期 | `v0.67.7` 发布证据 + Windows 后续计划。Mac signed updater 已 Shipped；Windows 按用户选择不申请 Microsoft/PFX 签名，GitHub single-trust-root、`latest.yml`/EXE blockmap、差分回退与发布门禁代码已通过本地测试；首版仍需手动 bootstrap，且必须先完成仓库保护和真实 RC-A→RC-B；Linux 保持手动 |
| FR-auto-permission | 自动权限系统：Claude Code / Codex 已支持自动权限；后续 CodePilot 也应支持根据请求内容自动分析并完成审批 | 📋 待设计 | 用户要求记录：自动权限会自动分析内容并完成审批；需定义安全边界、可审计日志、可关闭开关 |
| FR-edit-user-message | 对话编辑：用户停止对话后，可点击自己发出的消息，在“复制”旁增加笔形编辑按钮；编辑后直接再次发送 | 📋 待设计 | 目标是避免复制、粘贴到输入框再发送；需考虑消息重放、后续 assistant 消息处理、队列/停止状态 |
| [#254](https://github.com/op7418/CodePilot/issues/254) | 会话列表待确认状态指示 | 📋 待实现 | |
| [#236](https://github.com/op7418/CodePilot/issues/236) | @ 自动补全文件路径 | 📋 待实现 | |
| [#242](https://github.com/op7418/CodePilot/issues/242) | 多 bot 桥接 | 📋 待实现 | 高复杂度 |
| [#234](https://github.com/op7418/CodePilot/issues/234) | Codex / 多 CLI 后端支持 | 📋 长期规划 | |

---

## 四、Sentry 监控摘要（截至 2026-04-11）

| 错误 | 数量 | 趋势 | 关联 Bug | 状态 |
|------|------|------|----------|------|
| Claude Code process exited with code 1 | 6640x | 既有 | — | 既有问题，量最大 |
| AI_NoOutputGeneratedError | 170x | ↑ | B-002 | 🟡 部分修复 |
| HTTP 404 model not found | 145x | ↑↑ | B-009 | 🔴 |
| No provider credentials | 54x | ↑ | B-001 | 🟡 |
| SqliteError FOREIGN KEY | 40x | 🆕 | — | 🟢 已修复 |
| Controller already closed | 30x | → | B-008 | 🔴 |
| AI_RetryError: chatgpt.com timeout | 15x | 🆕 | — | 🟢 已修复 |
| fetch failed | 11x | 🆕 | — | 网络层 |
| ClaudeCodeCompat 503/500/400 | 9x | ↑ | — | 第三方代理 |
| AI_MissingToolResultsError | 5x | → | — | 🔴 |
| HMAC apikey not found | 4x | → | — | 特定 Provider |

2026-08-07 补充：official 0.65 累计确认 57 条 `AI_MissingToolResultsError`，真实 stack 位于下一轮 AI SDK prompt conversion。未来 terminal 与 legacy history 的配对修复已在 [production-observation-remediation-2026-08-07.md](production-observation-remediation-2026-08-07.md) 落地并有真实 SDK 正/反对照；状态改为 **🟡 Code complete，待新 stable cohort 验证**。上表 5x 保留为 2026-04-11 历史快照，不覆盖历史计数。

---

## 五、流程管理备注

- [#466](https://github.com/op7418/CodePilot/issues/466) 用户建议增加内测版流程，在内部群测试通过后再发布正式版
- 多位用户反馈"来回升级回退太麻烦"，说明发版质量需提升
- 建议：每次发版前至少用 Provider 诊断工具跑一轮第三方 API 场景的端到端测试
