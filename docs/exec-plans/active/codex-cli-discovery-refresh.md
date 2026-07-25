# Codex CLI 发现与刷新修复

> 创建时间：2026-07-20
> 最后更新：2026-07-20
> 状态：🟡 代码、Tier 2、production UI 与最终签名 `.app`/DMG/ZIP smoke 已完成；仅真实双版本共存终验仍待完成

## 用户问题与结论

用户在另一台 Mac 升级 CodePilot 0.58.1 后遇到两条连续故障：执行引擎显示 Codex「应用服务启动失败」；服务商页点击 Codex Account 后无可见反馈。用户随后确认机器曾同时存在低版本 Homebrew Codex CLI 与客户端内置的新 CLI；卸载 Homebrew 版本后，CodePilot 仍不会自动切换。

日志与真机证据把争议收敛为两个独立根因：

1. **主因不是版本排序错误，而是新版客户端漏进候选。** 日志在 2026-07-08 能发现 `/Applications/Codex.app/Contents/Resources/codex` 0.142.5，并正确压过 Homebrew 0.45.0；2026-07-13 起却只记录 Homebrew 为 `sole candidate`。2026-07-20 本机核实当前客户端路径已是 `/Applications/ChatGPT.app`，bundle id 仍为 `com.openai.codex`，内置 CLI 为 `/Applications/ChatGPT.app/Contents/Resources/codex` 0.145.0-alpha.18；源码只硬编码旧 `Codex.app`。
2. **安装变化不会让进程级缓存失效。** `findCodexBinary()` 首次解析后永久返回 `resolvedBinaryCache`；设置页刷新只重复 GET status，不重新扫描；卸载旧路径、安装新客户端或客户端 bundle 改名后，当前进程继续持有旧结论。

旧 Homebrew 0.45.0 又会因用户配置 `model_reasoning_effort = "xhigh"` 启动即 fatal，因此候选漏检最终表现为 app-server 不可用。0.58.1 的 fatal-stderr 快速失败是正确防线，不应通过覆盖用户配置或强制把 `xhigh` 改成 `high` 来掩盖 resolver 错误。

## 状态

| Phase | 内容 | 状态 | 用户可见验收 |
|------|------|------|--------------|
| Phase 0 | 日志、源码、当前客户端 bundle 真机核实 | ✅ 已完成 | 根因可由路径、版本、时间线交叉验证 |
| Phase 1 | 新旧客户端候选 + 缓存失效 + 安全重扫 | ✅ 已完成 | CodePilot 自动选择可用的最高版本 CLI；安装变化后刷新可恢复 |
| Phase 2 | 状态 source breadcrumb + Codex Account 失败反馈 | ✅ 已完成 | 设置页能看到实际 CLI 路径/版本；点击失败不再“没反应” |
| Phase 3 | Tier 2 tests / build / packaged smoke | 🟡 部分完成 | targeted 104/104、最终全量 unit 4422/4422、typecheck/build、production UI C3/C5/C6、签名 `.app`/DMG/ZIP 与 packaged Codex status 均通过；仅真实双版本共存待完成 |

## 决策与取舍

### 1. 候选发现保留版本择优，不恢复 PATH-first

候选优先级仍为 `CODEX_DISABLED` → 有效 `CODEX_BIN` → 自动发现候选；自动发现内部不是“PATH 永远赢”，而是**全部可执行候选按可解析版本最高者胜出**，仅同版本时保留 PATH-first tiebreak。必须同时兼容：

- `/Applications/ChatGPT.app/Contents/Resources/codex`（当前客户端）
- `/Applications/Codex.app/Contents/Resources/codex`（旧客户端）
- `~/Applications/ChatGPT.app/Contents/Resources/codex`（用户级安装）
- `~/Applications/Codex.app/Contents/Resources/codex`（用户级旧客户端）
- PATH 中的 `codex` / Windows shim（现有行为）

不要只把一个新硬编码字符串塞进现有 source-grep 测试；优先抽出可注入 `platform/home/path/exists/probe` 的候选发现纯函数，使四类安装布局与动态变化可做行为测试。

