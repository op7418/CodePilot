# 清理收尾与依赖升级

> 创建：2026-11-20

## 用户会看到什么

- 应用行为不变。安全问题和已知漏洞依赖被修掉，修改 MCP 配置后不用重启就生效。
- 仓库里不再有没人用的代码、路由、依赖和过时的 GitHub 文案。

验收：每个工作包结束时 `npm run test` 全绿；涉及 Electron、打包、更新器的工作包另外要打一次本机包并启动。

不做：新功能、无关重构、发版。不 push、不打 tag。

## 分工

主会话负责拆任务、写指令、审查 diff；实际修改交给 subagent。每个工作包单独一个 commit，方便回退。工作包之间按下面的顺序做，同一时间只跑一个会改代码的 subagent。

| 工作包 | 内容 | 建议执行者 | 状态 |
|---|---|---|---|
| WP1 | 三处实际缺陷：上传路由路径检查、MCP 连接管理、定时任务并发 | Opus | 完成 |
| WP2 | 依赖：lock 同步、漏洞修复、删无用依赖 | Opus | 待开始 |
| WP3 | Node 与 Electron 大版本升级 | Opus | 待开始 |
| WP4 | 第二轮死代码：路由、IPC、模块、`资料/` | Gemini | 待开始 |
| WP5 | GitHub 模板与工作流的过时口径 | Gemini | 待开始 |
| WP6 | 永久跳过的 E2E 用例 | Gemini | 待开始 |
| WP7 | 设置页内联中英文迁到 i18n 字典 | Gemini | 待开始 |
| WP8 | `docs/research/` 与 `docs/guardrails/` 按新标准分流 | Opus | 待开始 |

## 本机环境注意

- 本机默认 Node 是 25，项目 CI 是 20。`better-sqlite3` 已按 Node 25 重编译；切换 Node 版本后要 `npm rebuild better-sqlite3`，否则约 700 个测试报 `database_unavailable`。
- `npm ci` 目前失败（lock 缺 7 个条目），WP2 第一步修。在那之前用 `npm install` 后还原 lock。
- 全量 `npm run test` 约 5 分钟。

## WP1 两处缺陷

### 1a `/api/uploads` 路径检查

`src/app/api/uploads/route.ts` 用 `resolved.includes('.codepilot-uploads')` 判断是否放行。这是子串匹配，`/x/.codepilot-uploads-evil/secret` 也能通过，符号链接也没处理。

改法：
- 把路径按分隔符拆段，要求某一段**完全等于** `.codepilot-uploads`、`.codepilot-media` 或 `.codepilot-images`。
- 对文件做 realpath，再检查 realpath 仍在同一个允许目录的 realpath 之下。仓库里已有 `assertRealPathInBase`（见 `src/lib/files.ts`），复用它，不要新写一套。
- 先读 `src/app/api/media/serve/route.ts` 看它怎么限制目录，保持同一风格。

测试：新增单测覆盖正常文件、名字相近的兄弟目录、`..` 逃逸、指向目录外的符号链接。后三种必须 403。

### 1b MCP 连接管理

`src/lib/mcp-connection-manager.ts` 的 `syncMcpConnections` 有三个问题：

1. 只按名字比较，配置（命令、参数、环境变量、URL）改了不会重连。
2. 状态为 `failed` 的 server 每次同步都重试，而 `agent-loop.ts` 每轮对话都调同步，等于每条消息都重新拉一次失败的进程。
3. `connectServer` 失败时 transport 没有关闭，stdio 子进程可能泄漏。

改法：
- 连接上记录配置的稳定序列化结果，同步时不同就先断开再连。
- 失败的 server 记录失败时间，冷却期内不重试（建议 60 秒）；配置变了立即重试；`reconnectServer` 这类用户主动操作不受冷却限制。
- 失败路径里关闭 transport。

先读 `docs/guardrails/MCP.md`。它目前是占位稿，改完后把这三条写进不变量表并填上对应测试。

测试：配置变更触发重连、冷却期内不重试、冷却后重试、配置变更绕过冷却、失败后 transport 被关闭。

### 1c 定时任务并发

`src/lib/task-scheduler.ts` 的轮询和 `handleMissedTasks` 会把所有到期任务同时发出去。加一个并发上限（建议 2），其余排到下一轮。行级锁 `last_status != 'running'` 的现有语义不要动。

## WP2 依赖

顺序固定，每步跑一次 `npm run test`：

