# 发版 / Release

> 发版时读这份。硬规则同时写在根目录 `AGENTS.md`。

## 发版纪律（硬规则）

- **禁止自动发版**：`git push` + `git tag` 必须等用户明确指示后才执行。commit 可以正常进行。
- 不要手动创建 GitHub Release（CI 会自动创建并上传构建产物）。
- 不要删除 / 重建已发布的 release tag（会把已发布 Release 打回 Draft）。

## 发版流程

更新 `RELEASE_NOTES.md` → 更新 `package.json` version → `npm install` 同步 lock → 提交推送 → `git tag v{版本号} && git push origin v{版本号}` → CI 自动构建发布并使用 `RELEASE_NOTES.md` 作为 Release 正文。

## 构建、签名与更新资产

当前 **stable tag** 发布混合分发图：macOS 产出 arm64、x64、universal DMG/ZIP，其中原生 updater 只使用 universal ZIP；Windows 产出 x64 unsigned NSIS updater；Linux 产出 x64/arm64 AppImage、deb、rpm 手动包。macOS 与 Windows 都嵌入 `CODEPILOT_OFFICIAL_UPDATE_BUILD=1`：分别发布 `latest-mac.yml` + ZIP blockmap、`latest.yml` + EXE blockmap；Linux provenance 固定为 `0`，不发布 `latest-linux*.yml`。preview prerelease 仍为 macOS-only。`scripts/after-pack.js` 重编译 better-sqlite3 为 Electron ABI；任一 Mac 签名/公证/安装包/Intel ABI 门禁，Windows unsigned trust/metadata 门禁，任一平台真实 Electron Main → utilityProcess → SQLite health、packaged server、source-map 卫生或 central asset audit 失败，都会阻断正式 Release。

macOS stable 与 preview 都必须把仓库 `MAC_CERT_P12_BASE64` / `MAC_CERT_PASSWORD` secrets 映射为 electron-builder 的 `CSC_LINK` / `CSC_KEY_PASSWORD`，并用 `APPLE_TEAM_ID` → `CODEPILOT_APPLE_TEAM_ID` 校验精确 `TeamIdentifier`。公证使用 `APPLE_NOTARIZATION_KEY_BASE64`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`；缺任一凭据、ad-hoc、Team ID 不匹配、app 公证失败、DMG 未 staple、Gatekeeper 或最终 `codesign --verify --deep --strict` 失败都必须阻断。`CSC_LINK` 只负责导入证书；若未另行配置显式 identity，证书打包步骤不得设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`。无证书的本地目录包只有显式 `CODEPILOT_ALLOW_ADHOC_SIGNING=1` 才允许生成，且只能作隔离开发 smoke，不能标记 `Release ready`。

stable tag 的 Windows updater 采用三态门禁：`WINDOWS_CERT_PFX_BASE64` / `WINDOWS_CERT_PASSWORD` / 仓库变量 `WINDOWS_PUBLISHER_SUBJECT` 全部存在时，installer 与 unpacked EXE 必须通过同一 publisher、SHA-256 与 RFC3161 timestamp 校验；当前全部缺失时，workflow 显式覆盖 `forceCodeSigning=false` 与 `verifyUpdateCodeSignature=false`、关闭证书自动发现，要求两个 CodePilot 入口均为 `NotSigned`、`app-update.yml` 不含 `publisherName`，但保持 official updater provenance=`1`；只配置一部分时 fail closed。未签名事实必须在 updater UI 与 Release Notes 明示，不能把 metadata SHA-512 写成 Authenticode publisher verification。preview 的显式 Windows artifact job 仍不进入 preview Release。