### 2. 自动失效看候选集合，显式刷新负责强制重扫

缓存不能继续是“进程永久有效”。建议缓存 `{ candidateFingerprint, selectedPath, probedVersions }`：

- 每次 availability 查询只做便宜的候选存在性扫描；候选集合未变则复用版本探测结果。
- 已选路径消失、候选新增/删除或显式刷新时，清 binary/version cache 并重新择优。
- 如果旧 binary 的 `spawn_failed` 属于已变化的候选 fingerprint，清掉旧 failure availability，让新候选回到 `installed_idle`/正常初始化；不能继续展示旧路径的失败。
- 同一路径原地升级的版本变化由显式刷新重新 probe；无需每次轮询都 spawn `--version`。

### 3. 不热杀 healthy app-server / active turn

刷新设置不能为了切版本而中断正在运行的 Codex turn。production rescan 合同：

- 当前没有成功初始化的 app-server（`unknown` / `installed_idle` / `spawn_failed` / `too_old`）时，可清失败与 discovery cache 后重扫。
- 当前 app-server 为 `ready` 时，刷新只报告“当前进程正在使用的 binary”；不 dispose、不切换。新候选在下次自然重启/进程重启时生效，UI 可提示“重启 CodePilot 后切换到新版本”。
- `disposeCodexAppServer()` 的退出职责与 discovery refresh 分开，避免一个普通刷新按钮变成隐式 Stop。

### 4. “刷新”必须真的触发后端 rescan

保留 status GET 作为非破坏性读取；增加显式 refresh API（建议 POST `/api/codex/status` 或独立 `/api/codex/refresh`）调用 production `refreshCodexBinaryResolution()`。`RuntimePanel.refreshCodexStatus()` 不再只增加前端 tick 后重复同一个缓存 GET。

### 5. 状态必须带真实 source breadcrumb

扩展 `CodexAvailability`，让 `installed_idle` / `too_old` / `spawn_failed` / `ready` 都能携带实际 `binary`，可选携带探测版本和选择 reason。设置页至少展示：

- 当前选中的 CLI 路径；
- 已探测版本或 app-server userAgent；
- 失败对应的路径；
- 刷新后是否发现新版本但需重启。

禁止显示“已安装/启动失败”却不给用户判断“到底用了哪个 Codex”的来源。

### 6. Codex Account 失败不能被 UI 条件吞掉

`ProviderManager.handleCodexLogin()` 失败会写 `codexError`，但添加卡片先关闭弹窗，且错误只位于“已有 OAuth 连接”时才渲染的 section。首次连接失败时用户看到的是零反馈。修复应满足其一：

- 请求期间保持添加弹窗，失败时 inline 展示错误并允许重试；或
- 关闭弹窗后发页面级 toast/error，渲染不依赖已有 OAuth 连接。

错误文案应引用后端返回的 selected binary/版本/失败分类，不把所有情况压成“应用服务启动失败”。

## 明确不做

- 不修改、覆盖或迁移用户 `~/.codex/config.toml`。
- 不在 spawn 时偷偷传 `-c model_reasoning_effort=high`；新 CLI 原生支持 `xhigh`，强制覆盖会改变用户语义。
- 不自动卸载 Homebrew CLI、不使用 npm `--force`、不删除任何第三方安装。
- 不在 active Codex turn 中热切换或 kill app-server。
- 不把 ChatGPT/Codex 客户端存在等同于已登录；账户状态仍以 app-server `account/read` 为准。

## 已知未覆盖 / Tech debt

- **Windows 客户端 bundle discovery 未覆盖。** 本次只保留并回归了 Windows PATH 下的 `.exe` / `.cmd` shim；尚未确认 Windows 版 ChatGPT/Codex 客户端是否内置 CLI、内置路径与升级语义。不能照搬 macOS bundle 路径猜测实现，后续需在真实 Windows 安装上核实后补候选与 packaged smoke。这不阻断本次 macOS P1 修复。

