# Updater Guardrail

> **Status: Active contract** — 覆盖 Electron Main updater、channel/签名/metadata 信任边界、窄 IPC、活动任务保护与手工恢复。
> **为什么先读**：更新器能下载并执行新二进制；把 feed、路径或安装时机交给 Renderer，会把一次普通 XSS/内容注入升级为代码执行与数据丢失风险。

## 1. 词汇表

- **snapshot**：Main 持有并可重放的更新状态，只含版本、枚举阶段、低基数错误与有界进度。
- **stable feed**：electron-builder 为 immutable stable Release 生成的 `latest*.yml` 与其引用资产。
- **preview feed**：`X.Y.Z-preview.N` semver GitHub prerelease 中的 `preview*.yml` 与其引用资产；不与 stable 共用 metadata 名称。
- **manual fallback**：`/api/app/updates` 解析平台/架构后打开 GitHub Release；不是 native auto-update 成功。
- **active work**：任一 active chat stream、正在运行的 bridge 或 scheduler task。

## 2. 不变量 / 契约表

| # | 契约 |
|---|---|
| UP-01 | feed/provider/channel 只由打包配置与 Main 决定；stable 映射 builder `latest*`，preview 映射 `preview*`；Renderer 不得传 URL、路径、channel 或 updater options。 |
| UP-02 | native updater 只在官方 workflow 嵌入 provenance bit、packaged + (`stable` 或 `preview`) + macOS/Windows 同时成立时启用；官方 CI 还校验 `GITHUB_REPOSITORY=op7418/CodePilot`，dev/fork/local 默认 no-op。主动修改自身源码/信任配置的第三方 fork 不属于本 guardrail 能强制约束的边界。Windows publisher verification 必须读取实际 packaged `app-update.yml`：无 `publisherName` 才显示 unsigned，存在有效 publisher 才记 Authenticode，缺失/畸形配置关闭 native updater；不得从 `platform=win32` 猜测。Linux 在独立 signature/manifest 威胁模型与 packaged upgrade smoke 通过前只走手工/package-manager fallback。 |
| UP-03 | stable 固定 `allowPrerelease=false`，preview 固定 `allowPrerelease=true`；两者 `allowDowngrade=false`。设置 `autoUpdater.channel` 后必须再次压回 downgrade=false；`electron-updater` 必须 exact pin。 |
| UP-04 | 状态机只允许 idle/checking/available/downloading/downloaded/installing/error；download promise 存在或 phase 为 downloading/downloaded/installing 时拒绝并发 check，窗口重建重放 snapshot。`autoDownload=true` 时 `checkForUpdates()` 返回值里的 `downloadPromise` 也必须由 Main 立即持有并消费终态 rejection；不能只等 updater emitter，否则网络失败会逃逸成 process-level unhandled rejection。同一失败的 emitter/Promise 双源仍只能推进一次 error/backoff。 |
| UP-05 | 启动抖动检查，之后最多每 8 小时检查；失败指数退避。无更新、离线、用户稍后与 active-work 拒绝都不生成 Sentry Issue。 |
| UP-06 | 下载完成不强制退出。Main 在 install 前从本地 utility 查询 chat/bridge/task；无法证明 idle 时返回独立 `activity_unavailable` 并 fail closed。app updater install 与 CLI maintenance 必须原子竞争严格非重入的 `install-lifecycle-coordinator`：owner 标签不是 operation token，同 owner 第二次 acquire 也必须失败；CLI running 时保持 downloaded/retryable 并返回 `cli_update_running`，CLI update 也必须在 app installing/quitting 时拒绝启动。普通 quit/cancel/force 风险语义见 `CliMaintenance.md` CLIM-10。 |
| UP-07 | IPC 只暴露 get-status/check/retry-download/install 与只读 status listener；Main 校验 sender 是当前窗口的 `127.0.0.1:<serverPort>`。 |
| UP-08 | 日志不得包含 feed URL/query、缓存路径、installer 命令或 raw SDK error；只记录版本、枚举状态与整数进度桶。 |
| UP-09 | release notes 视为不可信 Markdown/HTML。Atom HTML 必须先 parse，再经 direct dependency 的 strict sanitize；禁止 script/event/style/SVG/form/image 与非 HTTP(S) URL，不能用 raw `dangerouslySetInnerHTML`。更新失败不阻断旧版启动和 Settings，始终保留平台正确的手工 fallback。若 GitHub 最新版本没有当前平台安装包，API 必须返回独立 `platformAssetMissing` breadcrumb，UI 明说“该版本未提供此平台安装包”，不得把 Release 页伪装成下载直链。 |
| UP-10 | installer、`latest*.yml`、blockmap、checksum/attestation 必须来自同一 immutable output，经 central audit 后一次发布。metadata URL 必须是当前版本裸 basename，checksum 按精确文件名集合核对，任何旧版本/额外 release payload 都失败。mac metadata 只引用 ZIP；后置 staple 的 DMG 只作手工 bootstrap，不进入 updater graph。Windows `latest.yml` 只引用完整 unsigned NSIS installer，并发布其外置 blockmap；发布后不改 metadata、不复用版本/tag，恢复只发更高 patch。 |
| UP-11 | `quitAndInstall()` 只是安装 handoff 请求，不是成功终态。Main 在 `before-quit-for-update` 前临时放行 close-to-hide；若同步抛错、updater error 或 15 秒内进程未进入真实 `before-quit` teardown，必须撤销 `isQuitting`、恢复窗口/托盘并回到 downloaded + `install_failed`，允许用户重试。 |
| UP-12 | chat 活动事实必须同时存在 active `runtime_status`（`running` / `streaming` / `waiting_permission`）与未过期 session lock；尤其不能漏掉正在输出 token 的 `streaming`。崩溃留下的裸 status/过期 owner 不得永久卡安装。一次只读 activity snapshot 不是跨请求原子准入栅栏；在 chat/bridge/task 共用带租约 fence 前，不得宣称“检查后绝无新任务启动”，残余竞态由 tech-debt #88 跟踪。 |
| UP-13 | stable GitHub Release 同时发布三平台安装包，发布 macOS signed/notarized ZIP updater graph 与 Windows unsigned NSIS updater graph；Linux 必须使用 `CODEPILOT_OFFICIAL_UPDATE_BUILD=0`，只允许手动安装包/checksum/attestation，不得出现 Linux updater metadata。Windows unsigned feed 只有在新鲜的 Immutable Releases 管理员确认、active 且无 bypass/exclude/重名的 default-branch no-delete/no-force 与 `v*` tag no-delete/no-update rulesets、管理员 no-bypass 状态与 live `id` / `updated_at` 无漂移、40-hex Action pins 与真实 RC-A→RC-B 门禁全部成立时才可公开；Actions token 隐藏 `bypass_actors` 时不得把缺失解释为空；preview Release 仍为 macOS-only。 |
| UP-14 | Windows differential update 必须显式保持 `nsis.differentialPackage=true` 与 `disableDifferentialDownload=false`。差分只是优先路径：旧 installer、blockmap 或 Range 请求不可用时必须回退完整 NSIS 下载；不得把理论节省比例冒充每次实测。 |

