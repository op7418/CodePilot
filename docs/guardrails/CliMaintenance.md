# CLI Maintenance Guardrail

> **Status: Active contract** — 覆盖 Claude Code / Codex CLI 检测、更新提醒、一键更新、Runtime maintenance lease、进程回收和应用生命周期互斥。
> **为什么先读**：这里会执行用户机器上的包管理器或供应商 self-updater。渠道猜错、target 漂移或退出竞态都可能更新错安装，甚至留下半写入的 CLI。

## 1. 词汇表

- **selected binary**：CodePilot 当前 Runtime 解析后真正会执行的 Claude/Codex CLI；不是 PATH 上任意同名文件。
- **ownership proof**：selected binary/realpath/shim 与 npm、bun、pnpm package root 或 Homebrew exact cask 的对应证明。
- **same-channel advisory**：latest 只来自当前已证明渠道；npm registry 不代表 Homebrew、WinGet 或 native 已同步。
- **maintenance lease**：utility 内 provider-scoped、带 TTL 的启动栅栏；更新、清理和 post-verify 全窗口拒绝新的目标 Runtime spawn。
- **install lifecycle latch**：Main 内 app updater 与 CLI updater 竞争的单一排他 owner。
- **post-verify**：无论命令 exit code 如何，都 invalidate、重新发现 selected binary 并读取实际 `--version`。

## 2. 不变量 / 契约表

| # | 契约 |
|---|---|
| CLIM-01 | Renderer 的 IPC 只能传 `provider='claude'|'codex'`；path、installType、command、args、shell、package、registry/feed URL 全由 Main fresh resolve。旧 `/api/claude-upgrade` 永久保持非执行 tombstone。 |
| CLIM-02 | channel path 只是候选证据。npm/bun/pnpm 必须对齐 package root 与 package `bin`；Windows `.cmd`/PowerShell shim 必须读出它确实指向该 package。Homebrew 必须命中 exact cask prefix。证明失败即 ambiguous/unknown、`canOneClickUpdate=false`。 |
| CLIM-03 | Claude Windows native 与 WinGet 共用布局而无法唯一归属时保持 ambiguous/manual-only；`winget list` 只证明包存在，不能证明 selected binary 归它。禁止为了多一个按钮更新 PATH 中另一份 CLI。 |
| CLIM-04 | latest 必须与渠道一致：npm/bun/pnpm 查 exact package；Homebrew 查 exact cask；Codex standalone 查官方 release；Claude native 为 `managed_auto`。ChatGPT/Codex Desktop bundle 必须在通用无扩展名/`.exe` standalone 判断前识别为 `desktop_bundle`，latest=null、`managed_auto`、无一键 CLI 更新；macOS 任意 `.app/Contents/**`、Windows Store/alias 及已知 ChatGPT/Codex desktop `Resources/**` 布局均视为 owner-app managed，不能依赖当前单一文件位置。`brew outdated <named-cask> --json=v2` 在 cask 过期时会以 1 退出，exit 0/1 只有 stdout 可解析且命中 exact cask/空集合时才是有效事实；其他退出、超时或解析失败一律 latest=null/unknown，不能回退 current 伪装“已是最新”。 |
| CLIM-05 | 更新命令 allowlist 固定、`shell=false`、输出 64 KiB hard cap、probe 5 秒、update 5 分钟。Windows `.cmd` 解析到受证明 package 的 Node script，不拼 shell 字符串、不自动提权、不切换安装渠道。 |
| CLIM-06 | update 前先查 chat/bridge/task、获取 Main latch 和 utility lease，再做第二次 target proof。binary、channel、package bin 或 update executable 任一漂移都返回 `update_target_mismatch`，不能复用旧 proof。 |
| CLIM-07 | lease 从 command spawn 前持续到进程树清理、cache invalidation 和 post-verify 结束；Claude SDK query 与 Codex app-server spawn 必须在真正启动前检查 gate。TTL/heartbeat/release 均幂等，stale lease 不得永久阻断。 |
| CLIM-08 | utility recovery 时 Main 把当前 provider+opaque lease id 注入新 utility 环境，使首次 Runtime import 已 fail closed；server healthy 后立即 heartbeat/reconcile。恢复失败必须取消更新，不能无 gate 继续安装。 |
| CLIM-09 | cancel/timeout 回收本次 child 的完整进程树：Unix 使用独立 process group，Windows 使用 `taskkill /T /F`。clean exit 0 但 before=after、未达到已知 target 或 binary/version 消失都不能报 succeeded。 |
| CLIM-10 | CLI updater 与 app updater 竞争同一个 Main latch。CLI `performUpdate` 的 duplicate guard、`startingOperation` 占位和 latch acquire 必须在第一个 await 前完成；latch 对同 owner 也严格不可重入，owner 名不能充当 operation token。CLI running 时 app update 保持 downloaded/retryable 并返回 `cli_update_running`；app installing/quitting 时 CLI child 不启动。普通 quit 默认等待，取消后等 cleanup+post-verify；force quit 必须由用户明确选择并提示损坏风险。详见 `Updater.md` UP-06。 |
| CLIM-11 | IPC/snapshot/log/Sentry 不含 absolute path、command、raw stdout/stderr、环境变量或 registry query；只允许 provider/channel/phase/errorCode、before/after semver 等低基数字段。expected network/permission/lock/active-work 不生成 Issue。 |
| CLIM-12 | Settings 与启动提醒消费同一 Main snapshot。一次提醒以 provider+真实 target version 去重；左下更新卡片在用户未操作时不得定时消失，只有 available 态手动关闭才记录同版本 dismissal。卡片必须使用对应 Claude/Codex brand、紧凑宽度、current→latest、简短说明、与文案左对齐的 primary action，以及至少 28px 且有明确 hover/focus 的右上角浮层关闭按钮；关闭按钮不得独占内容列或挤压正文。更新中无可信百分比时显示 spinner 并禁用关闭；多 Provider 失败重试只执行未完成项；失败关闭不写版本 dismissal，post-verify 成功后清 notification key，才允许短暂显示完成并自动消失。below-minimum compatibility 与 latest advisory 分开，unknown/`0.0.0` 不补假版本或假支持状态。 |