## 执行清单

### Phase 1 — Resolver

- [x] 在 `src/lib/codex/app-server-manager.ts` 抽出可测试的候选收集/指纹逻辑，加入新旧 bundle 的系统/用户级路径。
- [x] 保留 `CODEX_DISABLED` / `CODEX_BIN` / Windows `.cmd` 与版本最高者胜出的现有合同。
- [x] 候选集合变化或已选路径消失时一起失效 resolution、`versionProbeCache` 与失败 `lastAvailability`。
- [x] 增加 production refresh 原语；healthy/ready app-server 下不 dispose。
- [x] 让 availability 的失败与 ready 状态携带 selected binary breadcrumb。

### Phase 2 — API / UI

- [x] status GET 保持只读；POST status 执行显式 rescan。
- [x] `RuntimePanel` 刷新按钮调用 rescan，而不是只重复缓存 GET。
- [x] Runtime detail card 展示 selected binary + version/reason，处理中英文文案。
- [x] `ProviderManager` 首次 Codex Account 登录失败时保持添加弹窗并 inline 展示错误，可直接重试。
- [x] 本次没有新增 translation key；新增的中英文 inline 文案成对落地，无需改 i18n 字典。

### Phase 3 — Guardrail / Verify

- [x] 用行为测试替代旧的单字符串 source pin；同时覆盖 `ChatGPT.app` / 旧 `Codex.app` / 系统与用户级 Applications / 非 macOS 反例。
- [x] targeted tests 通过（104/104）。
- [x] typecheck + 全量 unit 通过（4417/4417；使用 Node `--test-force-exit` 绕过仓库测试进程的既有开放句柄）。
- [x] `npm run build` 通过（Runtime/Provider Tier 2 必跑）。
- [x] production UI smoke 验证刷新、breadcrumb、真实 Codex turn 与登录失败反馈。
- [x] 未完成签名的本机 arm64 `.app` 产物验证启动、ABI、C3 刷新恢复与 C6 登录失败反馈。
- [x] 修复 B-029 并完成签名 arm64 `.app`/DMG/ZIP、内容审计、health/Codex status 与 DMG checksum smoke。
- [ ] 在真实旧 Homebrew CLI 可用的 Mac 上补双版本共存终验。

## Required checks

