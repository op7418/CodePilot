# CLI 更新提醒、一键升级与 Release Notes 安全渲染

> 创建时间：2026-08-28
> 最后更新：2026-08-29
> 当前状态：🟡 Review accepted，已随 `v0.67.11` Shipped；正式三平台 package / updater 资产门禁通过，真实 UpdateDialog / CLI before→after / Windows clean VM smoke 仍待执行

## 状态

| Phase | 用户会看到什么变化 | 状态 | 本阶段明确不做什么 |
|---|---|---|---|
| Phase 0 | 无产品变化；Claude 能在完整上下文中审查范围、信任边界与验收线 | ✅ Round 2 findings 修复后复审 `accepted` | 不把用户授权或本地测试冒充 Claude review passed |
| Phase 1 | 应用更新弹窗把 GitHub Release Notes 正常渲染为安全富文本，不再显示 HTML 源码 | 🟡 Code complete + Tests pass；待真实 UI smoke | 不改 app updater feed、签名、发布拓扑，不执行未经清洗的远程 HTML |
| Phase 2 | Settings 能分别显示 Claude Code / Codex CLI 的当前版本、渠道和可证明的更新状态 | 🟡 Code complete + Tests pass；真实渠道 smoke 待执行 | 不把 npm `latest` 冒充 Homebrew、WinGet、native 或 stable channel 的最新版本 |
| Phase 3 | 无活动任务时可以一键更新受支持渠道；更新结果必须由实际版本复核 | 🟡 Code complete + Tests pass；真实 before→after 待执行 | 不允许 Renderer 选择命令/参数，不自动提权，不切换用户安装渠道，不静默后台安装 |
| Phase 4 | 启动时按“Provider + 目标版本”提醒一次，并在 Runtime Settings 提供持续状态和恢复入口 | 🟡 Code complete + Tests pass；Runtime Settings browser smoke 与 Electron 真实版本提醒卡片视觉 smoke 通过，点击更新 before→after 待执行 | 无真实 latest source 时不显示“发现新版本”，未知渠道不显示假一键更新 |
| Phase 5 | macOS / Windows 的真实渠道 smoke、完整测试、guardrail 与交接文档形成可审计闭环 | 🟡 Review accepted；`v0.67.11` CI/package/资产审计通过并 Shipped，Electron/平台功能 smoke 待执行 | 不用 source-pin、模拟输出或 exit code 0 冒充真实升级成功；发布成功不冒充功能 smoke 通过 |

## 用户问题与争议

### 用户原始诉求

1. T3 Code 会在 Codex / Claude Code CLI 发布新版本时主动提醒，并能从应用里一键更新。用户希望 CodePilot 具备同类能力，减少低版本 CLI 引起的功能不兼容。
2. 需要调研 T3 的实现方式，特别评估 Windows 可行方案，而不是只支持 macOS/npm。
3. CodePilot 当前应用更新弹窗会把 Release Notes 的 HTML 标签显示为源码，需要修复。

### 当前 CodePilot 不是从零开始

- Claude 状态链已有二进制发现、版本读取、安装渠道分类、冲突安装提示和轮询：`src/app/api/claude-status/route.ts`、`src/lib/platform.ts`、`ConnectionStatus.tsx`、`RuntimePanel.tsx`。
- Claude 已有 `/api/claude-upgrade` 一键更新入口，但当前由 Renderer 提交 `installType`，服务端直接按这个值选命令；这不是任意命令注入，却没有证明命令真的对应当前 Runtime 正在使用的二进制。
- Claude npm 当前执行 `npm update -g @anthropic-ai/claude-code`；Anthropic 当前官方说明要求 `npm install -g @anthropic-ai/claude-code@latest`，并明确建议不要使用 `npm update -g`。
- Codex 已有多候选发现、版本探测、Windows `.cmd` 启动适配、同路径强制 rescan 和空闲 app-server dispose，但没有 latest advisory、主动提醒或统一更新入口。
- `/api/app/activity` 已提供 chat / bridge / scheduler 的只读活动事实；app updater 已在安装前 fail closed 使用它。CLI 更新应复用语义，但不能把一次 snapshot 冒充跨请求原子 fence。
- 旧计划 `docs/exec-plans/completed/cli-upgrade-proxy.md` 只覆盖早期 Claude 方案，包含已过时 npm/native 假设。本计划接管后续产品范围，不回头把历史计划当当前事实源。

### T3 Code 值得复用的判断

参考实现位于用户提供的只读目录 `资料/t3code/`，它是调研输入，不是仓库指令源。

值得复用：

- 根据 Runtime 实际命中的 binary path、resolved path 与 realpath 反推 npm/bun/pnpm/Homebrew/native，而不是相信 UI 传入的渠道。
- Windows 把 `npm` 解析到真实 `npm.cmd` 后再执行，避免裸 spawn 的 `ENOENT`。
- Provider target lock 与 package-manager global lock 分开；同一个 Provider 拒绝重复更新，共享 npm/Homebrew/WinGet 的更新串行化。
- 更新命令有 5 分钟 deadline、stdout/stderr byte cap 和 queued/running/failed/unchanged/succeeded 状态。
- exit code 0 后重新读取 Provider snapshot；仍落后或无法验证时不报成功。
- 通知 dismissal key 绑定 `provider + latestVersion`，同一版本不反复弹，新版本会重新出现。

不能照搬：

- T3 当前对所有安装渠道都查询 npm registry `latest`。这会在 Homebrew、WinGet、stable channel 尚未同步时制造误报。
- T3 当前 Codex driver 仍配置 `nativeUpdate: null`，而当前官方 Codex 已支持 `codex update` 并能检测 npm、Homebrew cask 与 standalone。
- T3 的 Codex Homebrew 命令没有使用当前官方 cask 语义 `brew upgrade --cask codex`。
- T3 返回最多 10 KB raw command output 给 UI。CodePilot 不应把本地路径、包管理器配置或环境片段经 IPC/Sentry 扩散。
- 没有发现它在更新前用 CodePilot 同等级别的 active chat / bridge / task 门禁与 Codex active-turn idle proof。

## 决策摘要

1. **Release Notes bug 单独先修。** 它与 CLI maintenance 不共享发布风险，应该以小而可独立审查的 commit 先闭环。
2. **“最新版”与“最低兼容版本”分轴。** `updateAvailability` 表示同一安装渠道是否有更新；`compatibility` 只有在存在可追溯的 Runtime/capability 最低要求时才表示 below-minimum。没有依据时为 unknown，不编一个最低版本。
3. **命令由受信边界重新推导。** Renderer 最多提交 `provider=claude|codex`；binary、realpath、install channel、package root、executable、args、shell policy 都必须在执行前刷新并由代码映射。
4. **只更新 Runtime 实际使用的安装。** 多安装冲突时不“全部更新”；无法证明 package-manager target 与 selected binary 是同一份安装时禁用一键更新。
5. **退出 0 不是成功。** 更新后必须 invalidate cache、重新发现 binary 并执行 `--version`。版本没变化返回 `unchanged`；目标版本已知时，after version 仍低于目标也不能报 succeeded。
6. **Windows 首选官方渠道，不自造安装器。** standalone 优先供应商 self-update，npm 走真实 `npm.cmd`，Claude WinGet 走 exact package id。PowerShell/杀软/文件锁失败时给受控恢复入口，不在首版复制供应商下载、hash、junction/installer 全套逻辑。
7. **无活动任务才执行，并在整个执行窗口阻止该 Provider 新启动。** active chat、Bridge、scheduler、无法读取 activity、Codex active turn 无法证明 idle 都 fail closed；准入后必须持有带 TTL/心跳的 Provider maintenance lease，所有 Claude/Codex spawn 入口在 lease 存续期间返回低基数 `maintenance_in_progress`，不能让一次 idle snapshot 承担最长 5 分钟的互斥。
8. **Release Notes 是不可信 rich text。** 同时支持 Markdown 与 GitHub Atom HTML 子集，必须 parse 后 sanitize；禁止 raw `dangerouslySetInnerHTML`，禁止远程图片、脚本、表单、SVG、style 与非 HTTP(S) 链接。
9. **CLI 更新、应用更新安装与应用退出共享一个 Main lifecycle latch。** CLI child 存续期间，app updater 不能进入 `installing`，普通退出必须等待或明确取消并完成回收；反向地，app updater 已进入安装 handoff 或应用已进入 quitting 时不得启动 CLI 更新。

