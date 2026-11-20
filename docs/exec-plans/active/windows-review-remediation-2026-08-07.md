# Windows 适配独立审查修复闭环

> 创建时间：2026-08-07
> 最后更新：2026-08-07
> 总状态：🟡 Code complete + Tests pass + Review passed；Windows packaged smoke 待执行
> 触发信号：Windows 跨机改动进入 `main` 后，Claude 独立审查确认 4 个 P1：Provider 密钥迁移可阻断启动、无 ripgrep 的正则回退可阻塞服务、POSIX `//`/macOS `/mnt` 被误判为 Windows/WSL 路径、非 Windows Runtime 页面展示 PowerShell 安装指引。
> 前序计划：Windows Runtime 诊断、恢复与凭据加固；Windows Runtime / 路径兼容性

## 状态

| Phase | 内容 | 状态 | 备注 |
|-------|------|------|------|
| Phase 0 | Signal / Triage / 修复边界 | ✅ 已完成 | 4 个 P1 均由源码调用链确认；按 Tier 2 处理 |
| Phase 1 | P1 最小修复与回归测试 | ✅ 已完成 | 四路代码落地；targeted 27 pass、1 Windows-only skip |
| Phase 2 | P2 分流与防回归沉淀 | ✅ 已完成 | 直接收口 9 类；剩余风险记 #78–#84 |
| Phase 3 | Targeted / full / build / 本机 UI 验证 | ✅ 已完成 | typecheck、targeted、5124-test full suite、production build、macOS 页面检查均通过 |
| Phase 4 | Claude 独立复审 | ✅ Review passed | 4 个 P1 独立实测有效；P2 抽查通过；无新增 blocker |
| Phase 5 | Windows packaged smoke | 🚧 artifact ready / 真机待执行 | `v0.66.0` CI 已通过 Windows package/version/native ABI/server startup；不以自动化替代无 `rg`、真实 sandbox、packaged credential 跨机验收 |

## 用户问题、争议与取舍

- 本轮不是继续扩充 Windows 能力，而是修复已合入实现对启动可用性、服务可停止性、macOS 路径和平台文案造成的反向回归。
- Provider 明文与密文同时存在时，明文代表旧版/回滚后的当前用户输入；不得让旧密文复活，也不得让单行失败穿透 `getDb()` 阻断全应用。
- 无 `rg` 回退面对模型提供的任意正则，不能在 Next 主线程直接执行不可中断的 JS `RegExp`；超时/取消必须产生显式错误，不能伪装成“未找到”。
- 路径 dialect 必须由“输入形状 + 当前平台”共同决定：macOS/Linux 的 `//...` 是 POSIX，macOS 的 `/mnt/c/...` 也不能无条件解释为 WSL；Windows 的 UNC/WSL 转换仍保留。
- PowerShell 安装命令只属于 Windows Electron 恢复入口；其他平台显示平台中立的官方安装/`CODEX_BIN` 指引。
- P2 不用聊天确认关闭：能在本轮最小闭环内安全修复的补代码和测试，其余逐项写入 tech-debt tracker，保留触发条件与验收方式。

## 执行清单

### Phase 1 — P1 最小修复

- [x] Provider migration 始终以非空明文为真源重新加密；单行失败保留可恢复数据并继续启动；补回滚/换机密文不匹配测试
- [x] Node Grep 回退把不可信正则移出主线程，增加总超时与 abort；补灾难性正则不阻塞 event loop 的测试
- [x] Path Identity 增加平台感知 dialect；补 macOS/Linux `//` 与 macOS `/mnt/c` 正反例
- [x] Runtime `not_installed` / `desktop_only` 恢复文案按 Windows Electron 门控；补非 Windows 不出现 PowerShell 命令的测试

### Phase 2 — P2 分流与 Guardrail

- [x] 核对密钥 key-file/dev、Windows shell/HTML preview、runtime probe/sandbox、搜索 ignore/截断、测试门禁、CRLF/containment/asset identity、文档/hook 漂移
- [x] 紧邻 P1 且不扩大产品语义的项目直接修复
- [x] 其余未关闭项目登记 tech-debt tracker，写明用户影响、重启条件和修法方向
- [x] 更新受影响 guardrail/交接文档，纠正前序计划或交接中的失真承诺

### Phase 3 — Verify

- [x] Targeted tests：provider secret、Native search、path identity、Codex recovery UI
- [x] `npm run test`
- [x] `npm run build`
- [x] Runtime 页面非 Windows UI smoke

### Phase 4 — Independent review

- [x] Claude 按本计划、guardrail 与 targeted tests 复审 P1/P2 修复

### Phase 5 — Windows packaged smoke

- [ ] Windows packaged：无 `rg` fallback timeout/abort/hidden-file、PowerShell absolute spawn、Codex recovery copy
- [ ] Windows packaged：回滚/换机后的 Provider secret 启动与两轮 chat；真实结果回写 Smoke Ledger

## 决策日志