| ID | 必须满足 | Evidence |
|----|----------|----------|
| C1 | 旧 PATH 0.45.0 + ChatGPT.app 0.145.x 共存时选择 ChatGPT.app | ✅ 版本择优行为测试 |
| C2 | 仅 ChatGPT.app、无 PATH CLI 时返回 installed/ready | ✅ 本机真实 bundle 返回 installed_idle，并成功 initialize 到 ready 后 dispose |
| C3 | 旧 CLI 已缓存后被卸载，点击刷新能改选客户端且旧 spawn_failed 消失 | ✅ production UI 与本机 arm64 `.app` 均用临时失效 shim 复现；删除 shim 后点击刷新改选 `ChatGPT.app`，旧失败消失 |
| C4 | Codex.app 旧客户端路径仍可发现 | ✅ 四路径行为回归测试 |
| C5 | ready/active turn 时刷新不 dispose、不 interrupt | ✅ 真实 Codex Runtime 请求返回 `SMOKE_OK`；发送后立即刷新，app-server PID `39712` 前后不变；`.app` ready 刷新 PID `61200` 前后不变 |
| C6 | 首次 Codex Account 登录失败有可见错误与重试入口 | ✅ production UI 与本机 arm64 `.app` 的 `CODEX_DISABLED=1` 反例均保持添加弹窗、显示 inline `role="alert"`、允许重试 |
| C7 | UI 展示的 binary/version 来自 resolver/app-server 真值 | ✅ availability/API/UI contract test |
| C8 | `npm run test` 与 `npm run build` 通过 | ✅ typecheck、最终全量 unit 4422/4422、production build 通过；unit 使用等价 direct runner + force-exit |

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|------|---------|----------|-------|---------|------|--------|----------|
| 2026-07-20 | codex_runtime | Codex Account | — | 本机客户端 bundle（不发模型请求） | 核实当前 `/Applications/ChatGPT.app` bundle id 与内置 CLI 版本 | ✅ 调研 | `com.openai.codex`; `codex-cli 0.145.0-alpha.18` |
| 2026-07-20 | codex_runtime | Codex Account | — | 本机客户端 bundle（不发模型请求） | 无 PATH CLI → resolver → initialize → ready → dispose | ✅ | selected `/Applications/ChatGPT.app/Contents/Resources/codex`; `Codex Desktop/0.145.0-alpha.18`; `codexHome=/Users/op7418/.codex` |
| 2026-07-20 | codex_runtime | DeepSeek via provider proxy | DeepSeek V4 Pro (1M) | 本机真实 provider 凭据 | production UI 发送最小 turn 后立即刷新 | ✅ | 返回 `SMOKE_OK`；app-server PID `39712` 前后不变；相关 5 个页面 console 0 error |
| 2026-07-20 | codex_runtime | Codex Account | — | 临时失效 `CODEX_BIN` shim + ChatGPT.app | 缓存旧路径并得到 spawn_failed → 删除 shim → 点击刷新 | ✅ | production UI 与 arm64 `.app` 均从临时路径切到 `/Applications/ChatGPT.app/Contents/Resources/codex`，旧失败消失 |
| 2026-07-20 | codex_runtime | Codex Account | — | `CODEX_DISABLED=1` 隔离实例 | 添加服务点击失败显示可操作错误 | ✅ | production UI 与 arm64 `.app` 均保持弹窗、inline `role="alert"` 可见、按钮可重试；console 0 error |
| 2026-07-20 | codex_runtime | Codex Account | — | 本机 arm64 `.app` | 启动 Electron 产物、native ABI、breadcrumb 与 ready 刷新 | ✅ | Electron 40.2.1 ABI compatible；稳定端口 47823；selected ChatGPT.app；PID `61200` 刷新前后不变 |
| 2026-07-20 | release | — | — | `electron:pack:mac` | 完整生成签名 DMG/ZIP | ❌ B-029 | standalone 误包含 `.claude/worktrees/.../release/.../Electron Framework.framework`，codesign 报 `bundle format unrecognized`；预签名 `.app` 可启动，但不得视为发布产物 |
| 2026-07-20 | release | — | — | 最终 0.58.2 arm64 `.app` / DMG / ZIP | standalone allowlist、签名、DMG 完整性与 packaged server | ✅ | standalone 仅 Next runtime 5 项，package 额外受控加入 `public/themes`；无本地 DB/上传/agent roots；`codesign --deep --strict` 与 `hdiutil verify` 通过；health 200，Codex GET/POST 选中 ChatGPT.app CLI |
| 2026-07-20 | release | — | — | v0.58.2 tag CI | source gate + macOS 双架构 + Windows x64 | ❌ | source gate、macOS arm64/x64、版本/ABI/checksum 均通过；Windows electron-builder 因重叠 extraResources 并发复制同一 `.next/server` 文件触发 `EBUSY`，Release job fail-closed 跳过；tag 保留，修复转 v0.58.3 |
| 2026-07-20 | release | — | — | 本地 v0.58.3 arm64 `.app` / DMG / ZIP | 互斥 extraResources、运行树完整性、签名与 DMG | ✅ | root runtime files / `.next` / `node_modules` 分组互斥；包内七个受控 runtime roots 齐全且无 DB/uploads/agent/Git 状态；`codesign --deep --strict`、`hdiutil verify`、版本 0.58.3 通过；Windows 真机由 tag CI 门禁 |
| 2026-07-20 | release | — | — | v0.58.3 tag CI + stable Release | source、macOS arm64/x64、Windows x64、Release assets | ✅ | Actions `29743547521` 全绿；Windows 已跨过原 `EBUSY` 点并通过版本/native ABI/checksum；stable Release 非 draft/prerelease，DMG/ZIP/EXE/SHA256SUMS 共 6 项资产均 uploaded |
| _待实施_ | codex_runtime | Codex Account | dynamic | 真实旧 Homebrew CLI + ChatGPT.app | 两版本共存选择新版 + initialize/model list | ⏳ | 当前以行为测试覆盖；仍需真实双安装 Mac 的 signed packaged log + selected binary breadcrumb |