## Claude Round 1 审查回写（2026-08-28）

结论为 `fix_requested`。Release Notes 安全渲染、same-channel probe、Renderer 只传 provider 等方向获确认；以下 finding 必须进入实施合同与 required checks，不能只在聊天中关闭：

| Finding | 结论 | 本计划回写位置 |
|---|---|---|
| P2-1：更新执行窗口缺少新 Runtime spawn gate | 接受；准入 snapshot 无法覆盖最长 5 分钟的包管理器/安装器执行 | §B owner 成本、§D maintenance lease、Phase 3、CLIM-11、integration/real smoke、残余风险 #1 |
| P2-2：CLI 更新与 app updater / quit 缺少双向互斥 | 接受；中途杀死安装器可能损坏用户 CLI 安装 | §D global lifecycle latch、Phase 3/5、CLIM-12、source-contract/行为测试 |
| P3-1：Main-owned 收益与 loopback 信任表述不准确 | 接受；same-origin utility endpoint 不能天然区分 Main/Renderer | §B owner 说明、端点安全合同、决策日志 |
| P3-2：Windows `.cmd` shim 与 WinGet/native 重叠 fixture 缺失 | 接受 | §C/§D ownership proof、Unit fixtures、CLIM-03 |
| P3-3：超时/取消后的 process-tree 回收与 post-verify 不完整 | 接受 | §D finalizer、错误枚举、integration tests、CLIM-06 |
| P3-4：Codex npm `codex update` exit-0/unchanged 反例缺失 | 接受 | §C matrix、post-verify、Unit/Integration fixtures、CLIM-06 |

## Claude Round 2 复审回写（2026-08-28）

结论为 `fix_requested`。P1/P2 均已复现并进入代码与 guardrail，不用聊天确认关闭：

| Finding | 根因与取舍 | 修复 / 验证 |
|---|---|---|
| P1-1：`performUpdate` 在多段 await 后才占位，且 lifecycle latch 允许同 owner 重入 | owner 名只是子系统标签，不是单次 acquire token；两个入口可覆盖 `activeOperation` 并由先完成者提前 release | duplicate guard、starting slot 与 latch acquire 移到首个 await 前同一同步段；latch 对同 owner 也 strict non-reentrant；同 owner 正反例与 source-order contract 已加入 targeted |
| P2-1：named-cask outdated 以 1 退出却仍输出 JSON | Homebrew 的 1 是“具名目标确实过期”的结构化状态，不能被通用 `code !== 0` 丢弃；但任意 exit 1 也不能放宽为成功 | 独立 parser 只接受 exit 0/1 + 可解析 JSON；exact cask 返回版本、exit 0 空集合为 current，其他进程/解析失败为 unknown；正反例已加入 targeted |
| P3-1/P3-2/P3-4：更新中 close、multi retry 重跑成功项、成功 key 未清 | 更新运行态不应允许卡片静默隐藏；Retry 与通知去重都必须跟实际终态一致 | running 禁用 dismiss；失败关闭不写版本 dismissal；Retry 过滤已成功 Provider；success 清 toast/key；行为/source contract 已加入 targeted |
| P3-3：新增文案绕过 i18n | locale 探测和组件内双语数组会让未来 locale 漏翻译，Main 对话框也应消费同一字典 | CLI maintenance error/card/settings/ConnectionStatus/quit copy 全部进入 en/zh key；ConnectionStatus/RuntimePanel 改读真实 locale |

## 外部事实基线（2026-08-28）

- Codex 官方安装：Windows standalone PowerShell installer、npm、Homebrew cask；当前 release build 支持 `codex update`。
  <https://github.com/openai/codex#installing-and-running-codex-cli>
  <https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs>
- Codex 官方 doctor 的 update diagnostics：npm/bun/pnpm/standalone 与 Homebrew cask 使用不同 latest probe，并检查 npm global root 是否真的对应当前安装。
  <https://github.com/openai/codex/blob/main/codex-rs/cli/src/doctor/updates.rs>
- Claude 官方安装/更新：native 自动更新；Homebrew、WinGet 及 Linux package managers 默认手动；npm 应使用 `npm install -g ...@latest`。Windows WinGet 在 CLI 运行时可能因 executable lock 失败。
  <https://code.claude.com/docs/en/getting-started#update-claude-code>
- Windows Codex standalone updater 仍可能受 PowerShell 环境或杀软规则影响；这些是需要诚实降级的上游残余风险，不是 CodePilot 应静默改装成 npm 的理由。
  <https://github.com/openai/codex/issues/30015>
  <https://github.com/openai/codex/issues/36118>

这些事实可能随供应商版本变化。Claude 实施前须重新核对官方 source/docs；若命令或 channel 语义变化，先回写本计划决策日志再改实现。

## 详细设计

### A. Release Notes 安全渲染

#### 已确认根因

1. `electron-updater@6.8.3` 的 GitHub Provider 在 `latest*.yml` 未提供 `releaseNotes` 时，从 GitHub Atom feed 的 `<content>` 取值；该字符串是 HTML。
2. `electron/updater.ts` 的 `boundedUpdateText()` 只做类型归一与 20,000 字符截断，不携带 format，也不转换 HTML。
3. `UpdateDialog.tsx` 仅使用 `ReactMarkdown + remarkGfm`。ReactMarkdown 默认把 raw HTML 当不可信文本，因此 UI 显示标签源码。

#### 实现合同

- 保留 ReactMarkdown 路径，加入 `rehypeRaw` 解析内嵌 HTML，再在其后执行 `rehypeSanitize`。
- 将 `rehype-sanitize` 声明为直接依赖；不能因为 lockfile 里存在传递依赖就直接 import。
- 使用项目自定义 strict schema，仅允许标题、段落、列表、引用、分隔线、表格、`pre/code`、强调、删除线与链接等必要元素。
- 移除 `img`，避免 Release body 触发远程图片/追踪请求；移除 `script/style/iframe/object/embed/svg/math/form/input/button` 与所有 event handler/class/style 注入。
- 链接只允许 `https:` / `http:`，由现有 Main `setWindowOpenHandler` / `will-navigate` 继续转系统浏览器；`javascript:`、`data:`、`file:`、凭据 URL 与未知 scheme 不产生可点击链接。
- 保留 20,000 字符 cap；数组 release notes 合并时仍逐项进入同一 sanitize 路径。
- 更新 `Updater.md` 的 UP-09：从“不可信 Markdown”改为“不可信 rich text（Markdown + sanitized HTML subset）”。

#### 验收

- GitHub Atom HTML fixture 的 `<h2><ul><li>` 渲染成对应 DOM，不出现 `&lt;h2&gt;` 或 `<h2>` 文本。
- 普通 Markdown/GFM 表格、代码、链接继续正常。
- `script`、`onerror`、style、SVG、form、远程图片与 `javascript:` href 被移除。
- 点击安全 HTTP(S) 链接仍由 Electron 外部导航策略接管，非 Web scheme 不触达 `shell.openExternal`。

### B. CLI maintenance 领域合同

建议新增纯合同与服务模块；最终文件名可由 Claude 按现有结构调整，但责任不能重新散回多个组件：

- `src/lib/cli-maintenance-contract.ts`：枚举、snapshot、semver、低基数 error、缓存/状态机纯函数。
- `src/lib/cli-install-channel.ts`：selected binary → resolved/real path → install channel / package root / confidence。
- `src/lib/cli-maintenance-service.ts`：latest probe、target ownership proof、update coordination、post-verify、cache invalidation。
- `electron/cli-maintenance.ts`（若审查确认采用 Main-owned executor）：窄 IPC、trusted sender、状态重放、fixed command runner 与输出脱敏。
- `/api/cli-maintenance/*`：只提供 active-work、selected runtime inventory、provider maintenance lease/quiesce、refresh；不得接受 command/args/path/channel。loopback same-origin 本身不是 Main 身份证明，因此这些端点必须对 Renderer 直接调用也安全，或使用不暴露给 Renderer 的 Main-only capability。
- Renderer hooks/components：只消费 snapshot 与发 `provider` 枚举动作。

#### 所有权建议：hybrid Main-owned executor