## 3. 关键文件 + 责任

- `electron/updater.ts`：单一 Main 状态机、electron-updater 策略、IPC 与日志。
- `electron/install-lifecycle-coordinator.ts`：与 CLI maintenance 共用的安装排他 owner；另一侧合同见 `CliMaintenance.md`。
- `src/lib/updater-contract.ts`：support/error/backoff/snapshot 纯合同。
- `electron/preload.ts`, `src/types/electron.d.ts`：窄 bridge 同形。
- `src/hooks/useUpdateChecker.ts`, `UpdateDialog.tsx`, `AboutSection.tsx`：snapshot 消费与手工 fallback。
- `/api/app/activity`：活动工作只读事实。
- `electron-builder.yml`, `.github/workflows/build.yml`, `.github/workflows/preview-release.yml`：feed、签名、发布平台范围与原子资产。

## 4. 改动检查表

- [ ] Renderer 是否完全不能指定 feed/channel/path/options？
- [ ] Preview tag 是否为 `X.Y.Z-preview.N` 的真实 semver、等于 `package.json`，且只发布 `preview*.yml`？stable 是否继续只读 `latest*.yml`？
- [ ] packaged/stable-or-preview/platform support 原因是否显式，local/fork 是否 no-op，Linux 是否未虚假宣称？
- [ ] check/download 是否去重，错误退避，窗口重建是否能 `getStatus()`？auto-download 的 nested `downloadPromise` 是否被 Main 显式消费，且与 error emitter 不会双计失败？
- [ ] 安装 handoff 失败/超时后是否撤销 quit latch、恢复 downloaded 与窗口，而不是永久隐藏旧版本？
- [ ] CLI maintenance active 时是否保持 downloaded/retryable；app updater owning latch 时是否拒绝 CLI child？
- [ ] install activity await 后是否重新确认 phase 仍是 downloaded；同一 app install 重复 invoke 不得被误报为 `cli_update_running`？
- [ ] Release Notes 是否保持 `rehypeRaw → strict rehype-sanitize`、HTTP(S)-only、无图片/主动内容？
- [ ] 安装前是否同时检查 chat/bridge/task，chat 是否要求 live owner、activity 查询失败是否拒绝退出？若改任务入口，是否评估 #88 的原子准入 fence？
- [ ] raw URL、缓存路径、installer 命令、SDK error 是否都未进入日志/Sentry/IPC？
- [ ] native 失败时 Settings 与 GitHub fallback 是否仍可用？最新 Release 没有当前平台资产时，是否展示 `platformAssetMissing` 而非假下载 CTA？
- [ ] dependency 是否 exact pin；metadata/blockmap/signature verifier 是否先于开启安装？
- [ ] stable 是否同时包含 Mac `latest-mac.yml`/ZIP blockmap 与 Windows `latest.yml`/EXE blockmap；Linux 是否关闭 official provenance且没有 metadata，preview 是否仍拒绝所有非 Mac 资产？
- [ ] Windows publisher breadcrumb 是否来自 packaged `app-update.yml` 而不是平台常量；unsigned UI 是否只对应无 `publisherName`；仓库 dated immutable/ruleset/Action SHA 门禁是否在 publish 前 fail closed？
- [ ] Windows NSIS 差分是否显式开启，并保留完整 installer fallback？
- [ ] targeted + full + build + packaged RC-A→RC-B clean-machine smoke 是否登记？

