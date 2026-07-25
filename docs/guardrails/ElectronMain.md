# ElectronMain Guardrail

> **Status: Active contract** — 已覆盖 Electron 构建清理、standalone 内容边界、extraResources 互斥、native ABI 与 packaged server 启动门禁。
> **为什么先读**：主进程无自动化测试覆盖（tech-debt #6）；外链拦截 / 窗口管理 / 菜单栏常驻 / better-sqlite3 ABI rebuild 全在主进程；改错会让构建产物启不来，且现有 Playwright 测试无法捕获。
> **已知关键文件**：`electron/*`（如果存在）、`scripts/build-electron.mjs`、`scripts/after-pack.js`、`scripts/after-sign.js`、`electron-builder.yml`。

## 词汇表

- `after-pack` / `after-sign` — electron-builder 的 hook，在打包 / 签名后跑。
- `better-sqlite3 ABI rebuild` — `scripts/after-pack.js` 把 native module 重编译为 Electron ABI。
- `standalone` — Next.js production server 的最小运行树；Electron 只允许打包受控 runtime roots。
- `extraResources FileSet` — electron-builder 的资源复制单元；多个 FileSet 可能并发执行，因此目标路径必须互斥。
- OAuth loopback callback — packaged renderer 通过本地 Next server 启动、仅监听 `127.0.0.1` 的短期 OAuth 回调服务；不是 Electron deep link。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|--------|--------|
| 1 | better-sqlite3 必须在 after-pack 阶段重编译为 Electron ABI，否则启动崩溃 | `scripts/after-pack.js` |
| 2 | 构建前只清理 `release/` + `.next/` + `dist-electron/`，且先验证当前目录确为 CodePilot 项目 | `scripts/clean-electron-build.mjs` |
| 3 | standalone 根目录只允许 `.next`、`node_modules`、`server.js`、`package.json`、`cache-handler.js`；本地 DB、上传、Git/agent/worktree 状态不得进入包 | `scripts/clean-electron-build.mjs`, `scripts/build-electron.mjs` |
| 4 | `extraResources` 中 standalone root、`node_modules`、`.next` 的目标必须互斥；禁止用一个 `**/*` FileSet 再叠加子目录 FileSet | `electron-builder.yml`, `electron-packaging-hygiene.test.ts` |
| 5 | macOS/Windows 产物必须校验版本与 packaged better-sqlite3 ABI 后才能上传 | `.github/workflows/build.yml` |
| 6 | macOS/Windows 产物必须使用 packaged Electron runtime 启动 `standalone/server.js`，且 `/api/health` 返回 200；只看到 Next.js `Ready` 不算启动成功 | `scripts/verify-packaged-server.mjs`, `.github/workflows/build.yml` |
| 7 | xAI browser OAuth callback 固定为 `127.0.0.1:56121/callback` 且只绑定 loopback；不得改成 `0.0.0.0`、任意空闲端口或未注册 deep link | `src/lib/xai-oauth-manager.ts` |
| 8 | packaged 环境无法打开浏览器或固定端口被占用时，必须明确提示 device-code 登录；不能静默失败或换 redirect URI | Settings UI + xAI OAuth routes |
| 9 | 主进程注入 `HTTP_PROXY/HTTPS_PROXY` 只提供配置事实；packaged Next server 的 xAI OAuth fetch 必须显式挂代理 dispatcher，不能假设 Node fetch 自动读取 env | `electron/main.ts` + `src/lib/env-proxy-fetch.ts` |

## 关键文件 + 责任

| 文件 | 守哪条不变量 |
|------|--------------|
| `scripts/build-electron.mjs` | esbuild + standalone 符号链接解析 + 清理 dist-electron |
| `scripts/after-pack.js` | better-sqlite3 ABI rebuild |
| `scripts/after-sign.js` | macOS 签名后处理 |
| `electron-builder.yml` | 打包配置（DMG / NSIS / arm64 + x64） |
| `src/lib/xai-oauth-manager.ts` | loopback server 生命周期、loopback/Origin gate、端口占用错误 |
| `src/lib/env-proxy-fetch.ts` | packaged server 上游 xAI 请求的 HTTP(S) system-proxy bridge；不接管 loopback |
| `src/components/settings/ProviderManager.tsx` | 显式用户点击打开授权页、browser/device fallback 与 cancel |

## 改动检查表