计划默认采用以下分工，Claude 需要重点审查其复杂度是否低于 utility-only 方案：

1. Utility/Next 仍是 selected Runtime、active work、Codex app-server lifecycle、provider spawn gate 与 CLI cache 的事实源。
2. Electron Main 持有用户触发的 maintenance 状态机、全局 install/quit latch 和外部更新命令执行器；Renderer reload 后可重放 snapshot。
3. Renderer 的 IPC 只携带 `provider` 枚举；Main 用固定 loopback endpoint 向 utility 请求 fresh inventory/maintenance lease/quiesce，不接受 Renderer 提交的 path/installType/command。
4. loopback utility 无法只凭 same-origin 区分 Main 与 Renderer。因此 inventory 默认只返回只读、低敏字段和 opaque target token，不向任意同源调用者暴露绝对路径；maintenance lease/quiesce 的语义必须做到“即使 Renderer 直接调用也不会热杀 active Runtime、不会执行更新、TTL 后自动恢复”。若 Main-owned executor 确实需要 canonical executable/path，则使用每次 utility lifecycle 轮换、只保存在 Main 的 capability，且不得进入 Renderer bundle、HTML、日志或 Sentry；拿不到 capability 时 fail closed。
5. Main 根据 fresh inventory/opaque target proof 通过纯 allowlisted resolver 生成 executable/args；执行后再请求 utility invalidate + rescan，并以实际版本收口。
6. Main-owned 的真实收益不是“Renderer 触达不了 utility endpoint”，而是更新 child 不随 utility recovery 被连带杀死、状态机能跨 Renderer reload 重放，并能与 app updater/quit latch 同处一个 owner；真实成本是跨进程 maintenance lease、heartbeat、utility recovery reconciliation 和更复杂的 failure recovery。
7. 若实施前证明这些成本不能可靠收口，可以改为 utility-owned executor，但必须保留相同的“Renderer 只传 provider、fresh target proof、provider spawn gate、全局 install/quit 互斥、窄状态、无 raw output”合同，并在决策日志说明 owner 变化。

无论选哪种 owner，都不能保留当前 `/api/claude-upgrade`“Renderer 传 installType → 直接选命令”的合同。

#### 建议 snapshot

```ts
type CliProvider = 'claude' | 'codex';

type CliInstallChannel =
  | 'native'
  | 'standalone'
  | 'homebrew'
  | 'npm'
  | 'bun'
  | 'pnpm'
  | 'winget'
  | 'unknown';

type CliUpdateAvailability =
  | 'current'
  | 'update_available'
  | 'managed_auto'
  | 'manual_check'
  | 'unknown'
  | 'unsupported';

type CliCompatibility = 'compatible' | 'below_minimum' | 'unknown';

type CliUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'unchanged'
  | 'error';

interface CliMaintenanceSnapshot {
  provider: CliProvider;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  installChannel: CliInstallChannel;
  channelConfidence: 'proven' | 'ambiguous' | 'unknown';
  updateAvailability: CliUpdateAvailability;
  compatibility: CliCompatibility;
  minimumVersion: string | null;
  canOneClickUpdate: boolean;
  phase: CliUpdatePhase;
  errorCode: CliMaintenanceErrorCode | null;
  checkedAt: string | null;
}
```

用户可见字段的 source breadcrumb：

| 字段 | 真实来源 | 缺失时行为 |
|---|---|---|
| `currentVersion` | 对 selected resolved binary 执行 `--version` | unknown，不补 `0.0.0` |
| `installChannel` | binary path + realpath + package root / cask / WinGet identity proof | unknown，禁用 one-click |
| `latestVersion` | 与 install channel 相同的 registry/cask/WinGet/native source | null，不显示“发现更新” |
| `updateAvailability` | 可解析 current/latest semver 且 channel 对齐 | `managed_auto` / `manual_check` / unknown，不能猜 |
| `minimumVersion` | CodePilot 已验证的 Runtime/capability requirement | null；不从 latest 反推最低兼容版本 |
| `canOneClickUpdate` | fresh channel proof + exact target proof + updater mapping | false，显示 Settings/官方说明恢复入口 |
| `succeeded` | after-version 真实变化并满足已知 target | 否则 unchanged/error |

### C. 安装渠道矩阵

| Provider / 渠道 | latest/advisory 来源 | 一键动作 | 约束 |
|---|---|---|---|
| Claude native | 只在能证明 native channel metadata 时显示 definite latest；否则 `managed_auto` | exact selected `claude update` | 官方默认后台更新；手动动作仍需 post-verify |
| Claude Homebrew | exact `claude-code` 或 `claude-code@latest` cask 的本地/远端状态 | `brew upgrade --cask <exact-cask>` | 必须保留 stable/latest cask identity，不能统一拿 npm latest |
| Claude WinGet | exact `Anthropic.ClaudeCode` 的可升级状态；若 locale/shape 无法稳定解析则 `manual_check` | `winget upgrade --id Anthropic.ClaudeCode --exact ...` | 更新前确保 Claude 未运行；`winget list --id` 不能单独证明 selected binary ownership；与 native 布局重叠且无法消歧时为 `ambiguous` / manual-only |
| Claude npm | npm registry `@anthropic-ai/claude-code@latest` | exact npm executable + `install -g ...@latest` | Windows `claude.cmd` 是 shim 而非 symlink，不能靠 realpath 穿透；`npm root -g` / prefix 必须命中 selected package root；不再用 `npm update -g` |
| Claude bun | npm package latest + selected bun global root proof | `bun install -g ...@latest` | 作为存量兼容渠道；无 ownership proof 则 manual-only |
| Codex standalone | Codex `version.json`/官方 release source；以当前官方实现为准 | exact selected `codex update` | Windows 可能进入官方 PowerShell installer；失败不自动切 npm |
| Codex Homebrew | Homebrew `codex` cask 状态 | `brew upgrade --cask codex` | 不使用普通 formula 语义，不拿 GitHub release 冒充 cask 已同步 |
| Codex npm/bun/pnpm | 对应 package root + 官方 release/npm source | 新版优先 exact `codex update`；旧版按已证明 manager fallback | Windows `codex.cmd` ownership 走 manager root/prefix，不靠 realpath；若 self-updater 只提示“改用 npm”并 exit 0，同版本必须归 `unchanged` 并给受控 manager fallback，不能报 succeeded |
| unknown / 自定义绝对路径 | 无 | 无 | 显示实际 current version、冲突说明和官方更新文档，不执行猜测命令 |

#### npm 12 `allow-scripts` 决策点

T3 为 Claude npm 安装增加了包级 `--allow-scripts=@anthropic-ai/claude-code`，理由是 npm 12 可能跳过 postinstall 但仍 exit 0。该参数改变安装脚本策略，不能只因竞品使用就复制：

- Phase 2 先在隔离 npm prefix 下复现 npm 12 官方 Claude 包安装/更新。
- 若不加 allowlist 会留下 placeholder/broken binary，采用只允许该精确包的参数并加入 npm 版本正反例。
- 若当前官方包或 npm 已不需要，则坚持官方命令，不扩大 scripts policy。
- 无论采用哪条，post-verify 都必须对最终 executable 执行 `--version`，不能只看 npm exit code。

### D. 更新准入、锁与生命周期

#### 执行前

1. IPC 校验调用者是当前 trusted Renderer，并且 provider 是固定枚举；utility loopback endpoint 不能把 same-origin 当 Main 身份证明，必须满足 §B 的 safe-for-same-origin 或 Main-only capability 合同。
2. initial fresh resolve selected binary；获取 resolved path、realpath、current version、channel、package root/cask/package id。
3. 证明 package manager 更新目标与 selected binary 相同：
   - npm：`npm root -g` / prefix 与 binary package root 对齐；Windows `claude.cmd` / `codex.cmd` 是 shim，不把 `realpath` 未穿透误判为 unknown 或 symlink proof；
   - Homebrew：exact cask 拥有该 binary/symlink；
   - WinGet：exact package id 与 Windows native path 对齐；`winget list --id` 只证明包存在，若 WinGet/native 布局重叠且无法把 selected binary 唯一归属给 exact id，则 `channelConfidence='ambiguous'` 并禁用 one-click；
   - standalone/native：路径命中供应商管理布局或 self-updater 能识别的 install context。