## 5. 常见坑

- `autoDownload=true` 不等于可以静默 `quitAndInstall()`；活动任务保护是独立门禁。
- `await autoUpdater.checkForUpdates()` 不等于等待自动下载完成；electron-updater 会把下载终态放在返回对象的 `downloadPromise`。不持有它会在断网时产生未处理 rejection。
- electron-updater 会先关闭窗口、后触发普通 `before-quit`；Main 必须在 `before-quit-for-update` 抬起 `isQuitting`，否则 close-to-hide 会制造假安装成功。
- 类型声明存在不代表 preload 已实现。Main/preload/types/hook 必须同一变更对齐。
- `ELECTRON_RUN_AS_NODE=1` 不能证明真实 Main→utility ABI，也不能证明 updater 能安装。
- GitHub Releases 百分比放量需要改 `stagingPercentage`；本项目不采用这种发布后 metadata mutation。
- 不要让 DMG 进入 `latest-mac.yml`：builder 生成 hash 后的公证 staple 会改写 DMG；mac updater 必须只引用 ZIP。
- 不要把调用 `quitAndInstall()` 当作不可逆成功；Electron 未进入真实 teardown 时必须有界回滚临时 quit latch。
- 不要用“quit 前再查一次 activity”冒充原子修复；若没有让所有 chat/bridge/task 启动路径在同一租约 fence 下 fail closed，TOCTOU 仍然存在。

## 6. 测试覆盖

- `updater-contract.test.ts`：平台/channel、错误分类、退避、Main-owned IPC、平台缺资产 UI 与下载中检查按钮 source contract。
- `cli-maintenance-security.test.ts`：app updater/CLI updater 同一 latch、普通 quit coordinator 与 reciprocal source contract。
- `release-notes-rendering.test.ts`：GitHub Atom HTML 正常结构、Markdown 兼容及 script/style/event/SVG/form/img/危险 scheme 反例。
- `updater-contract.test.ts`：以可控 Promise 行为测试 emitter-first / Promise-first 两种竞态都只记录一次失败且没有 `unhandledRejection`；同时钉住生产接线、downloading check 互斥、install handoff latch 回滚、无更新时清空旧 snapshot 字段，以及 `running` / `streaming` + live owner 会阻断安装、stale runtime_status 不冒充 live owner。
- `electron-packaging-hygiene.test.ts`：真实 Main→utilityProcess→SQLite package gate。
- 发布资产合同测试：stable 要求 macOS metadata/blockmap、Windows metadata/blockmap 与三平台 installer/checksum 的 central audit；混入 Linux updater metadata 必须失败，preview 混入任一非 Mac 资产必须失败。
- 真实 smoke：0.67.1→RC-A 手动 bootstrap；RC-A→RC-B native update，macOS arm64/x64 与 Windows x64。