electron-builder 与 electron-updater 都使用 exact pin。macOS job 必须上传 builder 原生生成的 `latest-mac.yml` / `preview-mac.yml`、ZIP blockmap、DMG/ZIP 与 checksum；Windows stable job 必须上传 builder 原生 `latest.yml`、完整 NSIS installer、EXE blockmap 与 checksum；stable central job 以 `distribution` target 同时要求完整 Linux 手动包并拒绝任何 Linux updater metadata，preview 继续以 `macos` target 拒绝任何 Windows/Linux 资产。审计器要求 metadata 以裸 basename 精确引用当前版本，按文件名集合核对 checksum，并校验 URL、sha512、size 以及对应外置 blockmap 的存在与 checksum coverage；`blockMapSize` 只适用于 builder 的嵌入式 blockmap，不是 Mac ZIP/完整 NSIS 的外置 sidecar 字段。任何旧版本/额外 release payload 都失败。Mac metadata 恰好一条 universal ZIP entry，Windows metadata 只引用完整 NSIS。完整图与 `SHA256SUMS.txt` 先上传 draft，全部成功后才一次切换为公开 stable/prerelease；中断时保留不可见、可由同 tag workflow rerun 恢复的 draft。workflow 顶层保持 `contents: read`，Release/OIDC/attestation 写权限只授予最终发布 job，所有 `uses:` 固定 40 位 commit SHA。unsigned Windows feed 公开前必须由管理员设置当天或前一 UTC 日的 `CODEPILOT_IMMUTABLE_RELEASES_CONFIRMED_AT`，并用可见完整 `bypass_actors` 的管理员响应运行 `verify-github-update-rulesets.mjs --emit-confirmed-state`，把输出写入 `CODEPILOT_RULESETS_CONFIRMED_STATE`。GitHub API 会对没有 ruleset write 权限的 Actions token 隐藏 `bypass_actors`，发布 job 禁止把字段缺失解释为空；它必须实时校验 active、无 exclude/重名的 `main` deletion/non-fast-forward 与 `stable-release-tags` deletion/update shape，并把两条 ruleset 的 live `id` / `updated_at` 与管理员确认状态精确匹配，任一配置漂移都 fail closed。Windows UI 必须从 packaged `app-update.yml` 读取 publisher 状态：无 `publisherName` 才显示 unsigned，有有效值才记 Authenticode，缺失/畸形配置关闭 native updater。universal 合并前必须按 lockfile sha512 完整性准备两套 Darwin Sharp runtime，并在逐架构 `afterPack` 中把 Next standalone 的 SQLite/zlib 替换为目标 Electron ABI；合并后 Arch=4 hook 必须 no-op，保留真实 fat binary。`x64ArchFiles` 只允许逐路径保留 SDK/Sharp 的目录选型预编译文件与 already-universal Trash helper，禁止用宽泛规则掩盖其他 native ABI 不一致。macOS DMG 是手工 bootstrap 资产：容器必须先由同一 Developer ID Application identity 签名，再公证/staple，并通过 DMG 专用 Gatekeeper `open/context:primary-signature`；因 staple 会改写其字节，`dmg.writeUpdateInfo` 必须保持 `false`，DMG 不进入 metadata/blockmap。mac updater 只消费签名、公证后的 ZIP。Windows `nsis.differentialPackage=true` 且客户端 `disableDifferentialDownload=false`；旧 installer/blockmap/Range 不可用时自动回退完整 NSIS，不承诺固定节省比例。禁止手写 metadata、加入 `stagingPercentage`、发布后替换资产、复用版本或移动 tag。preview 使用 `preview-mac.yml` 与 GitHub prerelease；tag 必须是与 `package.json` 完全相同的 `X.Y.Z-preview.N` 有效 semver，不能使用 electron-updater 无法识别的 `preview-X.Y.Z` 前缀。stable 只接受 `vX.Y.Z`，任何 `vX.Y.Z-preview.N` 必须 fail closed；artifact-only preview 永远不能写 stable feed。

### macOS / Windows 自动更新发布确认