4. 在任何 active-work、target 或 latest await 前，Main 同步完成 duplicate guard、`startingOperation` 占位与全局 install/quit lifecycle latch acquire。首版是全局单 active CLI update，不另做 manager queue；latch 对同 owner 也不可重入。若 app updater 已 owning latch、应用已 quitting，立即拒绝并释放占位。
5. 查询 active work。chat / bridge / task 任一 active，或 activity endpoint 不可用，返回低基数 `active_work` / `activity_unavailable`，并幂等释放 starting slot/latch。
6. initial fresh resolve selected binary、ownership 与 same-channel latest；Homebrew named cask 的 outdated exit 1 只有 stdout JSON 可解析并命中 exact cask 时才是有效更新事实，其他失败归 unknown。
7. 向 utility 获取 provider maintenance lease。utility 必须先让 gate 对所有该 Provider 的 spawn 入口可见，再在同一 lifecycle coordinator 中复查 active work；Codex 还要确认 active turn count 为 0 并执行既有 idle dispose。任何检查失败都撤销 lease/latch 并 fail closed，不能热杀 active Runtime。
8. lease 生效后、spawn 更新命令前，再做一次 fresh target/current-version proof；selected identity/channel/ownership 相比 initial resolve 漂移时返回 `update_target_mismatch`，不能沿用旧 proof。

#### Provider maintenance lease（P2-1 硬合同）

- lease key 至少包含 `provider + selected target identity`，由 Main 持有 opaque lease id；Renderer 不得自选 target 或伪造 lease id。
- utility 的 Claude CLI、Codex CLI/app-server、Bridge、scheduler 和其他所有 Provider process launch 入口必须在真正 spawn 前检查 gate。lease 存续时拒绝新启动并返回低基数 `maintenance_in_progress`；UI 可提示“CLI 正在更新，请稍后重试”，不得悄悄排队一条可能在旧上下文中恢复的用户消息。
- lease 带有限 TTL，Main 在 child 运行、process-tree cleanup 与 post-verify 期间心跳续约；Main crash、hang 或网络断开后，TTL 到期自动解除。release/expiry 必须幂等，stale residue 不得永久阻断 Provider。
- utility recovery 后必须先与 Main maintenance snapshot 重放/对账；对账完成前该 Provider spawn fail closed。若 Main 仍在更新则恢复 gate 与 heartbeat；若 Main 不可达则只等待有界 TTL，不能无限阻断。
- gate 覆盖的是整个 update command + cleanup + post-verify 窗口，不是只覆盖开始前的 idle snapshot。Updater tech-debt #88 的通用 app activity lease 是另一条边界，不能拿来代替本合同。

#### App updater / quit 双向互斥（P2-2 硬合同）

- CLI maintenance 与 `installDownloadedUpdate()` 必须竞争同一个 Main-owned strict non-reentrant install lifecycle latch，不能各自读取 snapshot 后分别进入安装。owner 名不能充当 acquire token；CLI 的 operation slot + latch acquire 位于首个 await 前，并发竞态只能有一方进入执行态。
- CLI update 处于 running、process-tree cleanup 或 post-verify 时，app updater install 返回低基数 `cli_update_running`，保持 app update 在 downloaded/retryable 状态，不得先设置 `installing` 再回滚猜测。
- app updater 已进入 `installing`/`before-quit-for-update` handoff，或 Main 已进入 quitting 时，CLI update 返回 `app_update_installing` / `app_quitting`，不得启动 child。
- 普通 tray/menu/IPC/OS quit 请求必须走统一 quit coordinator。CLI update 活跃时先 `preventDefault` 并提示等待；用户可选择取消 CLI update，但必须等 process tree 回收和 post-verify 终态后再退出。只有用户明确确认风险时才允许 force quit，并在可显示 UI 时说明包管理器/安装器可能留下半更新安装；不得把 force quit 作为默认超时策略。
- lifecycle latch 只在 child tree 已结束、invalidate/rediscovery/post-verify 已收口后释放。Main crash、OS kill、断电等不可拦截终止保留为残余风险，不能宣称 latch 能覆盖进程外强杀。
- 实施时同步更新 `Updater.md` UP-06 与新 `CliMaintenance.md`，两边互相引用这条双向互斥和统一 quit coordinator，避免未来只改一侧。

#### 执行中

- deadline 默认 5 分钟；child 必须进入独立 process group/tree，finalizer 在 success、nonzero、cancel、timeout、Main shutdown request 各分支都运行。取消/超时按进程树回收本次 command 的 root、child 与 grandchild；Windows 不能只杀 shell/`winget` 父进程，也不能按 executable name 全局误杀其他用户进程。
- process-tree kill 后有界等待并断言树内无存活 descendant；无法证明清理完成时返回 `cleanup_incomplete`，继续保持 lifecycle latch/maintenance gate 到有界 recovery 终态，不能立刻允许新 Runtime spawn 或 app updater 安装。
- Windows `.cmd` / `.bat` 通过独立、单测覆盖的 `resolveSpawnCommand` 适配；路径含空格、`&()^%` 等字符时不能发生参数拼接注入。
- 所有 executable 与 args 均来自 code-owned mapping；binary/package-manager path 虽来自本机发现，也必须 canonicalize 并按渠道验证。
- 不自动使用 sudo、RunAs、UAC bypass 或管理员 shell。需要提权时返回 permission/manual recovery。
- stdout/stderr 在 byte 层设 hard cap，raw 内容只允许进入短生命周期内存用于本地分类；IPC、日志与 Sentry 只输出 phase、provider、channel、errorCode、duration bucket、before/after semver 等低敏字段。

#### 执行后

以下流程对 clean success、nonzero、timeout、cancel 和 cleanup error 一律执行；不能因为安装器被杀或 exit code 非 0 就跳过真实状态发现：

1. invalidate Claude path/version/WinGet caches 与 Codex candidate/status/model caches。
2. 对 Codex 执行 same-path forced rescan；对 Claude 重新走完整 binary discovery，不复用前端旧 status。
3. 执行 after `--version` 并比较：
   - target 已知：`after >= target` 才 succeeded；
   - target 未知：至少要证明 after > before，或供应商结构化地证明 already-current；首版拿不到结构化事实时同版本归 `unchanged`；
   - binary 消失、版本无法解析或 selected identity 变化为另一安装：`version_unverified` / manual recovery；
   - timeout/cancel/nonzero 即使 post-verify 发现 target 已到达，也保留真实 command outcome 并刷新 current version，不建议盲目重试；只有 clean command outcome + target proof 才进入普通 `succeeded`；
   - npm channel 的 `codex update` 若只提示使用 npm、exit 0 且 after=before，归 `unchanged` 并给 code-owned manager fallback CTA，不能依赖提示文案冒充成功。
4. process tree 无残留、post-verify 已写入 terminal snapshot 后，按顺序释放 provider lease、global lifecycle latch、manager/target locks；release 幂等。
5. 新会话懒启动新 Runtime；不强制重启整个 CodePilot，除非真实 smoke 证明某渠道更新后进程内缓存无法安全恢复。UI 文案不能无证据一律要求重启应用。

### E. Latest probe 与缓存

- success TTL 1 小时；network/parse failure TTL 5 分钟；单次网络 probe deadline 4–5 秒。
- 同 provider/channel 的 concurrent probe single-flight；离线/超时返回 unknown，不产生 Sentry Issue。
- semver 必须处理前缀和 prerelease；stable channel 不与 latest prerelease 交叉比较。
- Homebrew named cask outdated 的 exit 1 + exact JSON 是 update_available；exit 0 + 空 cask 数组才是 current。超时、其他退出码、JSON 解析失败或 exit 1 无 exact target 一律 unknown。WinGet/Claude stable 若官方仓库尚未同步，不显示“更新失败”；显示 current 或 manual-check，避免供应商发布与渠道分发时间差制造循环提醒。
- 手动“检查更新”可 bypass failure cache，但仍受 single-flight、deadline 与 rate limit。

### F. UI 与交互

#### 主提醒