## 7. 设计决策日志

- 2026-08-23：0.67.1 没有 updater，首跳只能手动 bootstrap，不能冒充 auto-update。
- 2026-08-23：采用后台检查/自动下载 + 用户确认重启；活动 chat/bridge/task 或 activity 不可判定时拒绝强退。
- 2026-08-23：不使用 `stagingPercentage`。先 internal preview 验证，再由用户授权 stable 全量；坏 stable 只发更高 patch。
- 2026-08-23：preview updater 使用等于 `package.json` 的 `X.Y.Z-preview.N` tag 与 `preview*.yml`；Main 映射 stable→latest、preview→preview，两个 feed 不由 Renderer 选择。
- 2026-08-23：Linux 在可信 manifest/repository 与真实升级证据完成前保持检测/手工安装，不显示假“自动更新”。
- 2026-08-24：安装 handoff 改为可回滚两阶段状态；只有 Electron 真实 `before-quit` 才锁定退出，15 秒无 teardown 或 updater error 都恢复旧版本 UI。downloading/downloaded/installing 期间不再启动新 check。
- 2026-08-24：activity chat 判定改为 active status ∩ 未过期 runtime owner，修复 crash residue 永久阻断；query→quit 的跨入口原子准入仍需租约 fence，明确登记 #88，不用二次 snapshot 伪关。
- 2026-08-24：复审发现 active status 枚举漏掉 Runtime 真实写入的 `streaming`，会把正在输出的会话误判为 idle；补齐 `running` / `streaming` / `waiting_permission` 三态与 live-lease 行为反例。
- 2026-08-24：用户决定本轮只发布 macOS 自动更新；stable/preview Release 收窄为 Mac updater graph，Windows/Linux 只保留 official provenance 关闭的手工构建入口。
- 2026-08-24：macOS-only 发布后，Windows/Linux 仍可发现新版本，但 API/UI 必须明确该版本没有对应平台安装包；Release 详情页不能冒充推荐下载。下载、已下载或安装阶段的检查按钮显示“更新进行中”并禁用，避免无反馈的重复检查。
- 2026-08-24：用户澄清目标是“Mac 自动更新 + Windows/Linux 手动包”，不是 Mac-only 分发。stable 同一 Release 恢复三平台安装包，API 继续按真实 platform/arch 选直链；只有 Mac 包带 official provenance 并消费 `latest-mac.yml`，Windows/Linux 不发布 updater feed。
- 2026-08-26：用户再次明确先交付 Windows 自动更新、Linux 延后，并接受不申请 Microsoft/Azure/PFX 签名。Windows stable 改为 GitHub single-trust-root unsigned NSIS updater：`latest.yml` + EXE blockmap + SHA-512；客户端/UI 不宣称 publisher verification。发布前新增 Immutable Releases acknowledgement、active main no-delete/no-force、`v*` tag no-delete/no-update rulesets与全 workflow Action SHA pin 门禁；既有 `v0.67.7` 仍需手动 bootstrap。
- 2026-08-27：生产 Sentry 证明 `checkForUpdates()` 本身 resolve 后，nested `downloadPromise` 的网络 rejection 会逃逸到全局。Main 现显式拥有该 Promise，并让 nested Promise 与 updater error emitter 共用基于 phase 的一次性失败 reporter；不通过全局 ignore 隐藏真实下载失败。Claude 复审后补 emitter-first / Promise-first 行为测试，证明两种竞态均 exactly-once 且不产生 `unhandledRejection`，不再只靠源码正则固定实现形状。
- 2026-08-28：app updater 与 CLI maintenance 改为竞争同一 Main lifecycle latch；CLI 运行时应用更新保持 downloaded，普通 quit 走等待/取消/明确 force 风险的统一 coordinator。GitHub Atom Release Notes 改为 parse 后 strict sanitize，不再把 HTML 当源码显示，也不放开 raw HTML 信任边界。
