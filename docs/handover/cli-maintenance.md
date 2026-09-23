# CLI Maintenance 技术交接

> 对应产品取舍：[insights/cli-maintenance.md](../insights/cli-maintenance.md)；强制不变量：[guardrails/CliMaintenance.md](../guardrails/CliMaintenance.md)；应用更新交叉边界：[guardrails/Updater.md](../guardrails/Updater.md)

## 目标与当前范围

CodePilot 在启动后检查当前真正选中的 Claude Code / Codex CLI，展示 current version、已证明安装渠道、same-channel latest 和兼容性；有安全 command mapping 时允许一键更新。首版不会自动切渠道、提权或更新不确定目标。Windows Claude native/WinGet 重叠仍是 manual-only；Windows npm `.cmd` 与 Codex standalone 有专门执行路径。

Release Notes 的同批修复位于 `UpdateDialog.tsx`：GitHub Atom HTML 与 Markdown 先解析，再由 strict schema 清洗。远程图片、样式、active content 和非 HTTP(S) 链接被移除。

## 数据流

```text
Renderer (provider enum only)
  → preload cliMaintenance IPC
  → electron/cli-maintenance.ts
      → fresh selected binary + ownership proof
      → same-channel latest probe
      → active-work check
      → install lifecycle latch
      → utility provider lease / Codex idle quiesce
      → second target proof
      → shell=false child runner
      → tree cleanup + invalidate + rediscovery + --version
  → low-cardinality snapshot replay / toast / Runtime Settings
```

Main 是 executor 和状态 owner；utility 只提供 safe-for-same-origin 的 idle/lease/quiesce 语义，绝不接受 command/path/channel。旧 `/api/claude-upgrade` 保留 410 tombstone，避免旧 Renderer bundle 回到不安全执行面。

## 渠道识别与命令

| Provider/channel | latest source | update | 证明失败 |
|---|---|---|---|
| Claude npm | exact npm package | exact manager `install -g ...@latest` | manual-only |
| Claude bun/pnpm | exact package registry | exact proven manager install/add | manual-only |
| Claude Homebrew | exact cask outdated state；named cask 过期时接受可解析的 exit 1 JSON | `brew upgrade --cask claude-code` | parse/process failure 为 unknown/manual-only，不伪装 current |
| Claude native | 无 definite latest，`managed_auto` | exact selected `claude update` | manual-only |
| Claude WinGet/native overlap | 无 | 无首版 one-click | `manual_check` |
| Codex npm/bun/pnpm | exact package registry | exact selected package bin `codex update` | manual-only；exit 0 同版本为 unchanged |
| Codex Homebrew | exact cask state；named cask 过期时接受可解析的 exit 1 JSON | `brew upgrade --cask codex` | parse/process failure 为 unknown/manual-only，不伪装 current |
| Codex standalone | official release | exact selected `codex update` | manual recovery |
| Codex desktop bundle | 无独立 latest；随 ChatGPT/Codex Desktop 更新 | 无 CLI 一键更新 | `managed_auto`，Settings 说明 owner app；不与 standalone release 比较 |

Windows package-manager shim 不通过 `shell=true` 执行。Main 读取已证明 package 的 `package.json#bin`，用真实 Node executable + argv 启动脚本；路径中的空格或元字符不进入 shell 解析。

macOS 的任意 `*.app/Contents/**/codex`，以及 Windows Store/alias、已知 ChatGPT/Codex desktop `Resources/**` 内 binary 必须先于通用 standalone 文件形状识别。Runtime discovery 与 maintenance 复用 `isCodexDesktopManagedPath()`，避免一侧随布局演进而另一侧重新误判；Windows 官方 standalone `.../OpenAI/Codex/bin/codex.exe` 是固定反例。CodePilot 不改写 owner app、也不把 public standalone release 当作其可执行更新目标。

## 生命周期与恢复

- 一次只允许一个 CLI update active。`performUpdate` 在第一个 await 前同步占 starting slot 与 `install-lifecycle-coordinator`；latch 对同 owner 也不可重入，避免两个 UI 入口覆盖 active operation 或提前释放另一条安装。app updater 和 CLI updater 竞争同一 latch。
- utility lease TTL 15 秒、Main 每 5 秒 heartbeat。Claude SDK query 与 Codex app-server spawn 在真正启动前检查 gate。
- packaged utility recovery 前，Main 把 active provider + opaque lease id 注入 fork 环境；新 utility 首次 import 即恢复 gate，server healthy 后马上 reconcile。
- cancel/timeout 在 Unix 杀独立 process group，在 Windows `taskkill /T /F`。所有运行后终态均重新发现实际 CLI；raw output 只在 Main 内做低基数分类。
- 普通 quit 遇到 CLI update 默认继续等待；“取消并退出”最多等 10 秒清理；只有用户明确选 Force Quit 才接受半更新风险。

## UI 与状态

`useCliMaintenanceChecker()` 是 background check owner，Main snapshot 可跨 Renderer reload 重放。提醒用 `provider + latestVersion` 做 dismissal key；左下紧凑卡片只有 available 态用户手动关闭才写 dismissal，未操作时保持显示。卡片按 Provider 使用 Anthropic/OpenAI brand，显示 current→latest、简短兼容性说明、与正文左对齐的 primary 更新按钮；关闭按钮浮在右上角，不参与正文列布局，并有清晰的 hover/focus。点击更新后原卡片使用 spinner（当前没有可信百分比源）并临时禁用关闭，避免静默隐藏仍在执行的安装。多 Provider 更新记录已成功项，失败后的 Retry 只执行未完成 Provider；失败关闭不写版本 dismissal，成功 post-verify 后清通知 key、显示完成 2.5 秒再消失。Renderer locale 初始化变化会更新原卡片而非保留错误语言；CLI maintenance 新文案统一来自 en/zh i18n 表，`0.0.0` 等占位版本不得进入 UI。没有真实 latest 的 `managed_auto/manual_check` 只在 Runtime Settings 展示，不冒充“发现新版”。Claude 的旧 ConnectionStatus 和 RuntimePanel 更新按钮均已迁移到同一 context，Codex 使用同构行。

## 验证与未完成项

本地已有 semver/lease/latch、Windows channel fixtures、IPC 安全、Atom HTML sanitize、真实 child→grandchild cleanup 测试。`npm run test` 已通过；production build 与本地 UI smoke 应在当次执行计划中记录。

仍需要 Windows clean VM 的 npm.cmd、Claude WinGet lock、Codex standalone/AV 失败和 macOS disposable CLI before→after smoke。未跑平台不得写成 Smoke passed；Main crash、OS kill、断电仍可能绕过应用内 latch。
