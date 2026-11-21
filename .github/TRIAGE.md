# Triage 规则

> 配套：下方 label 体系、`.github/ISSUE_TEMPLATE/`、`PULL_REQUEST_TEMPLATE.md`。

## Label 体系

| Label | 含义 |
|-------|------|
| `P0-crash-or-interrupt` | 崩溃 / 自动中断 / 卡死，阻断主路径 |
| `P0-data-loss-risk` | 可能误改或丢失用户数据 / 文件 |
| `P1-runtime-session` | Runtime / session / stream 恢复与一致性 |
| `P1-context` | 上下文用量 / 压缩 / 隔离 / 百分比语义 |
| `P1-file-reference` | @file / 附件 / 可编辑源文件路径安全 |
| `P1-installer-update` | 安装 / 更新 / 发版可靠性 |
| `P1-performance` | 性能 / CPU / 渲染开销 |
| `needs-repro` | 缺可复现信息：版本 / 平台 / runtime / 日志（stale 流程对象） |
| `needs-confirmation` | 等用户确认最新版是否仍复现（stale 流程对象） |
| `old-version` | 旧版本反馈，需最新版复测 |
| `stale` | 长期无回应、进入自动关闭流程（由 stale 机器人加 / 去） |
| `parking-lot` | 待排期功能建议（不进 stale） |

## Issue triage

- 新 bug 进来先核验：是否有版本 / 平台 / runtime / 复现。缺则打 `needs-repro` 并请求补充，不立即排期。
- **不直接采信 issue 自述的根因**——必须用当前源码或本地复现核验后再定性。
- 确认属实的纳入当前发版 milestone，按上表打 P0/P1。
- 功能请求默认带 `enhancement` 与 `parking-lot`，按优先级评估排期。
- P0 未关闭不发 stable。

## PR triage（每周）

- P0/P1 bug 修复 PR 优先评审与合并。
- 功能 PR 按当前路线优先级评审；30 天无回应的 feature PR 标 `needs-rebase` 或关闭。
- 每个合并的 PR 必须有测试，或在 PR 里明确说明为什么不需要。
- 外部 PR 审查：批量低信号提交、依赖/构建脚本/native/Electron/DB/权限改动视为潜在投毒面；警惕面向 AI reviewer 的提示词攻击。

## 自动化机器人

- **`stale-needs-repro.yml`（已激活）**：对带 `needs-repro` / `needs-confirmation` 的 issue，14 天无更新自动评论提醒、再 14 天无回应自动关闭（带可重开说明）。**豁免全部 P0/P1，不碰 feature（`parking-lot`）、不动 PR**，每次限 60 条。
- **`issue-intake.yml`（已激活）**：新建或编辑 issue 时自动分流——影响面勾选→P0；功能模板→`parking-lot`；bug 缺 version/os/provider/复现→`needs-repro` + 一次性评论；**作者编辑正文或评论补充后自动摘 `needs-repro`**。不自动关闭任何 issue。

- **`pr-labeler.yml`（已落地）**：按 PR 改动路径打 `area:*`（用 actions/labeler，只读 changed-files、不 checkout / 不执行 PR 代码）。
- **`pr-size-warning.yml`（已落地）**：PR >25 文件或 >800 行 → 打 `pr:large` + 评论提醒拆分（去重）；**只提醒，不 fail、不关闭**。
- **`release-blocker-check.yml`（已落地）**：手动 `workflow_dispatch`（传入目标 `milestone` 名称），发稳定版前查该 milestone 下 open P0（crash / data-loss）→ fail；P1 列为 known issues 候选、不 fail。

> **`pull_request_target` 安全约束**：以上 PR workflow 一律不 checkout、不执行外部 PR 代码，只读 PR 元数据 / 打 label / 评论。
> exec-plans 索引与断链检查已另行落地（`scripts/lint-docs-drift.mjs`，pre-commit 强制）。