- 应用启动完成后非阻塞检查，不抢首屏；沿用 1 小时缓存，避免每个 chat mount 重复请求。
- definite `update_available` 才显示“Update Available: Claude/Codex vX”。按钮：`Settings`、`Update`。
- 只有 manual-check 事实时显示“可检查此安装渠道”，按钮写“检查并更新”，不能写“发现新版本”。
- 两个 Provider 同时有更新时使用一张左下角聚合卡片，按已证明可一键更新的 Provider 串行执行；单个失败不伪装全部成功。
- 卡片不按时间自动消失：用户未更新、未手动关闭时持续保留；dismissal key 为 `provider + latestVersion`，手动关闭后同一 release 不重复出现，新版本重新提醒。below-minimum compatibility warning 不使用同一 dismissal 语义。
- 点击更新后在原卡片显示真实状态。当前包管理器链路没有可信百分比，因此使用 spinner，不伪造进度条；running 时禁用关闭，避免安装继续但唯一状态面被静默隐藏。多 Provider 失败后的 Retry 只跑未成功项；失败关闭不写版本 dismissal；全部 post-verify 成功后清 notification key，显示完成并于 2.5 秒后消失。

#### Settings

- Runtime Settings 中 Claude/Codex 共享一套 `CliMaintenanceRow/Card`，避免 `ConnectionStatus` 与 `RuntimePanel` 继续维护两套升级行为。
- 展示：current version、安装渠道、latest（仅有真实 source 时）、最后检查时间、availability、compatibility、更新状态和低基数恢复建议。
- binary path/其他安装冲突沿用现有诊断 UI；update card 默认不暴露绝对路径或命令输出。
- 设置项“检查 CLI 更新”默认开启，只控制 background advisory，不关闭手动检查、below-minimum compatibility gate 或当前版本诊断。复用 settings key-value，不为一个布尔值新增 DB schema。

#### 错误文案

低基数错误至少区分：

- `active_work`
- `activity_unavailable`
- `maintenance_in_progress`
- `cli_update_running`
- `app_update_installing`
- `app_quitting`
- `install_channel_unknown`
- `update_target_mismatch`
- `package_manager_missing`
- `permission_denied`
- `executable_locked`
- `network_unavailable`
- `timed_out`
- `cancelled`
- `cleanup_incomplete`
- `command_failed`
- `version_unverified`
- `version_unchanged`

错误详情不得回显 raw OS/package-manager 文本。需要恢复时提供受控动作：重试、关闭活动会话、打开 Runtime Settings、打开官方 HTTP(S) 文档或打开可见终端；不提供 Renderer 可控的通用 shell bridge。

## 执行清单

### Phase 0 — Claude 计划审查

- [x] Round 1 核对 hybrid Main-owned executor 与 utility-only executor 的信任收益、生命周期复杂度和 failure recovery；修正 same-origin 误表述并显式登记跨进程 lease 成本。
- [x] Round 1 核对官方 Codex/Claude 当前 update command、Homebrew cask、WinGet 与 npm 语义没有从 2026-08-28 基线漂移。
- [x] Round 1 核对渠道矩阵没有把“供应商 latest”错误用于 stable/cask/WinGet，并指出 Windows shim/WinGet-native ambiguity fixtures。
- [x] Round 1 核对 required checks 可机械验收，发现执行窗口 spawn gate 与 app updater/quit 互斥缺口。
- [x] Round 1 `fix_requested` 的 2 个 P2、4 个 P3 已逐条回写计划，不用聊天确认关闭。
- [x] Claude Round 2 沿真实调用链复审，结论 `fix_requested`；确认 P1 admission/latch 与 P2 Homebrew probe，另给出 4 个 P3。
- [x] Round 2 P1/P2 与 P3 全部代码修复、targeted 21/21；仍待独立复审，不标 `Review passed`。

### Phase 1 — Release Notes bug 修复

- [x] 增加 `rehypeRaw` + direct `rehype-sanitize` strict schema，兼容 GitHub Atom HTML 与现有 Markdown。
- [x] 限制 URL protocol，剥离远程图片和主动内容；保持外部链接走 Main policy。
- [x] 补 HTML/Markdown 正例、script/event/javascript/style/SVG/form/img 反例；20 KB cap 继续由既有 updater contract 覆盖。
- [x] 更新 Updater guardrail 的 release notes trust contract。
- [x] 完成 `npm run test`（5419 pass / 0 fail / 1 skip）；真实 UpdateDialog UI smoke 仍待执行，尚未 commit。

### Phase 2 — 统一检测与 advisory

- [x] 新增 shared contract、channel resolver、same-channel latest probe、cache/single-flight 与语义测试。
- [x] Claude status 保留 connected/missingGit/conflict 字段，移除旧 npm-only advisory；所有更新消费者迁到 Main snapshot。
- [x] Main 从既有非破坏 Codex status 获取 selected binary/current，再提供 latest/channel/advisory；same-path POST rescan 语义不倒退。
- [x] 实现 npm/bun/pnpm package-root+shim、Homebrew exact cask、native/standalone target proof；WinGet/native 无法唯一证明时显式 ambiguous/manual-only。
- [x] 现场修复 Codex desktop bundle 渠道遗漏：macOS App bundle / Windows Store package 先于通用 standalone 文件形状识别，latest=null、无 CLI 一键更新，并显示随 owner app 更新。
- [x] accepted 复审 P3：macOS owner proof 放宽为任意 `.app/Contents/**`，Windows 补 Store alias 与已知 desktop Resources 布局；Runtime discovery/maintenance 复用同一 helper，官方 standalone `OpenAI/Codex/bin` 保持反例。
- [ ] 在隔离 npm prefix 验证 npm 12 Claude postinstall/allow-scripts 决策并回写证据。
- [x] compatibility 只消费 Codex `too_old` 的真实 minimum；Claude 与无 minimum 的 Codex 状态保持 unknown/null。

### Phase 3 — 受控一键更新

- [x] 落地 Main-owned owner、窄 IPC、trusted sender/provider enum 校验与 snapshot replay。
- [x] utility loopback lease 只接受 action/provider/opaque id，语义 safe-for-same-origin：不执行命令、不暴露 path、active Codex 不热杀。
- [x] 执行前 active-work + Codex idle proof；Claude/Codex launch entrypoint 使用 TTL/heartbeat lease，覆盖 command、cleanup 与 post-verify。
- [x] utility recovery fork 前从 Main snapshot 注入 opaque bootstrap lease，healthy 后立即 reconcile；heartbeat 停止后 TTL 自动解锁。
- [x] CLI updater、app updater install 与普通 quit 共用 Main exclusive lifecycle latch；实现等待、cancel+cleanup、明确 force-quit 风险与双向拒绝。
- [x] 首版采用全局单 active CLI update（比 target/manager 并行更保守），并实现 Windows no-shell spawn、deadline/finalizer、64 KiB output classifier；未来排队不提前占 latch。
- [x] process-tree finalizer 覆盖 child/grandchild；真实行为测试证明 cancel 后无树内残留；所有运行后终态走 invalidate/rediscovery/post-verify。
- [x] 实现 Claude/Codex allowlisted channel command；Renderer 无 path/installType/command/args 控制面。
- [x] `/api/claude-upgrade` 改为 410 非执行 tombstone；`ConnectionStatus` / `RuntimePanel` 不再走旧信任边界或显示 raw output。
- [x] 实现 post-update invalidate/rescan/version verification；exit 0 same-version 覆盖 unchanged。
- [x] 服务不调用 Sentry；IPC/log 只出现 snapshot/低基数错误，raw output 与绝对 target 留在短生命周期 Main 内存。
- [x] Round 2：入口在首个 await 前同步占 starting slot + strict non-reentrant lifecycle latch；同/异 Provider 重入都不能进入第二条更新或提前 release。
- [x] Round 2：Homebrew probe 接受 named-cask exit 1 的 exact JSON，进程/解析失败归 unknown，不再伪造 current。

### Phase 4 — 通知与 Settings 统一体验

- [x] 建立 AppShell 级 background check owner，Main 内 provider probe single-flight/cache，避免重复组件各自查 latest。
- [x] 实现 single/multi-provider version-keyed 左下持久卡片、Settings/Update 诚实 CTA；manual/ambiguous 不冒充可更新。
- [x] Runtime Settings 合并重复 Claude update UI，并新增 Codex 同构状态。
- [x] 首版按用户目标采用启动后自动检查、不增加额外 setting；中英文低基数恢复文案、cancel 与 `role=status` 已接入。
- [x] below-minimum compatibility 与 latest advisory 分离显示，缺 source 不显示假版本/假支持。
- [x] Round 2：更新中禁用 dismiss；multi Retry 只跑未完成项；success 清 notification key；新增 CLI maintenance 文案统一进入 en/zh i18n。