1. stable tag 的 Mac/Windows 更新源固定为该仓库公开 Release feed；official provenance=1 的客户端分别消费 `latest-mac.yml` 与 `latest.yml`，不得按平台拆到临时地址，也不得让本地/fork/手工构建启用更新器。Linux 保持 provenance=0。
2. 同一 Release 必须同时具备三份签名、公证、staple 的 DMG（手工 bootstrap）、三份签名/公证 ZIP、三份 ZIP blockmap、`latest-mac.yml`，以及 unsigned Windows NSIS、EXE blockmap、`latest.yml` 与 checksum。Mac metadata 恰好引用同版本 universal ZIP，Windows metadata 只引用同版本完整 NSIS。
3. `push tag` 只表示 CI 已触发，不表示 Shipped。发布者必须跟踪 workflow 终态，并在公开 Release 上复核：非 draft、非 prerelease、Latest=true、版本正确、Linux 手动包齐全、没有 `latest-linux*.yml`、两份 metadata 的 version/URL/sha512/size 与公开 installer 一致，且各自外置 blockmap 存在并进入 checksum。
4. 任一检查失败时保留不可变失败 tag；修复后递增 patch 重新发布。禁止删除/移动 tag、覆盖同版本资产或手工改 metadata。
5. Windows 已发布 `v0.67.7` 及更早版本没有 official updater provenance；首个 Windows updater 版本必须由用户手动 bootstrap，随后版本才允许记 RC-A→RC-B 自动/差分 smoke。
6. 任何签名、更新 channel、平台资产图或自动更新能力变更，都必须同步本文件、`README.md` 与当版 `RELEASE_NOTES.md`。

Linux AppImage/deb/rpm 当前提供 checksum/attestation 与手工安装，不宣称后台自动安装。建立受信 GPG repository 或独立签名 manifest、完成真实 upgrade smoke 前，应用不得静默执行包管理器或提权安装。

涉及 packaged Next utility 生命周期、Codex transport/model discovery 或 server recovery 的版本，除启动期 `/api/health` 外还必须在对应平台产物执行：一次运行期强制退出并验证 offline recovery page → bounded safe-mode restart → 原 stable port/route 恢复；三次自动重启分别消费 1s/2s/4s 预算后，第 4 次退出验证停止自动重试；有不可验证 descendant 时验证 fail-closed。Codex 相关改动另需至少 15 分钟 warmup soak。未完成这些真实产物 smoke 时只能报 `Tests pass`，不得报 `Release ready`。

> Windows 构建机器钉在 `windows-2022`（见 tech-debt #44：`windows-latest` 滚到 VS18 后 node-gyp 编译 native 模块失败）。

## 签名密钥轮换与丢失 runbook

### 计划内轮换

1. 在旧凭据仍有效时生成新凭据，只把值写入 GitHub Secrets/受控签名服务，不进 repo、artifact、cache 或日志。
2. Apple Developer ID 必须保持同一 Apple Team ID；先用新证书/API key 构建并公证 internal preview，完成 codesign、Gatekeeper、stapler、keychain 与 RC-A → RC-B 更新验证，再切 stable，最后撤下旧凭据。公证 API key 可独立轮换，但也必须先走 preview。
3. Windows 续期必须保持同一 legal publisher subject。用新证书签 preview，验证 Authenticode subject/timestamp、已安装旧版升级、SmartScreen 实际表现，再切 stable；旧证书保留到新版本覆盖率与回滚窗口结束。
4. 轮换记录只保存证书指纹、subject/Team ID、有效期、启用/撤下时间和 CI run；不得保存私钥或 secret 值。

### 发布者身份必须变化

- Windows publisher subject 变化不是普通换证。旧证书可用时，先发一个仍由旧证书签名、显式同时信任旧/新 publisher 的 bridge 版本，完成真实升级后才切新 signer。无法发布 bridge 时，旧客户端不得自动安装新身份，只能手工 bootstrap。
- Apple Team ID 变化会影响更新签名信任和既有 Keychain/Safe Storage 身份，按应用迁移项目处理；不得在普通 patch 中直接替换。