1. **同步 lock**：`npm install` 让 lock 与 `package.json` 一致，确认之后 `npm ci` 能跑。检查 diff 里没有意外的大版本变化。
2. **删无用依赖**。下面这些全仓库没有 import，删之前每个再 grep 一次确认：
   - 直接删：`uuid`、`jdenticon`、`pngjs`、`morphdom`、`dompurify`、`html-to-image`、`@google/genai`，以及 `@types/pngjs`、`@types/dompurify`、`@types/morphdom`、`@types/uuid`
   - 核实后删：`@codemirror/lang-yaml`、`@lezer/markdown`、`@radix-ui/react-use-controllable-state`、`@streamdown/code`、`ansi-to-react`、`lucide-react`（`SandpackPreview.tsx` 里只是给沙箱的字符串，不是本地 import）
   - 不要删：`zlib-sync`（discord.js 的可选依赖）、`husky`、`tailwindcss`、`tw-animate-css`、`@sentry/cli`、`material-icon-theme`（配置或脚本在用，工具识别不出来）
   - `@types/qrcode` 从 dependencies 挪到 devDependencies
   - `package.json` 的 workspaces 里 `packages/*` 目录不存在，删掉
3. **补上没声明的依赖**：代码直接 import 了 `zod`、`@ai-sdk/provider`、`@modelcontextprotocol/sdk`、`undici`、`unified`、`mermaid`、`postcss`，但 `package.json` 没列，靠别的包间接带进来。按 lock 里当前解析到的版本显式声明，不要顺手升级。
4. **漏洞修复**：`npm audit` 当前 94 条（6 critical、47 high）。先跑 `npm audit fix`（不带 `--force`），只接受不跨大版本的修复。然后逐个处理剩下的 critical 和直接依赖的 high：
   - `next`（Server Components 拒绝服务）：升到 16.x 最新补丁。`npm audit` 建议的 15.5.29 是给 `apps/site` 的，主应用不要降级。
   - `js-yaml`、`markdown-it`、`nanoid`、`ws`、`@larksuiteoapi/node-sdk`、`concurrently`、`shadcn`：升到同一大版本内的修复版。
   - `electron-builder` 26.18.0、`electron-updater` 6.8.11：这两个是精确版本锁定，并且有测试钉住版本号（搜 `release-trust`）。先读 `docs/guardrails/Updater.md` 和 `Release.md`，版本号、测试、`docs/rules/release.md` 三处一起改。
   - `electron` 留给 WP3。
5. 新装或升级的版本要求发布满 7 天。

这个工作包改了打包相关依赖，结束时要 `npm run electron:pack:mac` 打一次包并启动确认能进主界面。

## WP3 Node 与 Electron

- **Node**：Node 20 已在 2026 年 4 月停止维护。目标版本取 Electron 目标版本内置的 Node 大版本，不要单独挑。要改的地方：所有 workflow 的 `node-version`、`package.json` 加 `engines`、`@types/node`、三份 README 的环境要求。Windows runner 钉在 `windows-2022` 的原因是 node-gyp 编译问题（tech-debt #44），升 Node 后要确认这条是否还成立。
- **Electron** 40 → 45：跨 5 个大版本，逐个读 breaking changes，不要直接跳。重点核对 `electron/` 里用到的 API：`utilityProcess`、`safeStorage`、`Notification`、`webContents` 权限处理、`<webview>` 附加校验、`vibrancy`。`scripts/after-pack.js` 会按 Electron ABI 重编译 `better-sqlite3`，确认新 ABI 有对应产物。
- 先读 `docs/guardrails/ElectronMain.md`。
- 验证：`npm run test`、本机打包并启动、`npm run test:smoke`。Windows 和 Linux 的包本机验证不了，在提交说明里写明，留给 CI。

这是整个计划里风险最高的一步，单独一个 commit，出问题直接回退。

## WP4 第二轮死代码

每一项都按同一个办法确认：在 `src/`、`electron/`、`scripts/` 里搜调用方。只有测试在用的，连测试一起删。搜不干净的不删，记下来。

- **API 路由**（疑似无调用方）：
  - `src/app/api/plugins/route.ts` 和 `plugins/[id]/route.ts`
  - `bridge/channels`、`settings/weixin`
  - `workspace/checkin`、`workspace/onboarding`、`workspace/latest-session`、`workspace/search`
  - `tasks/notify` 的 POST，`tasks/route.ts` 的 POST 和 PUT
  - `assets/[id]/restore`（回收站界面已取消，只剩测试在调）
  - `media/[id]/tags`（只剩 `asset-library-api.test.ts` 在调）
  - `chat/sessions/[id]/handoff` 和 `harness-home/*` 五个路由：**不要删**，对应功能还在 `active/` 计划里，只确认并记录现状
