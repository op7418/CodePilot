# ElectronMain Guardrail

> **Status: Active contract** — 覆盖主窗口安全与原生菜单、Electron 构建清理、standalone 内容边界、extraResources 互斥、native ABI 与 packaged server 启动门禁。
> **为什么先读**：主进程缺少完整 UI 自动化覆盖（tech-debt #6）；外链拦截、窗口管理、原生编辑菜单、better-sqlite3 ABI rebuild 和 packaged server 都在此边界，改错会让安全策略或发布产物失效。
> **已知关键文件**：`electron/*`、`scripts/build-electron.mjs`、`scripts/after-pack.js`、`scripts/after-sign.js`、`electron-builder.yml`。

## 词汇表

- **Main Process**：`electron/main.ts` 及其导入模块，拥有系统 API 和窗口生命周期。
- **Renderer**：Next.js 页面；不得直接获得 Node / Electron 主进程能力。
- **standalone**：Next.js `output: standalone` 产物，packaged server 的运行根。
- **packaged server smoke**：用产物内 Electron runtime 启动 `standalone/server.js` 并请求 `/api/health`。
- **FileSet destination**：electron-builder 把源文件复制到 `resources/` 下的目标路径；目标不得重叠。
- **native editing context menu**：主进程通过 Electron `role` 为 input / textarea / contenteditable 提供复制、粘贴等系统编辑动作。
- **native delivery owner**：始终由 Electron Main 领取 `electron-native` delivery；窗口可见性不会把 ownership 转给 Renderer。
- **OS accepted**：Electron `Notification` 发出 `show` lifecycle event。它证明系统接受展示请求，不等于用户看见或已读。
- **server recovery safe mode**：Electron Main 在 packaged Next utility 意外退出后持有的跨 generation 状态；通过只读 child env 注入，Renderer 无权自行清除。
- **descendant registry**：当前 utility generation 通过窄 lifecycle channel 登记其直接 child 的 role、PID、start identity、可执行文件 basename 与后代可验证性；Main 只用它决定能否重启，不凭不完整身份杀进程。
- **browser guest**：统一 Workspace Sidebar 中由 `<webview>` 创建的远端页面进程；它使用 Main 签发的 workspace partition，但没有 CodePilot preload、Node、CDP 或任意 host IPC 能力。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|---|---|
| 1 | better-sqlite3 必须在 after-pack 阶段重编译为 Electron ABI | `scripts/after-pack.js` |
| 2 | 构建前只清理 `release/` + `.next/` + `dist-electron/`，且先验证当前目录确为 CodePilot 项目 | `scripts/clean-electron-build.mjs` |
| 3 | standalone 根目录只允许 `.next`、`node_modules`、`server.js`、`package.json`、`cache-handler.js`；本地 DB、uploads、Git/agent/worktree 状态不得入包 | build scripts |
| 4 | `extraResources` 中 standalone root、`node_modules`、`.next` 的目标互斥；禁止 `**/*` 再叠加子目录 FileSet | `electron-builder.yml` + tests |
| 5 | stable Release 的 macOS、Windows、Linux 产物都必须校验版本、native ABI 与 packaged server health 后才能上传；macOS 使用 signed/notarized updater，Windows 使用明确无 Authenticode 的 GitHub-single-root updater，Linux 只作手工分发且 official updater provenance 必须关闭 | build workflow |
| 6 | 主窗口外部导航必须经过 `classifyNavigation`；非 http/https 协议不得交给系统 shell | `electron/main.ts` + tests |
| 7 | Renderer 的 input / textarea / contenteditable 使用 Electron role 菜单；密码框不得启用复制、剪切 | `attachRendererEditingContextMenu` |
| 8 | Grok Build browser OAuth callback 只绑定 `127.0.0.1`，生产由 OS 分配动态端口；authorize/token exchange 必须复用同一 redirect URI | OAuth manager |
| 9 | packaged 无法打开浏览器或 loopback 不可用时必须明确提供 device-code 登录 | Settings UI + routes |
| 10 | packaged Next server 的 xAI OAuth fetch 必须显式消费代理 dispatcher，不能假设 Node fetch 自动读取 env | `electron/main.ts` + env proxy fetch |
| 11 | Electron → packaged Next child env 保留显式 proxy、缺省时补 system proxy，并合并 loopback `NO_PROXY`；Windows 不得传大小写重复 key | process proxy env |
| 12 | bundled Codex 的 Windows system-proxy-only 路径必须以 packaged smoke 证明；静态 source pin 不能替代 | Windows release smoke |
| 13 | macOS 原生窗口材质必须跟随 app 的 `system/light/dark` 模式；IPC 只接受这三个枚举，renderer 外围保持透明，不能用高不透明度 CSS 遮罩伪造主题同步 | `ThemeProvider` + preload/main bridge + tests |
| 14 | macOS 整窗默认材质为 `under-window`；比较其他材质时用 `ELECTRON_VIBRANCY` 诊断开关，不能靠恢复高不透明 tint 调整磨砂强度 | `electron/main.ts` + `platform-marker` source-pin |
| 15 | HTML 缩略图 IPC 只接受当前 renderer 同源、无 interactive 参数且首段为一个完整 canonical `ws.<base64url absolute path>` 的 strict preview URL。派生后的精确 scope 才能进入 `webRequest` allowlist；包含性 token、前后缀和编码分隔符都 fail closed | `electron/html-thumbnail-security.ts` + main IPC |
| 16 | AI 输出的本地路径不得进入通用 `shell.openPath`。`/api/files/inspect` 只接受绝对路径 + `sessionId` 或固定 `home` scope，由服务端推导根并返回 canonical `realPath`；主进程在 OS 调用前再次 realpath/stat。目录只能 `showItemInFolder`，bundle 目录拒绝；文件只允许 workspace `.html/.htm` 走专用 open IPC | `local-path-security` + DevOutput / PreviewPanel / DiffSummary + inspect route + main IPC |
| 17 | `/api/files/open` fallback 不得拼 shell 字符串；可执行文件固定、路径只能作为单个 argv，`shell: false`，且 scope/realpath/bundle 规则与主进程一致 | files/open route + tests |
| 18 | 默认助理路径 IPC 无输入，只返回 `path.join(app.getPath('documents'), 'CodePilot', 'Assistant')`；不得演变成 Renderer 可控的通用路径 resolver | `default-assistant-home.ts` + main/preload |
| 19 | `electron-native` 只有 Main 一个 consumer，visible/hidden/tray 不切 owner；所有新 notification event 无论 priority 都只创建 native delivery，Renderer 不再挂载 delivery consumer，claim/ack HTTP 面也只接受 Electron Main 的 `electron-native`。`renderer-toast` 仅保留为历史审计/迁移 literal；Settings 测试动作走独立 same-origin policy | notification manager + claim policy + native delivery service + AppShell |
| 20 | native delivery 只有收到 `show` event 才 ack delivered；共同 throw/unsupported/timeout 收口 error，Windows 额外监听 `failed`，macOS/Linux 不等待不存在的事件 | `notification-lifecycle.ts` |
| 21 | 提示音服从系统 policy：macOS 使用 `sound:'default'` 且 `silent:false`，Windows/Linux 使用平台默认且不自播放音频；最终能力必须由对应 packaged smoke 证明 | native options builder + release smoke |
| 22 | 已 show 的 Notification 对象在 click/close 前由有界 retention 保活；点击在 Renderer ready 前进入有界队列，ready handshake 后按 event id 幂等投递。action 只能解析为应用内 route 或已验证的 task/session fallback | `notification-lifecycle.ts` + `notification-click-queue.ts` + main/preload/hooks |
| 23 | native delivery 的 stale claim lease 必须长于单次通知 lifecycle timeout，并保留可观测余量；调整 show timeout 时必须同步复核 lease，避免仍在等待系统回调的 delivery 被第二个 consumer 重新领取 | notification claim policy + native delivery service |
| 24 | 浏览器可触发的 HTML preview URL 只接受本机 POSIX 或 Windows drive 路径；UNC、SMB 与 Windows device namespace 必须在任何 `stat/realpath/readFile` 前拒绝，避免任意网页通过 loopback GET 诱发网络认证出站 | `html-preview-url.ts` + preview route |
| 25 | macOS 默认钥匙串缺失/未配置时，不得直接进入 Claude Code 的凭据 item 探测或 Electron `safeStorage`，避免系统 modal 阻塞会话。探测只能读取 default-keychain 配置与文件存在性；仅在确认不可用时给 Claude subprocess 前置窄 `security` shim，且只拒绝 `Claude Code*` service 与无参数 `show-keychain-info`，其他 argv 必须原样转发 `/usr/bin/security` | `macos-keychain-guard.ts` + packaged shim + Main/SDK env |
| 26 | 所有 `shell.openExternal` 返回的 Promise 必须由同一个边界消费。失败时只记稳定 reason code，不得记录 URL/query 或原始 OS 文本；用户必须收到按系统 locale 选择的默认浏览器修复提示，提示本身失败也不得产生 unhandled rejection | `external-navigation.ts` + `electron/main.ts` |
| 27 | packaged Next utility 的 unexpected exit 必须立即暂停 native poll，并切到不依赖 Next 的本地恢复页；intentional quit 不得触发恢复 | `server-supervisor.ts` + `electron/main.ts` |
| 28 | 自动恢复固定使用原 stable port，按 1s/2s/4s 退避，10 分钟最多 3 次；`/api/health` 成功前不得 reload route 或恢复 poll，持续健康 60s 才重置预算 | supervisor + Main |
| 29 | recovery safe mode 只由 Main 持有并经 `CODEPILOT_RECOVERY_SAFE_MODE` 注入。safe child 不得启动 Codex app-server 或 scheduler；Codex Runtime composer 必须显示原因并禁用发送 | Main + instrumentation + Runtime UI |
| 30 | descendant lifecycle 消息只接受当前 utility generation，register/unregister 必须精确匹配 PID + start identity + role + basename。live、PID 复用或更深树不可验证时 fail-closed 停在错误页；不得仅凭 PID/basename自动 kill | lifecycle contract + registry |
| 31 | Utility fatal report 原文不得写日志或复制诊断；只允许 reason、退出码、heap/RSS/private/host memory 等纯数值。恢复页 IPC 只接受当前 data: recovery renderer | Main + preload + recovery tests |
| 32 | blocked（ownership 不可证明）状态**不得提供任何可成功调用的 relaunch 入口**：descendant registry 是 per-Main 内存态，relaunch 后为空，会绕过 single-owner 门禁。blocked 页只渲染「退出应用」；Main restart handler 必须显式拒绝 blocked，quit handler 必须反向限定只接受 blocked，source-pin 断言状态门禁位于 `app.relaunch()` 前。给 blocked 加回自动/一键重开前必须先落地跨 relaunch 的持久化 registry 重验证（tech-debt #85） | `server-recovery-page.ts` + Main IPC + recovery tests |
| 33 | packaged Next utility 的运行期 fatal/error/unexpected exit 在 stable opt-in telemetry 中每个 generation 最多捕获一次；只传稳定枚举、平台定义的有界整数退出码与 utility/host memory 数值。负 POSIX/launch-failure sentinel 不得被当作无效内存指标丢弃。已知 Windows logoff/OS teardown 状态是 expected lifecycle，因此不上报；但只凭退出码不能证明整个 app 正在 teardown，只要 Main 尚未进入独立的 `isQuitting` 生命周期门禁，仍走既有 bounded recovery。其他 unexpected exit 按低基数 exit class 分组，精确 code 不进 fingerprint。Electron diagnostic report 原文必须在 Main 边界丢弃，不得进入日志、Sentry 或恢复页 | `utility-process-failure.ts` + Main + telemetry/recovery tests |
| 34 | stable/preview macOS distributable 必须是 Developer ID Application 签名且 `TeamIdentifier` 精确匹配发布配置；证书打包步骤使用 `CSC_LINK` 时必须允许 electron-builder 发现并选择导入的身份，除非同时配置了显式 identity。缺证书、ad-hoc、Team ID 不一致、最终 bundle deep/strict 失败都必须阻断上传。最终 `codesign` inspect/deep verify 自身必须有进程级硬超时，不能只依赖 CI step timeout；ad-hoc 只允许显式本地包，不能作为发布证据 | `after-sign.js` + `verify-macos-developer-id.mjs` + workflows |
| 35 | packaged recovery smoke 跳过 provider Safe Storage 只允许 exact flag + packaged app + canonical realpath 位于 `os.tmpdir()/codepilot-packaged-recovery-*`；flag 不得传给 Next/Agent child。真实 userData、dev mode、symlink/不存在路径和近似 flag 全部 fail closed | `provider-secret-startup-policy.ts` + Main + recovery smoke/tests |
| 36 | 数据库启动在分配 stable port 前失败时，“再试一次”仍必须能重新启动 utility，IPC 返回真实 accepted 而非乐观 `true`。migration/runtime 原始错误只允许以有界、路径/凭据脱敏的 marker 写本地日志并进入“复制诊断”；不得把动态根因塞进低基数 startup code 或 Sentry message | `electron/main.ts` + `database-recovery.ts` + recovery tests |
| 37 | DB health marker 是已完成的启动分类，Main 必须绕过通用 30 秒 wait 立即进入离线页。Main 与 utility 共用同一个 data-dir resolver；fresh-start 后文件重现时只暴露 fixed-path、trusted recovery-renderer IPC，让用户明确保留当前库或在旧备份重新校验后继续，Renderer 不得提交数据库路径 | Main + preload + recovery page/tests |
| 38 | Browser guest 只能使用 Main 为 canonical 64-hex workspace id 签发的 `persist:codepilot-browser-*` partition；`will-attach-webview` 必须核对已签发 partition 与允许 URL、删除 preload，并强制 `sandbox/contextIsolation/webSecurity=true`、Node/subframe Node/Worker Node/nested webview/insecure content=false。Preload 不得暴露 Main WebContents/Session/CDP/通用 execute bridge；DOM `<webview>` 的 host 控制面按下文残余风险处理 | `browser-surface-security.ts` + Main/Preload + BrowserPanel |
| 39 | Browser 顶层导航只允许 HTTPS、loopback HTTP 和 exact `about:blank`；remote HTTP、credentials、file/data/javascript/未知 scheme fail closed。guest permission check/request 默认全部拒绝，download 当前全部阻断并显示诚实 UI；popup 只能转受控 tab，不能创建未管理窗口 | `browser-url-policy.ts` + Main handlers + BrowserPanel |
| 40 | CLI maintenance 与 app updater install 必须竞争同一个 Main-owned lifecycle latch；latch 对同 owner 也不可重入，CLI duplicate guard + starting 占位 + acquire 必须在首个 await 前同步完成。utility recovery fork 前注入 active provider+opaque lease id，正常 Renderer/后台任务恢复前完成 lease reconcile。普通 quit 在 CLI update active 时必须等待或走取消→进程树清理→post-verify；详见 `CliMaintenance.md` / `Updater.md` UP-06 | `cli-maintenance.ts` + `install-lifecycle-coordinator.ts` + Main quit/recovery |