- 2026-08-07：接受 Claude 独立审查的 4 个 P1 为 confirmed findings。前序完成态计划中“失败保留旧值”“回退有时间限制”等声明与真实代码不完全一致，本计划负责用行为测试和文档回写修正，不靠聊天关闭。
- 2026-08-07：用户已明确授权 Codex 在当前任务实施修复；因此覆盖协作 Skill 的默认“Codex 只审查”边界，但不扩展到 push、release、真实凭据或无关重构。
- 2026-08-07：4 个 P1 已完成 targeted 闭环：Provider secret 4/4、Path/Bridge 11/11、Codex recovery 5/5、Native search 7 pass + 1 Windows-only skip。灾难性正则在约 153ms 超时、主线程 heartbeat 正常，abort 约 22ms 收口；全量/build 尚未执行，因此当前仅为 Code complete + targeted tests pass。
- 2026-08-07：P2 直接收口：HTML preview 拒绝 UNC/device token，PowerShell 使用 SystemRoot 绝对路径，Runtime 去除虚构日志/硬编码 binary passed/死 ready 并收窄 sandbox 误报，搜索隐藏文件与扫描上限 fail closed，runner 零匹配与 pre-commit 漂移修复，Edit 保留 CRLF，containment 同时 canonicalize base，HTML bundle Windows junction 测试不再静默跳过，交接提交状态纠正。需产品级迁移设计的 Provider key owner、`.gitignore`、Codex auth mirror、Asset stable identity 分别登记 #78–#81。
- 2026-08-07：本机验证完成：expanded targeted 100 tests（99 pass、1 Windows-only skip）；`npm run typecheck` 通过；`npm run test` 5124 tests（5123 pass、0 fail、1 skip）；`npm run build` 通过并生成 136 个页面，保留仓库既有的 `next.config.ts` NFT 动态追踪 warning；changed-file ESLint 0 error（12 个既有 warning）；docs-drift、hook lint、`git diff --check` 均通过。macOS 实际 Runtime 页面正常且未显示 Codex PowerShell 指引；因本机 Codex 为 installed 状态，`not_installed/desktop_only` 的平台分支由 source contract 回归测试证明，Windows 真实视觉验收仍留 Phase 5。
- 2026-08-07：Claude 独立复审结论为 **Review passed**，4 个 P1 均用原始复现或独立矩阵再次确认：混合 secret 行与 trigger 故障注入、失控正则 Worker 超时/正常阳性对照、darwin/WSL/UNC 路径矩阵、两类 Codex unavailable 文案门控全部有效；P2 抽查与 guardrail/交接闭环通过，无新增 blocker。非阻塞补充已 durable 记录：主线程 Glob 风险并入 #79；刷新失败旧 probe、Doctor 重复 Claude version spawn、Codex 同步 binary probe 分别登记 #82–#84。状态提升为 Code complete + Tests pass + Review passed，但 Windows packaged smoke 仍是独立门禁。
- 2026-08-07：用户明确授权以 `v0.66.0` push/tag 发版；发版候选重新通过 typecheck、Harness boundary、5148 单测（5147 pass / 0 fail / 1 skip）和 production build。tag CI 将产出首个可用于 Phase 5 的 Windows packaged artifact，但产出本身不替代真机 smoke。
- 2026-08-07：`v0.66.0` Build & Package run `31155340623` 的 Windows job 完整通过：bundle、source map upload、NSIS package、packaged version、better-sqlite3 native ABI、server startup、checksums 与 artifact upload 均 success；公开 Release 已包含 `CodePilot.Setup.0.66.0.exe`。Phase 5 仅剩 Windows 真机功能/凭据 smoke，不再缺安装包。

## Smoke Ledger（真实凭据 / UI / E2E 验证记录）

| Date | Runtime | Provider | Model | 凭据形态 | 场景 | Result | Evidence |
|------|---------|----------|-------|---------|------|--------|----------|
| _待执行_ | codepilot_runtime | configured provider | configured model | `v0.66.0` packaged + safeStorage-migrated key | 回滚/换机后启动与两轮 chat | installer ready / 待 Windows 真机 | [CodePilot.Setup.0.66.0.exe](https://github.com/op7418/CodePilot/releases/download/v0.66.0/CodePilot.Setup.0.66.0.exe)；不使用真实 key 的自动化不能替代 packaged 凭据 smoke |
| 2026-08-07 | codepilot_runtime | — | — | Node fallback fixture | 灾难性正则、abort、隐藏文件 | 自动化通过 | 约 150ms worker timeout；主线程 heartbeat 正常；显式 abort 收口；`.env` 默认不遍历 |
| 2026-08-07 | codex_runtime | Desktop bundled | — | macOS production build | Runtime 页面平台文案 | 本机页面通过 / 未安装分支未触达 | 页面正常且当前状态未显示 PowerShell；`not_installed/desktop_only` 由回归合同覆盖，仍需 Windows 真机视觉复查 |