- **页面**：`src/app/extensions/page.tsx` 是跳到另一个跳转页的跳转页，没有入口链接。
- **Electron IPC**：`bridge:is-active` 和 `proxy:resolve`，主进程、preload、类型声明三处一起删。
- **模块**：`src/lib/subdirectory-hint-tracker.ts` 及其测试；`assistant-workspace.ts` 的 `needsDailyCheckIn` 别名（三个测试改用 `shouldRunHeartbeat`）；`codex/provider-proxy.ts` 的 `buildCodexThreadStartParams` 别名；`codex/proxy/builtin-event-bus.ts` 转发壳（两处 import 改指 `@/lib/harness/builtin-event-bus`）。
- **i18n**：上一轮删掉的组件留下的孤儿键，例如 `nav.extensions`、`nav.bridge`、`nav.cliTools`。代码里有大量 `as TranslationKey` 的动态拼接，删键之前必须搜前缀。这些前缀是动态使用的，不要动：`update.error.`、`fileIO.errors.`、`messageInput.effort.`、`message.streamStatus.`、`subagent.details.`。
- **仓库文件**：`资料/` 整个目录取消跟踪并加入 `.gitignore`（第三方包解包件，代码零引用；本地文件保留）；`CHANGELOG.md`（停在 0.38.4，无人读取）；`scripts/github-issue-backlog-audit.mjs`。
- `src/__tests__/helpers.ts` 里指向 `svg.lucide-*` 的选择器已经匹配不到任何东西，连同没人调用的旧别名一起清掉。

## WP5 GitHub 模板与工作流

现在的文案还在说"v0.56.x 稳定期，新功能暂停"，当前版本是 0.67。

- issue 模板、PR 模板、`TRIAGE.md`：去掉冻结期的说法，保留分级和复现信息要求。
- `issue-intake.yml`、`stale-needs-repro.yml`：评论里写死的"v0.56.2+"改成不带具体版本号的说法。
- `release-blocker-check.yml`：milestone 名字写死成了 `v0.56.x Stability / Trust`，改成输入参数。
- `preview-release.yml` 生成的说明里"from the refactor branch"已不成立。
- 标签名（如 `v0.57+ parking-lot`）是 GitHub 上已存在的对象，**不要改名**，只在提交说明里列出，由仓库所有者决定。
- workflow 里的 action 必须保持 40 位 commit SHA 固定，不要改成 tag。

## WP6 永久跳过的 E2E

约 30 个用例和 7 个 describe 块被 `skip`，选择器指向旧界面（`.is-assistant`、lucide 图标类名）。逐个文件处理：界面还在的，把选择器改对并取消 skip；功能已经不存在的，删掉用例。需要 `npm run test:e2e` 验证。

读源码文本做断言的单测（约 27 个文件）这次不批量改，只在对应文件被删或重写时顺手处理。

## WP7 设置页内联文案

`src/components` 里有 161 处 `isZh ? '中文' : 'English'`，没走 `src/i18n/` 的字典。按文件迁移，一个文件一个 commit：`ModelsSection.tsx`、`RuntimePanel.tsx`、`ProviderManager.tsx`、`HealthSection.tsx`，然后是其余。

先读 `docs/guardrails/i18n.md`。文案内容一个字都不改，只挪位置；键名跟随所在文件已有的前缀。

## WP8 文档分流

标准见根目录 `AGENTS.md`：只留代码里读不出来的东西。

- `docs/research/`：竞品调研、上游协议和 SDK 行为、POC 实测留下。模型和服务商适配记录里的**事实**（模型 ID、上下文长度、推理档位、计费、接口差异）先并入 `docs/external-facts.md` 并标日期，然后删原文。对本项目代码的审计、诊断、复审、已执行完的设计稿删除。
- `docs/guardrails/`：保留"不能破坏什么"和"为什么不那样做"。"关键文件 + 责任"表会随代码过期，删掉；先核对每份里引用的源文件是否还存在。
- `docs/exec-plans/active/` 里 `v0.56.x-stability-trust`、`codex-stop-recovery`、`mimo-ultraspeed-openai-compatible-provider` 三份看着已过期，对照代码确认做完了就删。

## 决策日志

- 2026-11-20：第一轮清理完成（未提交）。删除 handover 目录、`ARCHITECTURE.md`、45 个无引用源文件、6 个无调用路由；修复 `stopScheduler`。全量单测 5698 通过。
- 2026-11-20：`media/[id]/tags` 路由曾被误判为无调用方，实际有测试在用，已恢复，归入 WP4 重新判断。
- 2026-11-20：WP1 完成。上传目录挂在各会话工作目录下，没有单一根目录，所以取路径里最内层的允许目录段（不含文件名本身）作为 `assertRealPathInBase` 的 base。MCP 冷却期 60 秒；额外处理了 toggle 路由对已连接 server 再次 `connectServer` 时旧 client 不关闭的泄漏。定时任务上限 2 只作用于轮询和启动补跑，手动"立即运行"不计入也不受限；补跑通知仍对所有错过的任务立即发出，超出上限的任务在之后的轮询（10 秒一次）里执行。