## 调研验证记录

- `CODEX_DISABLED=1 node --import tsx --test ... codex-binary-discovery.test.ts`：**35/35 通过**。这证明现有旧 `Codex.app`、版本比较、Windows shim 与 fatal-stderr 防线基线正常；同时现有测试没有任何 `ChatGPT.app` 或安装变化后的 cache invalidation 用例，无法拦住本次回归。
- 调研阶段首次 `npm run test`：**环境阻塞**。当时 typecheck 在 `src/app/layout.tsx` 报 `geist/font/sans`、`geist/font/mono` 模块缺失；没有把未执行的全量单测记为通过。实施验证阶段补齐 lockfile 已有依赖后，typecheck、全量 unit 与 build 的最终结果见下节。
- `git diff --check`：通过。

## 实施验证记录

- `CODEX_DISABLED=1 node --import tsx --test ... codex-binary-discovery.test.ts codex-phase-6-wiring.test.ts`：**104/104 通过**。新增覆盖当前/旧 bundle 四路径、非 macOS 反例、PATH tiebreak、候选 fingerprint 变化、运行中 `CODEX_BIN` 变化触发 availability 失效、ChatGPT.app 高版本胜出、status POST rescan、healthy/pending refresh 不 dispose、Runtime source breadcrumb 与首次登录失败 inline error。
- `npm run typecheck`：通过。
- 最终全量 unit：`node --import tsx --test --test-force-exit ... src/__tests__/unit/*.test.ts` 在沙箱外 **4422/4422 通过**。直接 `npm run test:unit` 会被仓库既有开放句柄拖住不退出，因此使用 Node 22 的 `--test-force-exit` 得到完整汇总；沙箱内出现的 HOME 写入 EPERM 用例在沙箱外重跑均通过。
- `npm run build`：通过。沙箱内 Turbopack 因 PostCSS 子进程绑定本地端口触发 EPERM，按相同命令在沙箱外成功完成 125 个静态页面；仅有既有 dynamic filesystem trace warnings。
- 本机真实 bundle smoke：无 PATH CLI 时 resolver 选择 `/Applications/ChatGPT.app/Contents/Resources/codex`，availability 先为 `installed_idle`；沙箱外 initialize 成功返回 `ready`，userAgent 为 `Codex Desktop/0.145.0-alpha.18 ... (codex_codepilot; 0.58.1)`，随后正常 dispose（exit 0）。
- production UI smoke：基于生产构建执行仓库 `@smoke` 套件 **19/19 通过**；Runtime 真实显示 ChatGPT.app CLI path/version/codexHome。用临时失效 shim 构造旧路径 spawn_failed，删除后点击刷新自动切到 ChatGPT.app；最小 Codex Runtime turn 返回 `SMOKE_OK`，发送后立即刷新且 app-server PID 不变；`CODEX_DISABLED=1` 下首次 Codex Account 点击保持弹窗并显示 inline alert。5 个相关页面 console 均为 0 error。
- 最终 arm64 package smoke：严格 allowlist 后 standalone 只保留 `.next/node_modules/server.js/package.json/cache-handler.js`，electron-builder 额外加入受控 `public/themes`；包内无本地 DB、上传或 agent roots。`codesign --verify --deep --strict` 通过，`hdiutil verify` 通过；隔离启动 packaged server 后 health 200，Codex status GET/POST 均返回 `/Applications/ChatGPT.app/Contents/Resources/codex`。生成 `CodePilot-0.58.2-arm64.dmg` 与 `.zip`。

## 决策日志