- [ ] 改 after-pack 前在本地完整跑一次打包，确认产物可启动
- [ ] 改 native module 依赖时确认 ABI rebuild 仍工作
- [ ] 多平台改动分别在 macOS / Windows 验证（CLAUDE.md 要求）
- [ ] 修改 `extraResources` 时检查所有 FileSet 的 destination 不重叠
- [ ] 修改 standalone 资源时确认 `.next/node_modules` 中的 Next.js 哈希 external alias 被显式打包
- [ ] 本地打包后运行 `scripts/verify-packaged-server.mjs`，确认 packaged server 健康检查通过
- [ ] 审计 packaged standalone 不含 `data/*.db`、uploads、`.codepilot`、`.claude`、`.git` 或嵌套 release
- [ ] 改 OAuth 回调/外链后在 packaged macOS 与 Windows 分别验证 browser 登录、device flow、取消和端口占用提示
- [ ] 外部授权页只由用户显式点击打开；页面仍受主进程外链策略约束，不在后台自动拉起
- [ ] system proxy smoke 同时确认浏览器授权页和 server token exchange；只看到网页成功不等于凭据已落库

## 常见坑

- tech-debt #6 — 主进程行为无自动化覆盖；现有 Playwright 测试只覆盖 Next.js web 层。改主进程后必须手动验证。
- 历史：v0.34 crash on upgrade 根因是 `dist-electron/` 没清理就打包，stale artifacts 进 app.asar。
- v0.58.2 tag build：standalone root `**/*` 与专用 `.next` / `node_modules` FileSet 重叠；Windows 并发复制时以 `EBUSY` 失败，同一内置 exe 也被签名两次。资源组必须按目标互斥，不要依赖某个平台的文件系统碰巧容忍。
- v0.58.3：为修复上述重叠，将 `.next` 改成独立 FileSet 后，electron-builder 自动过滤其根 `node_modules`，Next.js 哈希 external alias 未进入包；构建和 ABI 检查都通过，但 packaged server 无法响应健康检查。嵌套 alias 必须独立复制，发版门禁必须真实启动 server。
- OAuth loopback 只在 web/dev 环境通过，不代表 packaged 可用；macOS/Windows 的外链拦截、防火墙、固定端口和应用退出清理都可能不同，发布前必须分别 smoke。
- xAI proxy bridge 直接依赖 `undici` 6.x 的 dispatcher 接口；升级 Node/Electron 或迁移到 undici 7+ 时必须重跑真实 CONNECT proxy 合同测试并核对 handler 接口，不能只依赖 typecheck。

## 测试覆盖

| 契约 | 测试文件 |
|------|----------|
| 主进程 UI E2E | （tech-debt #6：待搭 `@playwright/test` + `_electron.launch()`） |
| 清理、standalone allowlist、extraResources 互斥 | `src/__tests__/unit/electron-packaging-hygiene.test.ts` |
| packaged version + native ABI + server health | `scripts/verify-packaged-server.mjs`, `.github/workflows/build.yml` |
| xAI loopback/CORS/端口占用（Node 合同） | `src/__tests__/unit/xai-oauth-manager.test.ts` |
| xAI packaged server proxy bridge | `src/__tests__/unit/env-proxy-fetch.test.ts` + HTTP(S) proxy 真实 packaged smoke |
| packaged xAI browser/device OAuth | 手工 macOS + Windows smoke（真实账号；未自动化） |

## 设计决策日志

- 2026-07-20 — standalone 安全事件后建立最小 root allowlist，并在打包边界 sanitize + fail-closed。
- 2026-07-20 — v0.58.2 Windows CI 暴露重叠 FileSet 的并发复制锁；改为 root runtime files / node_modules / .next 三组互斥，并补合同测试。
- 2026-07-20 — v0.58.3 packaged server 因 `.next/node_modules` 被过滤无法启动；哈希 alias 改为独立 FileSet，并把 packaged server health smoke 升为发布门禁。
- 2026-07-21 — xAI OAuth 采用固定 loopback browser PKCE + device-code 双路径，不引入 Electron deep link；Node 合同测试不能替代 packaged macOS/Windows 真实登录门禁。
- 2026-07-22 — v0.59.0 真实 packaged 日志暴露 browser/system proxy 与 server/global fetch 分流；主进程继续只负责注入代理 env，xAI server fetch 以局部 dispatcher 显式消费，避免全局代理 loopback。
