# Release Guardrail

> **Status: Active contract** — 已覆盖版本 source of truth、tag 不可变、CI 多平台版本/ABI/server-health 门禁与失败后的补丁版本策略。
> **为什么先读**：发版有严格顺序（RELEASE_NOTES → package.json version → npm install → 提交推送 → tag → CI 自动构建发布）；**不能删 tag**——一旦 tag 被删再重建，已发布的 Release 会变 Draft（`feedback_never_delete_release_tags.md`）。CI 会自动建 Release 并上传产物，不要手动建。
> **已知关键文件**：`RELEASE_NOTES.md`、`package.json`（version 字段）、`package-lock.json`、`.github/workflows/*`（CI 发版流程）。

## 词汇表

- `RELEASE_NOTES.md` — 当前版本 Release 正文 source of truth；CI 读它作为 GitHub Release body。
- `tag` — `v{版本号}`；推送后触发 CI 构建发布。
- `Shipped` — tag CI 成功且 GitHub Release 与全部平台资产真实存在；只推送 tag 不算发布完成。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|--------|--------|
| 1 | 不能删 release tag——删了再建会让已发布 Release 变 Draft，丢失下载链接 | 人 + CI |
| 2 | 必须等用户明确指示才 `git push` + `git tag`；commit 可以正常进行 | 人（执行 Agent） |
| 3 | RELEASE_NOTES.md 格式必须严格遵循 CLAUDE.md "Release Notes 格式" 一节 | 人 |
| 4 | 更新内容必须用用户能理解的语言，不要出现 commit hash / 函数名 / 文件路径 | 人 |
| 5 | 下载链接必须是完整 GitHub release download URL，用户点击即可下载 | 人 |
| 6 | tag CI 任一平台失败时不得删除/重建该 tag；修复后递增 patch 版本重新发布 | 人 + CI |
| 7 | 只有 macOS 双架构、Windows、版本/ABI/packaged-server-health/checksum 门禁均通过且 Release job 成功，才能报告 Shipped | `.github/workflows/build.yml` + 执行 Agent |

## 关键文件 + 责任

| 文件 | 守哪条不变量 |
|------|--------------|
| `RELEASE_NOTES.md` | Release 正文 source of truth |
| `package.json` | version 字段 |
| `package-lock.json` | 同步版本号（`npm install` 后会自动更新） |
| `.github/workflows/*` | CI 自动构建 + 上传产物 |
| `scripts/after-pack.js` / `scripts/after-sign.js` | macOS DMG 签名 + better-sqlite3 ABI |

## 改动检查表

- [ ] 更新 RELEASE_NOTES.md 之前先看 `git log --oneline` 但不要原样复制
- [ ] 每个 Release Notes 条目必须说清楚"用户能感知到什么变化"
- [ ] 跳过没内容的分类（如没有"修复问题"则删掉那个标题）
- [ ] `npm install` 同步 lock 后再提交
- [ ] 用户明确指示后才 `git push origin main && git tag v{版本号} && git push origin v{版本号}`
- [ ] 不要手动建 GitHub Release——CI 会自动建并上传产物
- [ ] tag 后持续监控 CI；核实 Release URL 和 macOS arm64/x64、Windows、SHA256SUMS 资产均存在
- [ ] packaged server 必须在 Electron runtime 下启动并通过 `/api/health`，不能只凭打包成功、Next.js `Ready` 或 native ABI 判定可发布
- [ ] CI 失败时保留失败 tag，修复后发新 patch 版本

## 常见坑

- 删 tag 重建：已发布的 Release 变 Draft（`feedback_never_delete_release_tags.md`）。如果发版后发现 RELEASE_NOTES 错了，**新建一个 patch 版本**而不是重发同版本。
- Release Notes 写成给开发看的（commit hash / 函数名）：用户读不懂；必须用面向用户的语言。
- 自动发版：禁止；commit 可以做，但 push + tag 必须等用户明确指示。
- 把“tag 已推送”报告成“已发布”：Release job 可能因任一平台构建失败被跳过；必须查看最终 Release 与资产。
- 只验 ABI、不启动 server：v0.58.3 的安装包通过版本与 better-sqlite3 ABI 检查，但缺少 Next.js 哈希 external alias，用户界面永久停在 `Starting CodePilot...`。

## 测试覆盖

| 契约 | 测试文件 |
|------|----------|
| 构建产物 server 启动 | `scripts/verify-packaged-server.mjs` + `.github/workflows/build.yml` |
| tag/version、P0 regression、双平台 version/ABI/server-health/checksum | `.github/workflows/build.yml` |
| release notes / package version drift | `scripts/lint-docs-drift.mjs` + CI verify-source |

## 设计决策日志

- 2026-07-20 — v0.58.2 tag 的 macOS 成功但 Windows `EBUSY`，Release job 因 fail-closed 被跳过；保留 tag，修复后改发 v0.58.3。