### Phase 5 — 验证、Guardrail 与交接

- [x] 新增 `docs/guardrails/CliMaintenance.md`，并在 guardrail index、Runtime/ElectronMain 交叉链接责任边界；更新 `Updater.md` UP-06，让两份 guardrail 互相引用 CLI update/app update/quit 双向 lifecycle latch。
- [x] 输出 `docs/handover/cli-maintenance.md` 与 `docs/insights/cli-maintenance.md`，互相反链并更新索引。
- [x] 原实现 targeted 15/15、`npm run test`（5419 pass / 0 fail / 1 skip）与 `npm run build` 完成；Round 2 修复 targeted 21/21、`npm run test`（5428 pass / 0 fail / 1 skip）、tsc/ESLint 与独立 dist `next build` 通过。默认 `npm run build` 按安全合同因开发客户端占用 `.next/dev/lock` 拒绝，未停止用户正在使用的 dev client。Runtime Settings browser smoke 无 console error，真实 UpdateDialog 与必要 packaged server/Electron smoke 待执行。
- [ ] macOS disposable prefix/测试账号验证 Claude npm、Codex npm 或 standalone 的 before→after；不改用户日常 CLI。
- [ ] Windows clean VM 验证 npm.cmd、Claude WinGet executable lock、Codex standalone self-update/失败降级、active work 拦截与 after-version。
- [x] 回写状态表、执行清单、决策日志和 Smoke Ledger；真实平台矩阵未完成，因此仍不标 Smoke passed / Release ready。

## Required checks draft（供 Claude 审查）

| ID | 可机械验收的检查 |
|---|---|
| CLIM-01 | 每个用户可见 current/latest/channel/compatibility/canUpdate 字段都有 source breadcrumb；缺失 source 时为 unknown/manual/hidden，不出现假 `0`、假 latest 或假一键更新 |
| CLIM-02 | Renderer/URL body/IPC payload 只能选择固定 provider/action；无法注入 installType、path、executable、args、shell、registry URL 或 package name |
| CLIM-03 | npm prefix mismatch、Homebrew cask mismatch、WinGet identity mismatch、多安装歧义均 fail closed；Homebrew named-cask exit 1 + exact JSON 识别为 update_available，而进程/解析失败为 unknown；Windows `claude.cmd`/`codex.cmd` shim 通过 npm root/prefix 正确证明正例，WinGet+native 重叠且无法唯一归属时为 `ambiguous` / manual-only，且不会更新 PATH 中另一份 CLI |
| CLIM-04 | active chat、streaming、waiting_permission、Bridge、scheduler、activity unavailable、Codex active turn 各自阻断更新；stale runtime residue 不永久阻断 |
| CLIM-05 | Windows `npm.cmd` 路径含空格/元字符仍保持 argv 边界；Claude WinGet file lock、Codex PowerShell/AV failure 进入低基数恢复而非伪成功或静默切渠道 |
| CLIM-06 | clean exit 0 + after version same、target 未达、binary 消失、version parse 失败，以及 npm Codex `codex update` 提示改用 npm但 exit 0/同版本，均不能返回 succeeded；success/nonzero/timeout/cancel 都执行 cache invalidate、same-path Codex rescan 与 after-version，fake child→grandchild 取消后无树内残留 |
| CLIM-07 | GitHub Atom HTML 正常渲染；script/event/style/SVG/form/remote image/javascript/data/file scheme 均被移除，安全 HTTP(S) 链接仍由 Main 外链策略接管 |
| CLIM-08 | command output、绝对路径、registry/feed query、环境变量、OS raw error 不进入 Renderer、普通日志或 Sentry；expected network/lock/permission/active-work 不生成 Sentry Issue |
| CLIM-09 | targeted + full + build 通过；UI 改动有真实 smoke；macOS/Windows 渠道 smoke 分别写入 ledger，未跑平台不冒充通过 |
| CLIM-10 | 新 guardrail、handover、insight、i18n 与 exec-plan 三处进度回写一致；不 push/tag/release，不在公开 repo 文档/commit message 引入私有协作 marker |
| CLIM-11 | Provider maintenance lease 生效后到 post-verify 结束前，Claude/Codex chat、app-server、Bridge、scheduler 等已知 launch entrypoint 的新 spawn 均返回 `maintenance_in_progress`；Main crash/heartbeat 停止、utility recovery 与 TTL expiry 有行为测试，stale lease 不永久阻断 |
| CLIM-12 | CLI operation slot + lifecycle latch acquire 在首个 await 前同步完成，latch 同 owner 也不可重入；CLI update 与 app updater install 竞态只允许一方执行；CLI running 时 app update 保持 downloaded/retryable，app installing/quitting 时 CLI child 不启动；普通 quit 等待或 cancel→process-tree cleanup→post-verify 后才退出，guardrail 有 reciprocal source-contract 测试 |

## 测试计划

### Unit / pure contract

- binary path + symlink/realpath fixtures：macOS/Linux/Windows native、npm、bun、pnpm、Homebrew、WinGet、unknown；Windows `claude.cmd` / `codex.cmd` shim 明确证明 realpath 不穿透、npm root/prefix 正例仍能归属。
- package root ownership：selected root match、不同 npm prefix、stale shim、双安装冲突；WinGet exact id 唯一归属正例，以及 WinGet package 存在但 selected native path 重叠无法消歧的 `ambiguous` 反例。
- semver：前缀、prerelease、invalid、current>latest、channel mismatch。
- cache/single-flight：success TTL、failure TTL、manual bypass、timeout、concurrent dedupe。
- command resolver：provider/channel allowlist、Windows `.cmd`、空格/元字符、Renderer override 反例。
- lock/state machine：首 await 前 starting slot、same/different provider duplicate、same-owner strict non-reentrant、provider maintenance lease heartbeat/TTL/release/recovery reconcile、global lifecycle latch 双向竞态、renderer reload snapshot。
- post-verify：更新、同版本、低于 target、binary moved/disappeared、parse failure；npm Codex `codex update` 输出“改用 npm”类提示、exit 0、after=before 时为 `unchanged`，不得报 succeeded。
- telemetry：expected errors zero event；unexpected event 只有低基数字段和有界数值。
- Release Notes：GitHub HTML / Markdown 正例与完整主动内容、URL、remote image 反例。

### Integration / fake executables

- 临时目录构造 fake selected CLI、package root、manager executable 和可控 `--version` before/after，不触碰开发机全局安装。
- fake updater exit 0 但不改版本、exit nonzero、hang、超长 stdout/stderr、child cancellation；hang root 生成 child→grandchild，timeout/cancel 后断言树内无残留并且仍执行 invalidate/rescan/`--version`。
- update running 时分别请求 Claude CLI、Codex app-server、Bridge/scheduler Provider spawn，全部在真正创建进程前得到 `maintenance_in_progress`；heartbeat 停止/utility recovery/TTL 到期后能恢复且不会永久阻断。
- utility activity endpoint success/active/unavailable，Codex idle dispose 与 active-turn refusal；maintenance gate 先建立再复查 activity，复查失败会幂等释放 lease/latch。
- CLI update 与 app updater install 并发起跑只有一个拿到 lifecycle latch；CLI running 时 install 保持 downloaded，app installing/quitting 时 fake CLI child 未创建。
- normal quit during update 被阻断；cancel 后等待 process tree 回收与 post-verify 才允许退出；显式 force-quit 路径只验证提示/状态合同，不在测试进程中破坏真实全局安装。
- Main/preload/types/hook/API source contract 同形；旧 Claude upgrade route 不再可绕过统一服务；`Updater.md` UP-06 与 `CliMaintenance.md` reciprocal contract 有 source check。

### UI / E2E

- 单 Provider update card、双 Provider 聚合、未操作不自消失、available dismiss 同版本不再弹、新版本重新弹、running spinner + 不可关闭、失败关闭不记 dismissal、Retry 只跑未完成 Provider、成功清 key 后短暂确认并消失。
- definite update、managed-auto、manual-check、unknown、below-minimum 的文案和 CTA 不互相冒充。
- queued/running/succeeded/unchanged/error，关闭/重开 Settings 后状态一致。
- update running 时新会话显示“CLI 正在更新”而不是静默丢消息；app update install/quit 的等待、取消、force-quit 风险提示与键盘操作可达。
- Release Notes HTML 正常排版、长内容滚动、外链与恶意内容行为。
- 中英文和 keyboard/screen-reader 状态。