### 泄漏、丢失、撤销或过期

1. 立即冻结 preview/stable 发布与 updater feed 晋级，保留现有 tag/Release/metadata，不用同版本覆盖。
2. 在 CA/Apple 撤销受影响凭据，轮换 GitHub Secrets，审计 Actions logs/artifacts/cache 和最近签名记录，并登记安全事件。
3. 有旧 signer overlap 时按计划内轮换发布更高 patch；没有可用旧 signer 或 Windows publisher 已变化时，禁用自动晋级并提供签名可验证的手工 bootstrap。
4. 恢复前必须重新跑 preview 签名、公证、metadata/hash、clean-machine bootstrap 与 RC-A → RC-B 门禁；由用户重新授权 stable 发布。

## Release Notes 格式（必须严格遵循）

标题：`CodePilot v{版本号}`

正文结构：

```markdown
## CodePilot v{版本号}

> 一句话版本摘要，说明这个版本的核心主题或推荐升级理由。

### 新增功能
- 功能描述（面向用户的语言，不要写 commit hash）

### 修复问题
- 修复了 xxx 的问题

### 优化改进
- 优化了 xxx

## 下载地址

### macOS
- [Apple Silicon (M1/M2/M3/M4)](https://github.com/op7418/CodePilot/releases/download/v{版本号}/CodePilot-{版本号}-arm64.dmg)
- [Intel](https://github.com/op7418/CodePilot/releases/download/v{版本号}/CodePilot-{版本号}-x64.dmg)

### Windows
- [Windows x64 安装包](https://github.com/op7418/CodePilot/releases/download/v{版本号}/CodePilot.Setup.{版本号}.exe)

### Linux
- [x64 AppImage](https://github.com/op7418/CodePilot/releases/download/v{版本号}/CodePilot-{版本号}-x86_64.AppImage)
- [arm64 AppImage](https://github.com/op7418/CodePilot/releases/download/v{版本号}/CodePilot-{版本号}-arm64.AppImage)

### 完整性验证
- [SHA-256 Checksums](https://github.com/op7418/CodePilot/releases/download/v{版本号}/SHA256SUMS.txt)
- GitHub Release 页面可验证每个安装包的 build-provenance attestation；`latest*.yml` 与 blockmap 是自动更新器资产，不需要手工下载。

## 安装说明

**macOS**: 下载 DMG → 拖入 Applications → 正常启动。若 Gatekeeper 报告开发者无法验证或文件损坏，请停止安装并反馈，不要绕过安全检查。

已安装的 macOS 正式版会通过同一 GitHub Release 的 `latest-mac.yml` 检查更新，并使用签名、公证后的 universal ZIP 完成应用内下载与重启安装。手动安装首个支持 updater 的 Windows 正式版后，后续版本会通过 `latest.yml` 优先差分下载 unsigned NSIS，失败时回退完整安装包；应用内会明确提示它没有独立发布者签名。Linux 仍需手动下载新版安装包。

**Windows**：首个 updater 版本需手动下载安装；该包未签名，可能显示 SmartScreen。只从 `op7418/CodePilot` Release 获取并核对 SHA-256。**Linux**：stable 只提供手动下载安装。

## 系统要求

- macOS 13.0+
- Windows 10/11 x64，或常见 x64/arm64 Linux 发行版
- 需要配置 API 服务商（Anthropic / OpenRouter 等）
- 推荐安装 Claude Code CLI 以获得完整功能
```

## Release Notes 写作规则

- 更新内容必须用用户能理解的语言，不要出现 commit hash、函数名、文件路径
- 每个条目说清楚"用户能感知到什么变化"
- 下载链接必须是完整的 GitHub release download URL，用户点击即可下载
- 如果某个分类没有内容（如没有修复），跳过该分类不要留空标题
- `git log --oneline` 的输出只用于自己梳理，不要原样复制到 Release Notes