- 2026-07-20：确认日志中的 `sole candidate` 表示客户端路径漏检；版本比较函数在旧 `Codex.app` 仍存在时曾正确选择 0.142.5，不重写已验证的“最高版本胜出”策略。
- 2026-07-20：真机确认当前 OpenAI 客户端 bundle 名为 `ChatGPT.app`、identifier 仍为 `com.openai.codex`、内置 CLI 0.145.0-alpha.18；决定同时保留 `Codex.app` 与 `ChatGPT.app`，避免客户端迁移期回归。
- 2026-07-20：缓存修复不得以 dispose healthy app-server 为代价；active turn 安全优先于运行中自动换版本。
- 2026-07-20：现有 discovery 定向测试 35/35 通过但覆盖不到新 bundle/cache 变化，确认属于测试缺口而非旧断言已失败；全量测试被本地缺失 `geist` 依赖阻塞，待实施 worktree 依赖完整后重跑。
- 2026-07-20：实现采用候选路径集合 fingerprint；每次 idle availability 做 exists-only 扫描，集合变化时同时清 resolution、version probe 与 failure availability；显式 POST refresh 覆盖同路径原地升级。
- 2026-07-20：Windows 仅保留 PATH shim 行为；Windows 客户端是否内置 CLI 记为已知未覆盖，不在没有真机证据时猜路径。
- 2026-07-20：本机当前 `ChatGPT.app` bundle 的 resolver + initialize smoke 通过；两版本共存和运行中卸载仍需在可控 packaged 环境验证，不伪造为已完成。
- 2026-07-20：production UI 与可启动 arm64 `.app` 的 C3/C5/C6 smoke 通过；临时 shim 仅模拟“已缓存旧路径消失”，没有冒充真实 Homebrew 0.45.0 共存，因此真实双安装终验仍保留待办。
- 2026-07-20：`electron:pack:mac` 暴露 B-029：standalone 误追踪项目内 `.claude/worktrees/**/release`，导致 codesign 递归进入嵌套 Electron Framework 后失败。该问题独立于 Codex resolver，但阻断 signed DMG/ZIP 与 `Release ready`。
- 2026-07-20：B-029 深挖发现 instrumentation NFT 还带入本地 `data/*.db`、`.codepilot` 与上传文件，风险从“签名失败”升级为“发布数据泄漏”。决定不依赖 route 级 excludes，而是在 Electron build 边界以最小 standalone allowlist 清理并 fail-closed；最终签名、内容、DMG 与 packaged server smoke 全部通过。
- 2026-07-20：0.58.2 实现与发布候选落于 commit `06dcc9f`；包含 Codex resolver/UI 修复、回归测试、standalone allowlist 安全边界、版本与 Release Notes。真实双安装终验作为 B-028 剩余项保留，不冒充本机已完成。
- 2026-07-20：v0.58.2 tag CI 的 source gate 与 macOS 双架构完整通过，Windows 在 electron-builder 复制阶段因 standalone root `**/*` 与专用 `.next`/`node_modules` FileSet 目标重叠触发 `EBUSY`；Release job 正确跳过。遵守 tag 不可变规则，不删除/重建 v0.58.2，资源组改为互斥并递增至 v0.58.3。
- 2026-07-20：v0.58.3 修复将 standalone root FileSet 收窄为三个根文件，与 `.next`/`node_modules` 专用 FileSet 互斥；新增配置合同测试 6/6、typecheck、全量 unit 4404/4404 通过。本地 arm64 `.app`/DMG/ZIP 再打包确认运行树完整、无私有数据、签名与 DMG 校验通过；最终 Windows 证据以 v0.58.3 tag CI 为准。
- 2026-07-20：v0.58.3 tag CI `29743547521` 的 source、macOS 双架构、Windows x64 与 Release 四个 job 全绿；Windows 版本/native ABI/checksum 通过，证明 FileSet 互斥修复在真实 Windows runner 生效。GitHub stable Release 已发布且 6 项资产全部 uploaded；本计划仍保持 🟡，仅因为真实旧 Homebrew CLI + ChatGPT.app 双安装 Mac 终验尚未执行。