### Real / packaged smoke

- macOS：隔离 prefix 或 disposable user 验证 npm/native/Homebrew 中可安全构造的渠道；记录 actual before/after binary 与版本，但 Evidence 不写用户名/绝对路径。
- Windows clean VM：npm.cmd shim ownership、Claude WinGet、Codex standalone；至少一条成功升级、一条 executable lock、一条 exit-0/same-version、一条 WinGet/native ambiguity 或 target mismatch 反例。
- active work/lifecycle：真实 running chat 或等价 durable owner 阻断；idle 后启动更新，在执行窗口请求新会话被 maintenance gate 拒绝；分别验证 app updater install 和普通 quit 不会中途杀 CLI updater；结束后 Codex app-server 能重新启动并完成一个无版本兼容错误的会话。
- 未取得真实凭据时，可完成 CLI 更新 smoke，但不得把“CLI 能启动”冒充模型请求 smoke；如果验证兼容性承诺，必须另用真实账号执行最小会话并登记凭据形态。

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|---|---|---|---|---|---|---|---|
| 2026-08-28 | local source research | T3 / CodePilot / official docs | n/a | 无凭据、只读 | T3 binary→channel→command、Windows spawn、post-verify；CodePilot 现状；官方渠道；GitHub Atom HTML 根因 | ✅ 调研完成 | 本计划“用户问题与争议 / 外部事实基线 / 详细设计”；未修改产品代码、未执行 CLI 更新；`lint:docs-drift`、`git diff --check`、private-marker scan、`npm run test` 均通过 |
| 2026-08-28 | local Node/Electron source contract | Claude Code / Codex CLI / app updater | n/a | 无真实 CLI 更新 | semver、TTL/recovery lease、lifecycle latch、Windows shim/ambiguity、bounded runner、真实 child→grandchild cancel、IPC trust、Atom HTML sanitize | ✅ 15/15 targeted；full 5419 pass / 0 fail / 1 skip | `cli-maintenance-*.test.ts`、`release-notes-rendering.test.ts`、`npm run test`；只证明本地合同，不冒充真实渠道 before→after 或 UI smoke |
| 2026-08-28 | local Node/Electron Round 2 regression | Claude Code / Codex CLI / Homebrew | n/a | 无真实 CLI 更新 | 同/异 Provider concurrent `performUpdate`、same-owner latch、named-cask exit 1 JSON、probe failure→unknown、multi retry remainder、running dismiss/key/i18n source contract | ✅ 21/21 targeted；full 5428 pass / 0 fail / 1 skip；独立 dist production build 通过 | `cli-maintenance-concurrency/contract/security/runner`、channel 与 release-notes tests；默认 build 因真实 dev lock fail closed，改用 `.next-e2e-review-build` 验证后已清理；不冒充真实 Homebrew before→after 或 Review passed |
| 2026-08-28 | local production build + browser dev UI | Runtime Settings | n/a | 无真实 CLI 更新 | Next production compile/typecheck/static generation；设置页 Claude/Codex CLI 维护行、按钮禁用态与布局 | ✅ build 通过；DOM/视觉 smoke 通过；console 0 error/warn | browser 环境无 Electron preload，因此不冒充 Main IPC、toast、真实 UpdateDialog 或一键更新 smoke |
| 2026-08-28 | Electron dev UI | Codex CLI | n/a | 本机已安装 CLI；未执行更新 | 左下持久提醒卡片展示真实 `v0.149.1 → v0.150.1`；Provider brand、紧凑宽度、action/正文左对齐、右上浮层 close | ✅ AX 与视觉截图通过；targeted 4/4、tsc、ESLint 通过 | Computer Use 检查真实 Electron；只验证 advisory 卡片与布局，不冒充点击更新或 before→after smoke |
| 2026-08-29 | GitHub Actions / official stable | CodePilot `v0.67.11` | n/a | 正式 Apple secrets；Windows signer 全缺 | 三平台 package、Mac Developer ID/公证/staple、arm64+x64 ABI、updater graph、checksum、attestation、draft→public | ✅ **Shipped**；7/7 jobs success，Latest immutable Release 公开 | [Actions](https://github.com/op7418/CodePilot/actions/runs/33230535883) / [Release](https://github.com/op7418/CodePilot/releases/tag/v0.67.11)；20 个资产、19/19 checksum 集合、20/20 provenance 公开复核通过。这里只证明正式产物链，不冒充 UpdateDialog 富文本、CLI 点击更新 before→after 或 Windows clean VM smoke |
| 2026-08-29 | local Node/Electron source contract | Codex CLI | n/a | 无真实 CLI 更新 | 现场 macOS ChatGPT.app 路径、旧 Codex.app、Windows Store package 归 `desktop_bundle`；独立 `~/.local/bin/codex` 保持 standalone；desktop bundle latest/command fail closed | ✅ Tests pass；targeted 11/11，完整 5441 pass / 0 fail / 1 skip | 代码提交 `36d2879c`；dev client 启动后未生成可检查的 Renderer 窗口，已安全停止；因此这里只记代码/测试合同，不冒充 desktop-bundle UI smoke 或另一台设备复验 |
| 2026-08-29 | local Node/Electron P3 regression | Codex CLI | n/a | 无真实 CLI 更新 | macOS 任意 `.app/Contents/**`、Windows Store/alias/已知 desktop Resources 布局均 fail closed 为 app-owned；Runtime discovery 与 maintenance 共享 owner helper；官方 `OpenAI/Codex/bin` 仍是 standalone 反例 | ✅ Tests pass；targeted 59/59，完整 5441 pass / 0 fail / 1 skip | 代码提交 `c19f031e`；`cli-install-channel`、`runtime-probe`、`codex-binary-discovery`、maintenance security tests；只证明源码合同，不冒充未来供应商布局或真实更新 smoke；本次只提交、不发版 |
| _待执行_ | local UI | CodePilot updater | n/a | 无凭据 | GitHub Atom HTML + Markdown + malicious rich-text fixture | ⏳ | 不在实施前冒充通过 |
| _待执行_ | macOS packaged/dev | Claude Code / Codex CLI | n/a | disposable install；模型 smoke 另记真实账号形态 | selected channel before→one-click→after version | ⏳ | 需记录渠道、before/after 与 UI 状态，不记录绝对路径 |
| _待执行_ | Windows clean VM | Claude Code / Codex CLI | n/a | disposable install；模型 smoke 另记真实账号形态 | npm.cmd / WinGet lock / standalone updater / active work | ⏳ | 需真实 VM 证据 |

## 残余风险与明确接受边界

1. 本计划新增的 provider maintenance lease 必须覆盖当前所有 Claude/Codex process launch 入口，并关闭 CLI 更新执行窗口内的新 spawn；但它不是整个应用所有未来 activity 的通用事务系统。Updater tech-debt #88 仍描述 app updater 自身从 activity query 到 quit handoff 的跨入口原子性，不能与本 lease 合并宣称已解决。若实施时发现无法纳入 gate 的既有 Provider launch 入口，属于 required-check failure，不得降格为已接受风险。
2. Windows Codex standalone self-update 可能被 PowerShell 环境或第三方杀软阻断。CodePilot 可以识别和解释失败，但不保证绕过企业安全软件。
3. Homebrew/WinGet/stable channel 可能晚于供应商 release；same-channel probe 会减少误报，但用户可能比 npm/latest 用户更晚收到通知，这是正确渠道语义。
4. npm/bun/pnpm global install 受用户 prefix、权限、企业 policy 与脚本策略影响。target ownership proof 与 post-verify 优先于“尽量替用户修好”。
5. 远程 Release Notes sanitize 能显著缩小 XSS/追踪面，但仍需依赖 parser/sanitizer 的维护；相关 dependency 不得使用漂移的未声明传递依赖。
6. 若 selected binary 是用户自建 wrapper、Nix/portable/custom symlink，首版可能只提供 manual recovery。这是宁可少支持也不更新错目标的取舍。
7. Main crash、OS 强杀、断电可能在 package manager/installer 写盘时绕过 lifecycle latch。CodePilot 必须在下次启动重新发现 CLI 并给 manual recovery，但无法保证修复外部安装器已经造成的所有损坏；产品不能把“允许强制退出”等同于安全取消。

## 决策日志

- 2026-08-28：用户要求调研 T3 的 CLI 更新提醒/一键升级、Windows 替代方案，并报告应用更新弹窗显示 HTML 源码。只读调研确认功能可行，但 T3 的 npm-for-all latest 和旧 Codex mapping 不可直接复制。
- 2026-08-28：确认 Release Notes 根因是 `electron-updater` GitHub Provider 从 Atom feed 返回 HTML，而 `UpdateDialog` 按 Markdown 安全转义；决定以 parse + strict sanitize 支持 HTML 子集，不使用 raw `dangerouslySetInnerHTML`。
- 2026-08-28：确认 CodePilot 旧 Claude npm upgrade 命令已偏离当前 Anthropic 文档；新计划要求 `install ...@latest`，同时把 npm 12 allow-scripts 作为必须实测后决策的安全点。
- 2026-08-28：计划默认建议 hybrid Main-owned executor，但把 owner 方案列为 Claude 首要架构审查项；不可变要求是 Renderer 只提交 provider/action、fresh target proof、active-work fail closed、bounded output 与 after-version 验证。
- 2026-08-28：Claude Round 1 给出 `fix_requested`。接受 P2-1/P2-2：CLI 更新不再只依赖准入 snapshot，而以 provider maintenance lease 覆盖整个执行/清理/复核窗口，并与 app updater install/普通 quit 共享 Main lifecycle latch；新增 CLIM-11/12。
- 2026-08-28：接受 P3-1，修正 hybrid 收益：Main-owned 的收益是 child 跨 utility recovery 存活、跨 Renderer reload 状态重放和集中 lifecycle latch；loopback same-origin 不是 Main authentication，端点必须 safe-for-same-origin 或使用不泄漏 Renderer 的 Main-only capability。跨进程 lease 是必须验证的真实成本。
- 2026-08-28：接受 P3-2～P3-4，补入 Windows npm shim、WinGet/native ambiguity、process-tree grandchild cleanup、所有终态 post-verify 与 Codex npm exit-0/unchanged fixtures。
- 2026-08-28：用户在 Claude Round 1 finding 回写后明确要求直接实施，因此 Phase 0 不再阻塞开工，但仍不标 `Review passed`。Phase 1 已加入 direct `rehype-sanitize@6`、`rehypeRaw → strict sanitize`、HTTP(S) URL gate 与恶意 HTML 回归测试；targeted 3/3、`tsc --noEmit` 通过，真实 UI/full/build 待末阶段统一执行。
- 2026-08-28：CLI executor 落在 Main，旧 HTTP executor 改 410 tombstone。Main 根据 selected binary fresh 推导 exact target，npm/bun/pnpm shim 必须对应 package root/bin，Homebrew 必须命中 cask prefix；Claude WinGet/native 无法唯一消歧时保持 manual-only。
- 2026-08-28：首版选择全局单 active CLI update，而非开放 target/manager 并行；这是更保守的序列化，不改变 Renderer/provider-only、app lifecycle latch 或 post-verify 合同。若未来增加 queued，排队期间不得提前占用 app latch。
- 2026-08-28：修复 implementation audit 发现的两个执行期竞态：cancel 在二次 proof 阶段也会阻止后续 spawn；utility recovery fork 前注入 provider+opaque lease bootstrap、healthy 后立即 reconcile，避免最多 5 秒 heartbeat 空窗。无法恢复 lease 会主动取消，不在无 gate 状态继续安装。
- 2026-08-28：targeted 15/15、`npm run test`（5419 pass / 0 fail / 1 skip）与 production `npm run build` 通过；Runtime Settings 在本地 browser dev smoke 中 DOM/视觉正常且 console 0 error/warn。Electron 持久更新卡片、真实 UpdateDialog、macOS disposable CLI 和 Windows clean VM 仍待完整 smoke，因此不标 Smoke passed / Release ready。
- 2026-08-28：按用户现场反馈把 12 秒 toast 改为左下角持久卡片；只有手动关闭才记录同版本 dismissal，更新中使用 spinner，失败持久保留重试，成功 post-verify 后显示完成 2.5 秒再消失。没有可信进度源时不伪造百分比。
- 2026-08-28：第一次真实 Electron 截图验收确认 generic toast 拉宽方案不合格：action/close hover 不清楚、宽度过长、缺 Provider brand 和解释文案；已改为 18rem 独立紧凑卡片、primary button、28px close target、Anthropic/OpenAI brand、current→latest 与兼容性说明。第二次截图确认中文、Codex v0.149.1→v0.150.1 和布局正确；同时拒绝 app-server `0.0.0` 占位版本。
- 2026-08-28：第二轮现场反馈指出 action 右对齐无对齐基准、close 作为第三个 flex child 独占一列；已将 action 改为随正文左对齐，close 改为右上角 absolute overlay，并加入 source-contract 防回归断言。
- 2026-08-28：Claude Round 2 复审给出 `fix_requested`：确认 `performUpdate` admission 跨 await 与 same-owner latch 重入可导致双更新/提前 release；确认 Homebrew named-cask outdated 使用 exit 1 + JSON。已在首 await 前同步占 starting+latch、将 latch 改 strict non-reentrant，并以真实同/异 Provider 并发行为测试钉住；Homebrew 只接受 parseable exit 0/1 exact JSON，其他失败为 unknown。P3 卡片 retry/dismiss/key 与新增 i18n 同步收口。
- 2026-08-28：Round 2 targeted 21/21、`npm run test`（5428 pass / 0 fail / 1 skip）、tsc/ESLint 与独立 dist production build 通过。默认 `npm run build` 因正在运行的 Electron dev client 持有 `.next/dev/lock` 按合同拒绝；未停止用户客户端，临时 build 目录验证后已删除。仍不标 Review passed / Smoke passed / Release ready。
- 2026-08-29：Claude 完整复审确认四个上一轮 finding 全部关闭，定向 21/21 复跑通过，结论 `accepted`。正式 `v0.67.11` run `33230535883` 的 source、Windows unsigned package、Linux 双架构、Mac Developer ID/公证/staple、arm64+x64 ABI、单一信任根、精确资产审计、attestation 与 draft→public 全绿；公开 Release 为 Latest + immutable。真实 UpdateDialog 富文本、CLI selected-channel before→after 与 Windows clean VM 仍按 Smoke Ledger 保持开放。
- 2026-08-29：另一台 macOS 设备升级 `v0.67.11` 后，截图证明 selected binary 是 ChatGPT.app 内置 Codex、Runtime candidate 已为 `desktop_bundle`，但 maintenance 显示 Standalone 并执行 self-update。根因是 channel classifier 把所有无扩展名 Codex 都判为 proven standalone；代码提交 `36d2879c` 将 macOS/Windows desktop bundle 识别提前，归 `managed_auto` 且禁用 one-click，并加入现场路径与独立 standalone 反例。targeted 11/11、完整 5441 pass / 0 fail / 1 skip；dev Renderer 未生成，UI smoke 不冒充通过；本次只提交、不发版。
- 2026-08-29：接受复审的非阻塞 P3 并立即收紧 owner proof：代码提交 `c19f031e` 让 macOS 不再锚定当前 `Resources/codex` 文件名，而将任意 `.app/Contents/**` 内 Codex 视为宿主应用所有；Windows 补 Microsoft Store alias 与已知 ChatGPT/Codex desktop `Resources/**` 布局，同时用官方 `AppData/Local/Programs/OpenAI/Codex/bin/codex.exe` 反例防止吞掉 standalone。Runtime discovery 与 maintenance 统一使用 `isCodexDesktopManagedPath`；targeted 59/59、完整 5441 pass / 0 fail / 1 skip，本次只提交、不发版。
- 2026-08-28：计划文档通过 docs drift、diff whitespace、公开文档 private-marker 与项目测试门禁；这些证据只证明计划可交接，不替代实施后的单元、集成、UI 与真实平台 smoke。
- 2026-08-28：本计划只进入 Claude plan review，不授予 push/tag/release，也不把计划完成标成产品 Code complete。