## 3. 关键文件 + 责任

- `electron/cli-maintenance.ts`：Main 状态机、target proof、same-channel probe、IPC、lease 心跳、post-verify。
- `electron/cli-maintenance-runner.ts`：无 shell 的 bounded child runner 与进程树 finalizer。
- `electron/install-lifecycle-coordinator.ts`：CLI updater / app updater 单一排他 owner。
- `src/lib/cli-maintenance-contract.ts`：Renderer 可见 snapshot 与 semver 合同。
- `src/lib/cli-install-channel.ts`：path evidence；不能单独授予 one-click。
- `src/lib/cli-maintenance-lease.ts`、`/api/cli-maintenance/lease`：utility gate、TTL、idle recheck、Codex quiesce。
- `src/hooks/useCliMaintenance.ts`、`CliMaintenanceRow.tsx`：snapshot replay、提醒、Settings 诚实展示。
- `electron/main.ts`、`electron/updater.ts`：utility recovery bootstrap、quit coordinator、双向 lifecycle latch。

## 4. 改动检查表

- [ ] Renderer/preload 是否仍只有 provider enum，没有新增 path/channel/command 控制面？
- [ ] 新渠道是否同时有 ownership 正反例、same-channel latest 和 exact update mapping？缺任一项是否 fail closed？
- [ ] Windows shim 是否验证 package 指向，而非仅凭同目录或 realpath？
- [ ] update 前后二次 target identity 是否包含 version/update executable，而非只有同名 path？
- [ ] 新增 Claude/Codex spawn 入口是否在真正 spawn 前检查 provider lease？
- [ ] utility recovery 是否在 Renderer/后台任务恢复前 bootstrap/reconcile gate？
- [ ] success/nonzero/timeout/cancel/cleanup error 是否全部执行 post-verify？
- [ ] app updater install、普通 quit 与 CLI update 是否仍走同一个 lifecycle coordinator？
- [ ] UI 是否隐藏无 source 的 latest、不给 ambiguous 渠道假一键更新？
- [ ] raw output/path/env 是否只留在短生命周期 Main 内存，未进入 IPC/log/Sentry？

## 5. 常见坑