## 关键文件 + 责任

| 文件 | 责任 |
|---|---|
| `electron/main.ts` | 主窗口生命周期、导航拦截、原生编辑右键、托盘与系统集成 |
| `electron/html-thumbnail-security.ts` | HTML 缩略图 strict URL 解析、精确 request scope 与串行 deadline |
| `scripts/clean-electron-build.mjs` | 清理边界与 standalone allowlist |
| `scripts/build-electron.mjs` | Next standalone 复制与脱敏 |
| `scripts/after-pack.js` | better-sqlite3 ABI rebuild |
| `scripts/after-sign.js` | macOS 签名后处理 |
| `electron-builder.yml` | DMG / NSIS / arm64 + x64 打包配置 |
| `electron/preload.ts` + `src/components/layout/ThemeProvider.tsx` | app 主题到 `nativeTheme.themeSource` 的窄 IPC 桥 |
| `src/lib/xai-oauth-manager.ts` | loopback server 生命周期与端口策略 |
| `src/lib/env-proxy-fetch.ts` | packaged server 上游 HTTP(S) system-proxy bridge |
| `src/lib/process-proxy-env.ts` | child-process proxy 优先级、Windows key 归一与 bypass |
| `src/lib/local-path-security.ts` | 主进程/Next fallback 共用的绝对路径、bundle、HTML 扩展与固定 argv 策略 |
| `src/lib/local-path-navigation.ts` + `/api/files/inspect` | Renderer 本地路径 file/directory 分流；服务端从 session/home 推导 scope 并返回 canonical `realPath` |
| `electron/default-assistant-home.ts` | 默认助理 Documents 路径的无副作用纯解析 |
| `electron/notification-lifecycle.ts` | 平台 notification options 与 show/error/timeout 终态 |
| `electron/notification-click-queue.ts` | 点击 action 校验、有界 pending queue 与 event-id 去重 |
| `electron/external-navigation.ts` | HTTP(S) system-browser Promise 所有权、本地化失败提示与隐私边界 |
| `electron/browser-surface-security.ts` + `src/lib/browser-url-policy.ts` | workspace partition、固定 guest preferences 与共享 URL policy |
| `src/components/layout/WorkspaceSidebar/BrowserPanel.tsx` | 单个 Browser tab 的 guest 生命周期、实际导航/loading 事件、错误/崩溃 UI；tab 身份由 Workspace Sidebar 持有，preload 不暴露 Main `WebContents`/Session/CDP handle |
| `electron/server-supervisor.ts` | crash window、有限 backoff、safe-mode ownership 与健康重置 |
| `electron/server-descendant-registry.ts` + `src/lib/server-lifecycle-contract.ts` | generation/identity 校验与 single-owner restart gate |
| `electron/server-recovery-page.ts` | 不依赖 Next 的本地化错误面与 CSP |
| `electron/cli-maintenance.ts` + `electron/install-lifecycle-coordinator.ts` | CLI update owner、utility recovery lease bootstrap 与 app updater/quit 排他生命周期 |
| `src/lib/macos-keychain-guard.ts` + `resources/macos-keychain-guard/security` | default-keychain 只读探测、Claude credential 非交互降级与 packaged shim |