- `winget list --id`、PATH 命中或目录名像 npm 都不是 selected-target ownership proof。
- Windows npm shim 不是 symlink；realpath 不穿透不能直接判 unknown，也不能只凭 prefix 同目录判 proven。
- macOS 任意 `.app/Contents/**/codex`，以及 Windows Store/alias、ChatGPT/Codex desktop `Resources/**/codex.exe` 都由桌面应用管理；文件形状像 standalone 或未来移动了子目录，也不能调用 `codex update` 或拿 standalone release 制造提醒。Windows 官方 standalone `.../OpenAI/Codex/bin/codex.exe` 必须保留为独立渠道反例。
- package manager exit 0 不代表更新成功；Codex 可能只提示改用 npm，最终必须看 selected binary 的 after version。
- Homebrew named cask 有更新时 `brew outdated` 的 exit 1 是结构化结果，不是普通命令失败；但不能因此接受任意 exit 1，stdout JSON、exact cask 与版本必须同时成立。
- lifecycle owner 是子系统标签，不是锁 token；允许同 owner 重入会让先结束的一次提前释放另一条仍在运行的安装。
- `clearInterval()` 不会取消已在飞的 heartbeat；finalizer 要等在飞 reconcile 收口后再 release，避免 release 后又重建 stale lease。
- cancel 可能发生在二次 proof 阶段；必须记录 cancel intent，不能因为 child 尚未 spawn 就丢掉取消。
- 一次 active-work snapshot 只解决准入当下；执行期必须依赖 provider lease，应用安装互斥必须依赖 Main latch。

## 6. 测试覆盖

- `cli-maintenance-contract.test.ts`：semver、Homebrew exit-0/1 JSON、lease competitor/TTL/recovery bootstrap、Main lifecycle same-owner 非重入、multi-provider retry remainder。
- `cli-maintenance-concurrency.test.ts`：真实 `performUpdate` 同/异 Provider 并发入口；第二次不得触达 activity/target，且第一次结束前 latch 保持占用。
- `cli-install-channel.test.ts`：macOS 任意 bundle 子目录/realpath、Windows Store/alias/desktop Resources、独立 standalone 正例、Windows `.cmd`、WinGet/native ambiguity、跨平台 root containment。
- `cli-maintenance-runner.test.ts`：output cap 与真实 child→grandchild cancel cleanup。
- `cli-maintenance-security.test.ts`：Main/preload/Renderer 窄边界、旧 route tombstone、lease/latch/recovery source contract、无敏感 snapshot 字段。
- `release-notes-rendering.test.ts`：Atom HTML/Markdown 与 XSS/追踪反例。
- 完整门禁：`npm run test`、`npm run build`；真实渠道仍需 disposable macOS 与 Windows clean VM smoke，不能用单元测试冒充。

## 7. 设计决策日志

- 2026-08-28：采用 Main-owned executor，原因是 child 不随 utility recovery 被杀、状态可跨 Renderer reload 重放，并能与 app updater/quit 共用 latch；loopback same-origin 不视为 Main 身份。
- 2026-08-28：Windows Claude WinGet/native 重叠无法唯一证明时选择 manual-only；安全更新错目标的风险高于少一个一键按钮。
- 2026-08-28：全局仅允许一个 CLI update active，作为首版比 target/manager 并行更保守；未来若增加排队，排队期间不得提前占用 app lifecycle latch。
- 2026-08-28：utility recovery 使用 fork 前环境 bootstrap + healthy 后 reconcile，关闭 heartbeat 周期内新 Runtime 抢跑的窗口；opaque id 不是执行能力。
- 2026-08-28：更新提醒改为左下持久卡片；generic toast FIFO 不得驱逐 persistent card，只有成功终态可以把它转为短时自动消失。
- 2026-08-28：真实 Electron 截图验收后，卡片从 generic toast 排版改为独立紧凑布局；加入 Provider brand、primary button、大 hover target、说明文案和 locale/placeholder-version 修正。
- 2026-08-28：按现场视觉反馈，更新 action 与正文左对齐；关闭按钮改为卡片右上角绝对定位，不再作为第三列挤压内容。
- 2026-08-28：Claude Round 2 发现 `performUpdate` 在三段 await 后才占位且 lifecycle owner 可同名重入。入口现于首个 await 前同步占 `startingOperation` + strict non-reentrant latch；Homebrew named-cask exit 1 JSON 被视为有效 outdated 事实，其他失败归 unknown。更新中卡片不可关闭，Retry 只跑未完成 Provider，成功清 notification key；新增文案全部进入 en/zh i18n 表。
- 2026-08-29：现场发现 Runtime 已把 `/Applications/ChatGPT.app/Contents/Resources/codex` 识别为 `desktop_bundle`，CLI maintenance 却按“无扩展名”误判为 proven standalone。桌面 bundle 现作为 owner-app managed 渠道 fail closed：不查 standalone latest、不执行 `codex update`、不生成更新卡片。
- 2026-08-29：accepted 复审指出 exact `Resources/codex` 会在未来 bundle 布局漂移时重新 fail-open。macOS 已收紧为任意 `.app/Contents/**`；Windows 统一复用 Store/alias 与已知 ChatGPT/Codex desktop Resources owner proof，同时以官方 `.../OpenAI/Codex/bin` fixture 防止误伤 standalone。