## 改动检查表

- [ ] 改 `BrowserWindow` / `webContents` 事件时运行 `electron-main-security` 与 `workspace-context-menus`
- [ ] 改 Browser guest 时同时覆盖：canonical workspace/partition、伪造 partition、preload 删除、Node/sandbox/contextIsolation、HTTPS/loopback/remote HTTP/scheme/credentials、permission/download/popup 与实际 Electron guest smoke
- [ ] `<webview>` 仅限统一 Browser surface；不得新增通用 webview factory、CDP/executeJavaScript preload API，或把 Provider/Agent 权限映射成网页权限
- [ ] 编辑右键菜单保持 Electron `role` 实现，避免硬编码快捷键或绕过密码保护
- [ ] 改 after-pack / native module 后完整打包并确认产物可启动
- [ ] 修改 `extraResources` 时检查所有 FileSet destination 不重叠
- [ ] 修改 standalone 资源时确认 `.next/node_modules` 的 Next.js 哈希 external alias 被显式打包
- [ ] 运行 `scripts/verify-packaged-server.mjs`，确认产物 `/api/health`
- [ ] 审计 packaged standalone 不含 DB、uploads、`.codepilot`、`.claude`、`.git` 或嵌套 release
- [ ] OAuth/代理改动在 macOS 与 Windows 分别验证 browser/device/cancel/端口占用和外网代理
- [ ] 改 macOS vibrancy / theme bridge 时运行 `native-theme-sync` 与 `platform-marker`，并在真实 Electron 窗口分别切换浅色、深色；两种模式的 body/window surface 都保持 transparent
- [ ] 改 HTML thumbnail IPC/preview route 时运行 `electron-main-security`，覆盖 canonical token、包含性 token、编码分隔符、同源 scope、超时释放与外部请求拒绝
- [ ] 改聊天本地链接或系统路径消费方时覆盖：HTTP(S)、相对路径、工作区文件/目录、外部确认、symlink escape、`.app/.workflow` bundle、`.command` 非 HTML 与 Electron 错误字符串
- [ ] Renderer 不得新增通用 `openPath(path)` bridge；目录意图使用 scoped `revealPath`，HTML 使用 scoped `openHtmlFile`
- [ ] 改 native notification 时验证 Main 单 owner、visible/hidden 不切 owner、server restart stale claim 可恢复，且 Renderer 没有重新挂载 notification delivery poll
- [ ] 文案把 delivered 描述为“系统已接受”，不写“用户已读”
- [ ] notification click 覆盖 before-ready、reload 和 duplicate event；队列必须有上限
- [ ] 已 show notification 的 JS 对象在 click/close/TTL 前保持引用，retention 必须有数量与时间上限
- [ ] 调整 native notification lifecycle timeout 时同步核对 stale claim lease；当前 12s timeout / 30s lease 不得被改成 timeout ≥ lease
- [ ] 默认助理 fixed-path IPC 保持无参数，路径 fixture 覆盖 macOS/Windows/Linux 分隔符
- [ ] HTML preview wire 变更覆盖 forged workspace token 与 Windows root token；`\\server\share`、`//server/share`（Windows）和 `\\?\` 必须在文件 I/O 前 fail closed
- [ ] 改 macOS 凭据启动链时覆盖：健康 default keychain 不改 PATH；缺失/未配置时不调用 `safeStorage`；shim 只拦 `Claude Code*` credential service、其余命令固定 `exec /usr/bin/security "$@"`；不得用 `password-store=basic` 或 `CLAUDE_CODE_SIMPLE` 扩大降级面
- [ ] 改 macOS 打包签名时验证最终 `.app` 的 Developer ID + exact Team ID + deep/strict；`CSC_LINK` 证书步骤不得在未配置显式 identity 时关闭 `CSC_IDENTITY_AUTO_DISCOVERY`；不得用 afterSign 中间态或 ad-hoc 包冒充正式发布证据
- [ ] 最终 artifact verifier 的每次 `codesign` 调用都有显式 timeout + kill signal；超时必须 fail closed，不能进入 checksum/upload
- [ ] recovery smoke 的 Safe Storage bypass 必须保留 packaged + canonical temp userData 双门禁，并覆盖 symlink/真实 userData 反例；flag 不得进入 child env
- [ ] 改外链导航时两个入口（`setWindowOpenHandler` / `will-navigate`）都走 `openExternalSafely`；拒绝 Promise 与失败 dialog 自身拒绝均必须被消费，日志/提示不得回显目标 URL 或 OS error。
- [ ] 改 utility fork/recovery、app quit 或 updater install 时运行 `cli-maintenance-security`；确认 recovery bootstrap lease 先于 Runtime 恢复、CLI/app updater 同 latch、取消后等 cleanup+post-verify。
- [ ] 改 packaged server lifecycle 时覆盖 intentional quit、单次/连续 crash、health-before-reload、poll pause/resume、stable port、safe-mode env 与 descendant fail-closed。
- [ ] 运行期 crash recovery 的发布证据必须来自 packaged app；Node source-pin/单测只能证明状态机和接线，不能标 `Smoke passed`。
- [ ] 改数据库启动恢复时覆盖 stable port 尚未赋值的 retry；IPC 必须返回实际结果。复制诊断只含脱敏 startup marker，不得包含 home、绝对路径、URL、token 或原始环境。
- [ ] 改 DB recovery 页时覆盖 marker 快速失败、共享 data dir、fresh-start conflict 两个 fixed-path 动作与备份 tamper；任何重现文件都不得由 bootstrap 自动删。

## 常见坑

- tech-debt #6 — 现有 Playwright 主要覆盖 web 层，主进程变更仍需 packaged 人工验证。
- `webviewTag:true` 只是创建能力，不是信任；没有 `will-attach-webview` 的 issued-partition gate 与二次 hardening 时，Renderer XSS 可伪造 guest/preload。即使有 gate，host Renderer 仍天然拥有 DOM `<webview>` 控制面；当前合同只隔离不可信 guest，不把 host Renderer compromise 声称为已由 `<webview>` 解决。若要收紧这条边界，必须回到 Main-owned view 路线。
- Electron 不自动给 renderer 输入框提供复制/粘贴菜单；逐组件实现会漏掉 CodeMirror / contenteditable。
- `context-menu.selectionText` 不能作为密码字段可复制依据；还要检查 `inputFieldType` 与 `editFlags`。
- v0.34 crash on upgrade 根因是 `dist-electron/` 未清理，stale artifacts 进入 app.asar。
- v0.58.2 Windows 构建暴露重叠 FileSet 的 `EBUSY`；资源组目标必须互斥。
- v0.58.3 `.next/node_modules` 被过滤导致 packaged server 无法启动；哈希 alias 必须独立复制并真实启动验证。
- OAuth loopback 在 web/dev 通过不代表 packaged 可用。
- Windows env key 是大小写不敏感语义；禁止用对象 spread 顺序决定 proxy。
- 不要用 `session.setProxy({ mode: 'direct' })` 解决 Codex loopback；它会关闭 Chromium 外网代理且管不到 app-server。
- `scripts/after-pack.js` 会把工作区 better-sqlite3 重编成 Electron ABI；之后跑 Node/Next 前需 `npm rebuild better-sqlite3` 恢复 Node ABI。
- 不要用 `pathname.startsWith('/api/files/html-preview/ws.')` 代替 workspace token parser；前缀命中不是完整 segment，也不能证明 canonical base64url 或绝对 workspace root。
- 不要根据 `mainWindow.isVisible()` 在 Renderer 和 Main 间切换 native consumer；切换窗口会产生重复或漏投。
- 不要在调用 `notification.show()` 后立刻写 delivered；生命周期终态来自 `show` event，且需要有界 timeout。
- 不要只调大 native notification 的 show timeout；它必须始终短于 stale claim lease，否则同一 delivery 可能在首次消费尚未结束时被再次领取。
- 不要只依赖 CI job/step timeout 兜底 `codesign`；final artifact verifier 应在命令边界终止卡死进程并返回非零。
- 不要用 Web Notification 或 renderer toast 作为 packaged Electron native notification 的成功证据。
- 不要在 utility `exit` 后直接 `startServer()`：先停 poll、核对 generation registry，再走 bounded supervisor。无法证明孙进程已退出时宁可停在错误页。
- 不要记录 Electron UtilityProcess diagnostic report 原文；它可能含 argv、环境和绝对路径。

## 测试覆盖

| 契约 | 测试文件 |
|---|---|
| 主进程 E2E | tech-debt #6：待搭 `@playwright/test` + `_electron.launch()` |
| 外部导航与 export 边界 | `src/__tests__/unit/electron-main-security.test.ts` |
| 原生输入框编辑右键结构 | `src/__tests__/unit/workspace-context-menus.test.ts` |
| 清理、standalone allowlist、extraResources 互斥 | `src/__tests__/unit/electron-packaging-hygiene.test.ts` |
| packaged version + native ABI + server health | `scripts/verify-packaged-server.mjs`, build workflow |
| xAI loopback / proxy / child env | 对应 xAI、env-proxy、process-proxy 单测 + packaged smoke |
| 原生主题枚举、preload/main bridge、透明 surface | `src/__tests__/unit/native-theme-sync.test.ts` + `platform-marker.test.ts` |
| HTML thumbnail canonical scope、外联阻断与 deadline queue | `src/__tests__/unit/electron-main-security.test.ts` |
| Browser partition、URL policy、attach hardening 与 preload capability shape | `browser-surface-security.test.ts` + `electron-main-security.test.ts` |
| 聊天本地路径分类、canonical inspect、bundle/协议拦截与窄系统能力 | `local-link-detector.test.ts` + `local-path-navigation.test.ts` + `markdown-contract.test.ts` + `electron-main-security.test.ts` + `asset-library-ui.test.ts` |
| 默认助理 fixed-path、native lifecycle、点击队列、全 priority native 与 Main 单 owner | `default-assistant-bootstrap.test.ts` + `electron-notification-lifecycle.test.ts` + `bg-poller-channel-parity.test.ts` + `bridge-delivery-visibility.test.ts` + `interactive-chat-notifications.test.ts` |
| HTML preview 本机路径限制、UNC/device token 拒绝 | `html-preview-url.test.ts` + `html-preview-route.test.ts` |
| macOS default-keychain 探测、Claude credential shim、safeStorage 前置门禁、packaged resource | `macos-keychain-guard.test.ts` + `provider-secret-electron-contract.test.ts` + `electron-packaging-hygiene.test.ts` |
| 外链默认应用失败、反馈失败与隐私日志边界 | `electron-external-navigation.test.ts` + `electron-main-security.test.ts` |
| utility supervisor、offline page、safe mode、descendant identity、poll/reload 顺序 | `electron-server-recovery.test.ts` + `scripts/smoke-packaged-server-recovery.mjs` |
| 数据库启动前 retry、marker 快速失败、fresh-start conflict 与 migration/runtime 脱敏诊断 | `electron-server-recovery.test.ts` + `database-integrity-recovery.test.ts` |
| CLI maintenance 窄 IPC、utility recovery bootstrap、进程树 finalizer、app updater/quit latch | `cli-maintenance-contract.test.ts` + `cli-maintenance-runner.test.ts` + `cli-maintenance-security.test.ts` |

## 设计决策日志

- 2026-07-20 — standalone 最小 root allowlist，并在打包边界 sanitize + fail-closed。
- 2026-08-07 — Windows 0.64 真实 `shell.openExternal` association failure 被全局 unhandled-rejection 捕获；两个外链入口统一进入可测试 Promise owner，失败给本地化默认浏览器提示且不记录动态 URL/系统正文。
- 2026-07-20 — Windows 重叠 FileSet 改为互斥资源组；packaged server health 升为发布门禁。
- 2026-07-21 — xAI OAuth 首版采用固定 loopback browser PKCE + device-code 双路径；固定端口已由 2026-08-13 Grok Build 动态 loopback 合同取代。
- 2026-08-13 — Grok Build 生产 browser flow 改为 OS 动态 loopback 端口；pending flow 保存 redirect URI并供 token exchange 原样复用，旧 56121 占用不再阻断浏览器登录。
- 2026-07-27 — Electron child env 改为显式 proxy 优先 + system fallback + loopback bypass。
- 2026-07-29 — 输入框右键统一放在主进程 `webContents.context-menu`，业务对象右键仍由 Renderer 负责。
- 2026-07-30 — 用户否决用 82% window / 88% sidebar renderer tint 解决深色可读性：它会遮住浅/深两种模式的原生磨砂。改为 app mode 经窄 IPC 同步 `nativeTheme.themeSource`，外围透明、侧栏只保留 40% tint；见 `569b117d`。
- 2026-07-30 — Electron 没有可调的 vibrancy blur radius；用户反馈 `menu` 过糊后，以隔离 Electron 窗口对比材质并将默认值改为轮廓更清楚的 `under-window`，保留透明 backing 与环境变量诊断矩阵；见 `83e041cd`。
- 2026-07-31 — HTML thumbnail IPC 的初始 URL gate 从字符串前缀升级为 canonical workspace-segment parser。只有完整 `ws.<base64url absolute path>` 可派生 request scope；非法/包含性/编码分隔符输入在创建隐藏窗口前拒绝。
- 2026-07-31 — Codex Markdown 本地目录不再按“绝对路径 = 文件”送入 PreviewPanel。用户点击后由 scoped inspect 判型：文件进侧栏、目录进系统文件管理器；工作区外仍先确认。HTML DiffSummary 卡新增 workspace-only 系统浏览器图标。
- 2026-08-01 — Claude 复审发现目录 `shell.openPath` 可启动 macOS bundle、generic IPC 可被 AI 路径利用且 inspect/raw path 不同源。删除通用 bridge：目录只定位、bundle 拒绝、HTML 专用打开；inspect 根由 session/home 推导并返回 canonical path，主进程二次校验。既有 files/open shell 拼接同步改为固定 argv。
- 2026-08-03 — 默认助理路径改为无输入的 fixed-path IPC；native notification 改为 Main 单 owner 的 durable claim/ack。`show` 只表示 OS accepted，点击通过有界 pending queue 等待 Renderer ready，提示音服从系统设置且仍以各平台 packaged smoke 为发布证据。
- 2026-08-07 — 独立安全审查确认 preview token 能表达 UNC/device root，跨站页面虽读不到响应仍可诱发 loopback 文件探测与 SMB/NTLM 出站。Preview wire 收紧为 local-only；UNC workspace 的 HTML 预览暂不支持，普通文件能力不受影响。
- 2026-08-07 — B-018 再次收到真实截图后推翻旧 Chromium 归因：当前 Claude CLI 会在每个 subprocess 启动时用用户名探测 `Claude Code*` Keychain item，且 v0.65+ Electron 还会初始化 `safeStorage`。采用 default-keychain 配置的只读前置探测；确认缺失时跳过 safeStorage，并用 packaged 窄 shim 让 Claude 走既有回退。拒绝 `password-store=basic`（macOS 无效且会误导安全边界）和 `CLAUDE_CODE_SIMPLE`（会关闭正常 hooks/插件/项目指令能力）。
- 2026-08-11 — Next utility OOM containment 改为 Main-owned safe mode + 本地 recovery page + bounded supervisor。自动重启受 production descendant registry 硬门禁；未知/残留 owner fail-closed，不以无限重启换表面可用。
- 2026-08-12 — B-030 用户日志证明 utility fatal 只落本地主日志、Sentry 无对应事件。Main 新增 generation one-shot 的 normalized fatal capture，且继续在 API 入口丢弃 diagnostic report 原文；Electron 从 40.2.1 更新到同主版本 40.10.6，吸收后续 Chromium/Electron 补丁，不以全局关闭 GPU 规避旧 Graphite crash。
- 2026-08-12 — 第二台 Mac 的 `codepilot Safe Storage` 授权框与本机 `SecItemCopyMatching` 阻塞揭示 stable/preview CI 也在静默产出 ad-hoc 包。macOS distributable 改为 Developer ID + exact Team ID fail-closed，并在最终产物后置复核；本地 recovery smoke 只能在 canonical 临时 userData 隔离跳过 Safe Storage。
- 2026-08-24 — DB migration/runtime 错误可以发生在 `serverPort` 赋值前；旧 retry 因 `!serverPort` 早退却向 Renderer 返回成功。Main 现在为初次启动失败提供独立重试路径并返回真实结果；原始根因只经共享 sanitizer 形成有界本地 marker，供日志与复制诊断使用，不改变低基数恢复分类。
- 2026-08-24 — `/api/health` 的 DB marker 改为立即失败；恢复路径与 utility 统一使用 `CLAUDE_GUI_DATA_DIR` resolver。fresh-start 后出现 DB 时 Main 不自动删除，而以 trusted、无路径参数的 IPC 提供“保留当前库 / 校验旧备份后继续空库”。
- 2026-08-28 — CLI maintenance child 改由 Main 持有，并与 app updater/quit 共用 lifecycle latch。utility recovery fork 前注入 provider lease bootstrap，healthy 后立即 reconcile，避免 heartbeat 间隔内新 Runtime 抢跑；详细执行合同集中在 `CliMaintenance.md`。
- 2026-08-28 — Round 2 并发审查确认 owner label 不能代表单次 acquire：latch 改为严格非重入，CLI 在任何 active-work/target/latest await 前同步占 starting slot 与 latch，避免双安装、activeOperation 覆盖和提前 release。
- 2026-08-28 — 用户明确右下角 notification event 不再作为产品通知面。所有 priority 统一创建 `electron-native` delivery，AppShell 移除 Renderer consumer；交互任务完成与审批请求由服务端 collector 写 durable event，点击回原会话。普通按钮反馈/错误提示仍可使用 toast，它们不是 Notification Manager delivery。
- 2026-08-29 — follow-up review 后关闭遗留 `renderer-toast` claim/ack HTTP 能力；Settings 测试通知保留独立 same-origin Renderer 边界，不再把历史 channel 当作调用方身份。
- 2026-08-27 — 生产样本证明 utility unexpected-exit Issue 是异质集合，不支持统一归为 OOM。Main 现把 `0x40010004` / `0xC000026B` 识别为 Windows teardown 并保持 zero telemetry；Claude 复审指出外部终止也可能复用相同 code，因此退出码不再单独关闭恢复，app 未 quit 时仍走既有 bounded recovery。其余退出保留 generation one-shot 并按稳定 exit class 分组。
- 2026-08-24 — 本轮 tag/prerelease 发布范围收窄为 macOS。Windows/Linux 原生构建 job 保留作手工 artifact 验证，但 `CODEPILOT_OFFICIAL_UPDATE_BUILD=0` 且 central Release 明确排除其资产。
- 2026-08-24 — 用户随后澄清 stable 仍需全平台分发：tag 恢复 Windows/Linux 手动安装包，保持 `CODEPILOT_OFFICIAL_UPDATE_BUILD=0`；preview 与原生 updater 仍只有 macOS。
- 2026-08-26 — 用户明确 Windows 自动更新不申请 Microsoft/Azure/PFX 签名。stable Windows 构建启用 official provenance并发布 unsigned NSIS metadata/blockmap；Linux 继续 provenance=0。Windows 必须以 UI 明示、GitHub immutable/ruleset/Action SHA 发布门禁和真实 RC 升级 smoke 补偿缺失的 publisher identity。
- 2026-08-26 — 内置 Browser 明确采用 T3 同类的 renderer-owned `<webview>`，但不复制其 `contextIsolation:false`、宽权限或 CDP。Main 只签发 workspace partition 并在 attach 时二次 harden；权限默认拒绝、下载默认阻断、URL 只放行 HTTPS/loopback。WebContentsView POC 保留为 inconclusive research，不冒充 GO。
- 2026-08-26 — Browser tab 身份上移到统一 Workspace Sidebar：一个顶层 tab 对应一个 guest，BrowserPanel 不再嵌套第二层 tab。loading 由真实 navigation request/start 到 stop/fail/block 的生命周期驱动，不展示伪造百分比。
