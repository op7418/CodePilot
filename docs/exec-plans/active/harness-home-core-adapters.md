# Harness Home Program A — Core、Repository 与 Adapter Kits

> 创建时间：2026-07-30
> 最后更新：2026-07-31
> 状态：🟡 A1–A4 工程实现与 Claude review hardening 完成；A4 真实凭据 Tier 2 smoke 待最终验收；用户已授权 Codex 直接实施，明确不启动 loop
> 父计划：[harness-home-user-owned-core.md](harness-home-user-owned-core.md)
> 基线：正式 v0.62 发布线；实施时必须从当时最新 `main` 新建隔离 worktree

## 目标

建立用户所有、与 Agent 框架和模型解耦的 Harness 核心层，并把“导入外部 Harness 资产”与“接入完整执行 Runtime”拆成两个成本等级不同的 adapter kit。

本计划只负责：

- Harness Home shared contracts；
- file-backed Canonical Repository；
- migration / dual-read；
- `HarnessAdapter` L0/L1；
- `RuntimeAdapter` L2/L3；
- CodePilot Full Reference Implementation；
- write model、SecretStore 和 conformance。

Asset DB/Gallery 演进见 [harness-home-asset-library.md](harness-home-asset-library.md)；当前 Assistant service binding、统一 Capability Package/Broker 与 `creative` media/model reference package 见 [harness-home-context-capability-routing.md](harness-home-context-capability-routing.md)。旧 Design Method 独立产品化计划已移入 superseded，不得从中领取剩余任务。

## 状态

| Phase | 内容 | 状态 | 入口门禁 |
|-------|------|------|----------|
| A0 | Shared Phase 0 inventory 与 enforcement anchors | ✅ 完成 | 父计划全部 Phase 0 checkbox |
| A1 | Domain contracts、scope、provenance、reference status | ✅ 完成 | A0 全绿 |
| A2 | File repository、write model、SecretStore、migration | ✅ 完成 | A1 contract frozen |
| A3 | HarnessAdapter L0/L1 + per-adapter conformance | ✅ 完成 | A2 dry-run/round-trip 通过 |
| A4 | RuntimeAdapter L2/L3 + CodePilot Full Reference | 🟡 工程完成，真实凭据 smoke 待验收 | A3 边界与 touchpoint budget 通过 |

## 执行清单

- [x] A0 inventory、enforcement anchors、write model 与 SecretStore 决策
- [x] A1 framework-neutral contracts、scope、provenance、reference status
- [x] A2 file repository、lease、journal、crash recovery、external-edit consistency
- [x] A3 三个 L0/L1 source adapter 与共享 conformance
- [x] A4 三 Runtime facade、Full Reference assertion、canonical Skill/MCP write boundary
- [x] Claude review hardening：递归中立门禁、输入校验、Secret scan、dead-writer 证明、staged journal containment、流式 hash 与 bounded consistency cache
- [ ] A4 三 Runtime 真实凭据 / permission / resume / interrupt / packaged registration smoke

## 用户会看到什么

首轮不增加 Harness Home 页面。逐阶段可见结果：

- diagnostics 能说明 Harness root、source、冲突和 Secret unresolved 状态；
- 导入前有 dry-run，导入不删除外部源；
- 同一 canonical Memory/Skill/MCP 可投影到不同 Runtime；
- 不支持能力有明确原因；
- 接第四个框架可以先交付 L0/L1，不必同时完成聊天 Runtime。

## 明确不做

- 不在主目录直接实施。
- 不自动覆盖 `.claude` / `.codex` 或其他外部框架目录。
- 不读取对方 auth 文件绕过授权协议。
- 不将 API key、OAuth token 或 authorization header 写入 Harness root。
- 不承诺任意框架都成为 Full Runtime。
- 不用 prompt 声称未真实 mount 的工具可执行。
- 不实现 Runtime 动态加载任意第三方 JS；首版可使用编译期 registry。

## A0 — 开工门禁

A1 开工前，父计划必须完成：

1. Memory / Skill / MCP / Runtime / Artifact / Secret source-of-truth inventory；
2. 第四个框架 L0/L1 与 L3 touchpoint 基线；
3. D1–D7 和 adapter 边界的 enforcing file+symbol；
4. file repository write model 决策；
5. SecretStore 决策；
6. producer-backed Asset kind inventory。

未完成项不能以“实现过程中再看”绕过。

## A1 — Shared contracts

目标目录建议：

```text
src/lib/harness-home/
├── contracts.ts
├── scope.ts
├── provenance.ts
├── manifest.ts
├── projection.ts
├── validation.ts
└── registry.ts
```

必须定义：

- `HarnessHomeRef` 与 schema version；
- definition / state / asset indexes；
- global / assistant / project / runtime-overlay scope；
- provenance；
- `SecretRef`；
- `AssetRef`；
- `RuntimeProjection`；
- canonical capability maturity 与 `referenceStatus`；
- unknown Runtime / unknown overlay 的 round-trip 行为。

稳定能力约束：

```text
stable canonical capabilities ⊆ CodePilot executable capabilities
```

`draft + pending` 可以存在于 catalog 和开发 diagnostics，但不能进入稳定 Settings coverage、模型上下文或用户承诺。

### A1 完成标准

- [x] Contract 中没有外部框架私有路径。
- [x] Contract 中没有固定三 Runtime 的 record key。
- [x] 未注册 Runtime overlay 可无损 round-trip。
- [x] Secret 明文进入 manifest/export model 时 fail-closed。
- [x] D1–D7 各有自动化或明确人工门禁。
- [x] 现有 Runtime 与 UI 行为零变化。

实现入口：`src/lib/harness-home/index.ts`。验证：

```text
npm run typecheck
npx eslint src/lib/harness-home src/__tests__/unit/harness-home-contract.test.ts
CODEX_DISABLED=1 npx tsx --test --import ./src/__tests__/db-isolation.setup.ts src/__tests__/unit/harness-home-contract.test.ts
=> 10/10 pass
```

## A2 — Canonical Repository 与写模型

### Repository 边界

`HarnessRepository` 默认实现为用户可选择根目录的 file repository。SQLite 只保存：

- repository registry；
- content hash / search index；
- session / job / asset 关联；
- migration/write journal；
- cache generation；
- 不得成为 identity / memory / skill / method 的唯一副本。

### 日常写模型

必须实现并测试以下 contract：

1. **单写者**
   - 一个 Harness root 同时只允许一个 writer lease；
   - lock 至少记录 instance id、process identity、startedAt 和 schema version；
   - 其他实例进入只读或显式 takeover 流程，不静默抢锁。
2. **事务写**
   - 多文件写入先进入同 root 的 staging transaction；
   - journal 记录 expected old hash、new hash、files 和 terminal state；
   - durable flush 后以 atomic rename/replace 提交；
   - 启动时识别 prepared / committed / orphaned transaction。
3. **外部编辑**
   - `fs.watch` 只触发 debounce，不作为事实源；
   - 打开 root、窗口重新聚焦、watch event 和写前都按 manifest generation/content hash 对账；
   - 外部改动与本地未提交写冲突时进入 conflict，不 last-write-wins。
4. **多实例 / worktree**
   - 主目录与开发 worktree 不得同时持有同一真实 Harness root 的写 lease；
   - 测试使用隔离临时 root；
   - packaged app 与 dev app 争用时默认 fail-closed，并给出持有者 breadcrumb。
5. **索引失效**
   - SQLite index 带 source generation/hash；
   - hash 不一致时先标 stale，再重建；不能展示旧索引为最新事实。

### SecretStore

Phase A2 不预设“DB 一定正确”或“OS keychain 一定正确”。必须基于 A0 inventory 选择并记录：

- `SecretStore.get/set/delete/resolve` abstraction；
- `secretRef` namespace、scope 和 version；
- API key / OAuth bundle / env-only / external-owned 四类解析路径；
- 换机导入的 unresolved 状态和重新授权；
- logout/revoke/delete 的清理语义；
- diagnostics/export/log 的统一脱敏；
- OS keychain/safeStorage 不可用时的 fail-closed 行为。

Harness export 只能包含 `secretRef` 与重新授权提示。

### Migration

- dry-run first；
- copy/reference，不删源；
- provenance/source breadcrumb；
- content hash 去重；
- 同名不同内容进入 conflict；
- journal 可重跑、可恢复；
- 过渡期 canonical-first dual-read；
- 达到迁移门禁前旧 loader 保持可用。

### A2 完成标准

- [x] fixture 能生成完整 manifest。
- [x] 重复迁移 idempotent。
- [x] 半写/崩溃可恢复，无 silently mixed generation。
- [x] 外部编辑可被 hash/rescan 发现。
- [x] 两实例不能同时写同一 root。
- [x] Manifest 与任意 repository write 的 Secret 明文扫描 fail-closed。
- [x] 干净临时目录导入后恢复 identity / memory / skill metadata / MCP descriptor / method refs。

实现入口：

- `src/lib/harness-home/repository/file-repository.ts`
- `src/lib/harness-home/repository/writer-lease.ts`
- `src/lib/harness-home/repository/transaction.ts`
- `src/lib/harness-home/migration.ts`
- `src/lib/harness-home/secret-store.ts`
- `src/lib/harness-home/codepilot-secret-store.ts`

验证：

```text
npm run typecheck
npx eslint src/lib/harness-home src/__tests__/unit/harness-home-*.test.ts
CODEX_DISABLED=1 npx tsx --test --import ./src/__tests__/db-isolation.setup.ts \
  src/__tests__/unit/harness-home-contract.test.ts \
  src/__tests__/unit/harness-home-repository.test.ts
=> 22/22 pass
```

A2 没有新增 SQLite schema。Canonical 文件和 transaction journal 是事实源；DB 索引/Asset lineage 在 Program B 以 cache-only migration 增量接入。

## A3 — HarnessAdapter L0/L1

```ts
interface HarnessAdapter {
  descriptor: HarnessAdapterDescriptor;
  discover(input: DiscoverInput): Promise<DiscoveredHarnessAssets>;
  importPlan(input: ImportInput): Promise<ImportPlan>;
  exportPlan?(input: ExportInput): Promise<ExportPlan>;
  project(input: ProjectionInput): Promise<HarnessProjectionOverlay>;
}
```

目标目录：

```text
src/lib/harness-home/adapters/<framework-id>/
├── descriptor.ts
├── discover.ts
├── import.ts
├── export.ts
└── fixtures/
```

### L0/L1 Conformance Suite

每个 adapter 必须重复运行，而不是只验证首批 source adapter：

1. descriptor completeness；
2. discovery 只读且 path boundary fail-closed；
3. provenance/source breadcrumb 完整；
4. Secret 明文扫描与 external-owned credential 隔离；
5. dry-run 与 apply 结果一致；
6. import idempotency；
7. same-name/different-content conflict；
8. canonical → external → canonical round-trip；
9. unknown field/overlay 保留；
10. partial failure 不修改源、不产生假 success；
11. unsupported mapping 有原因；
12. export 必须显式触发且不覆盖未确认外部改动。

### Touchpoint acceptance

新增 L0/L1 framework 默认只能修改：

- adapter 自身目录；
- descriptor registry；
- fixture / conformance tests。

以下文件不得因为新增 L0/L1 framework 被修改：

- `src/lib/harness/context-compiler.ts:compileContext`；
- `src/lib/harness/capability-matrix.ts:*`；
- `src/components/settings/RuntimeCapabilityList.tsx:RuntimeCapabilityList`；
- `src/lib/harness/artifact-contract.ts:ARTIFACT_CONTRACTS`；
- `src/components/ai-elements/artifact.tsx:Artifact*`；
- 其他已有 adapter。

Changed-files guard 必须由调用者提供明确 base commit 和 allowlist。任何例外都进入计划决策日志，不能静默放宽。

### A3 实施结果

首批 source adapters：

- `assistant-workspace`：identity / rules / long-term + daily Memory；
- `claude-code`：rules / commands / skills / MCP descriptors；
- `codex`：AGENTS / prompts / skills；`config.toml` 只做 L0 感知，因混合 Runtime/MCP/credential 字段而明确标 unsupported，不复制内容。

共享边界：

- `src/lib/harness-home/adapters/types.ts`
- `src/lib/harness-home/adapters/base.ts`
- `src/lib/harness-home/adapters/filesystem.ts`
- `src/lib/harness-home/adapters/registry.ts`
- `scripts/check-harness-adapter-boundary.mjs`

验证：

```text
npm run typecheck
npx eslint src/lib/harness-home/adapters \
  src/__tests__/unit/harness-home-adapter-conformance.test.ts \
  scripts/check-harness-adapter-boundary.mjs
CODEX_DISABLED=1 npx tsx --test --import ./src/__tests__/db-isolation.setup.ts \
  src/__tests__/unit/harness-home-adapter-conformance.test.ts
=> 19/19 pass
```

Conformance 覆盖 descriptor、只读发现、path/symlink boundary、provenance、Secret 剥离、dry-run/apply、idempotency、冲突、canonical↔external round-trip、显式 export、no-overwrite 和 partial rollback。新增普通 L0/L1 adapter 的 changed-files guard 要求调用方显式提供 `--base`，无 `HEAD~1` 猜测。

## A4 — RuntimeAdapter 与 Full Reference

```ts
interface RuntimeDescriptor {
  id: string;
  displayName: string;
  integrationLevel: 'bridge' | 'full';
  capabilities: RuntimeCapabilityDeclaration[];
  harnessProjectionModes: ProjectionMode[];
  session: SessionDriver;
  events: EventMapper;
  permissions: PermissionMapper;
  artifacts: ArtifactSupportDeclaration[];
}
```

实施前先 POC：

- `RuntimeId` 从 closed union 迁到 registered/validated opaque id；
- DB wire compatibility；
- i18n / Settings descriptor 派生；
- capability matrix descriptor 派生；
- unknown runtime fail-closed；
- packaged Electron 显式注册。

### L2/L3 Conformance Suite

1. descriptor completeness；
2. context projection；
3. executable = truly mounted；
4. referenceStatus stable/pending 诚实；
5. unsupported reason；
6. tool start/result pairing；
7. permission mapping；
8. session resume；
9. interrupt / terminal state；
10. artifact round-trip；
11. unknown event preservation；
12. Asset reference/materialization；
13. external Harness perception；
14. Secret isolation。

### CodePilot Full Reference

- CodePilot 从 canonical repository 读取 identity/rules、memory、skills、MCP descriptors、methods 和 Asset refs。
- 新建 Skill/MCP 默认写 canonical repository；外部 export 是用户明确动作。
- Stable capability 必须真实 mount 并通过 conformance。
- Draft pending capability 不进入稳定 coverage。
- Runtime 切换不改写 canonical 数据。

### A4 实施结果

- Runtime wire ID、双语名称、Settings metadata、capability exposure key 和
  packaged driver 改由 `src/lib/runtime/runtime-catalog.ts` 单一显式注册；
  旧 DB/HTTP 三个 wire 值保持兼容，unknown ID fail-closed。
- packaged startup 逐项确认 descriptor 的实际 driver 已注册；缺失时启动
  失败，不允许 UI 选中 A、实际回退 B。
- `runtime/descriptor.ts` 从现有 capability contract/matrix 派生三 Runtime
  声明，并在模块加载时执行
  `stable canonical ⊆ CodePilot executable`。
- `runtime/repository-projection.ts` 对 canonical manifest generation/content
  hash/provenance/Secret/大小门禁后，将 identity、rules、Memory、Methods、
  matching overlay 和 Asset refs 投影到 Claude Code、CodePilot、Codex 三条
  现有真实 adapter 入口。
- Skill/MCP 目前只归档为 `perception_only` descriptor；未建立真实 mounter
  前不注入定义正文、不增加 tool name、不声称可调用。
- `/api/harness-home/definitions` 的创建/更新默认写 canonical repository；
  同内容幂等，不同内容更新必须带 expected content hash。写入不触碰
  `.claude`/`.codex`，外部 export 仍是独立显式动作。
- `/api/harness-home` 提供 metadata-only diagnostics 与显式配置/取消配置；
  不新增 Harness Home 页面，不返回 Memory/identity 内容或 Secret value，
  取消配置不会删除用户 repository。

定向验证：

```text
npm run typecheck
npx eslint <A4 touched files>
CODEX_DISABLED=1 npx tsx --test --import ./src/__tests__/db-isolation.setup.ts \
  src/__tests__/unit/harness-home-runtime-conformance.test.ts \
  src/__tests__/unit/harness-runtime-adapter.test.ts \
  src/__tests__/unit/harness-capability-matrix.test.ts \
  src/__tests__/unit/runtime-id-hardcoding.test.ts
=> 74/74 pass
```

真实凭据的 resume / interrupt / permission / tool event smoke 不伪造结果，
保留为最终 Tier 2 验收；既有对应 Runtime contract 测试仍由全量门禁覆盖。

## 验证分层

| 层 | 内容 |
|----|------|
| Tier 0 | schema/scope/provenance/SecretRef/referenceStatus/descriptor 纯测试 |
| Tier 1 | repository、write journal、migration、dual-read、L0/L1 conformance、touchpoint guard |
| Tier 2 | 三 Runtime 真实凭据、permission、resume、interrupt、packaged registration |
| Security gate | export scan、path traversal、lock takeover、SecretStore unavailable |

## Smoke Ledger

| Date | Phase | Runtime / Adapter | 凭据形态 | 场景 | Result | Evidence |
|------|-------|-------------------|----------|------|--------|----------|
| 2026-07-30 | A3 | assistant-workspace / claude-code / codex | none | discover → dry-run → import → export → re-import；conflict / partial rollback / symlink | ✅ | `harness-home-adapter-conformance.test.ts` 19/19 |
| 2026-07-30 | A4 | Claude / CodePilot / Codex facades | none | registered descriptor → canonical repository projection → prompt；canonical Skill/MCP write；stale/unknown/Secret fail-closed | ✅ | `harness-home-runtime-conformance.test.ts` + related tests 74/74 |
| 2026-07-31 | A1–A4 review | canonical repository / API / boundary gate | none | nested framework leakage、invalid scope/method/evidence、inline secrets、forged/dead lease、journal path、unchanged/external-edited consistency | ✅ 定向 65/65；全量 4904/4904；production build | review fix `ef396b0d`；`harness-home-boundary-guard.test.ts` / repository/design/runtime suites |
| 2026-07-31 | A2/A4 follow-up | canonical repository / Runtime projection | none | journal fsync；缺 journal 的事务目录不遮蔽同级恢复；损坏 journal 后释放 lease；非法 Taste 逐记录隔离且合法 projection 继续 | ✅ follow-up 三组 51/51；boundary gate；全量 4909/4909；production build | fix `fb77d434`；`harness-home-repository.test.ts` / `harness-home-design-method.test.ts` / `html-bundle-conformance.test.ts` |
| 2026-07-31 | A2/C1 debt closure | canonical repository / Method validation | none | 跨机器 lease 不再用本地 PID 误抢；空白/控制字符 trigger 与 non-trigger 在写入和历史读取 fail closed | ✅ 六个相关文件 76/76；全量 4917/4917；boundary gate；production build | fix `1dea192d`；`harness-home-repository.test.ts` / `harness-home-design-method.test.ts` |
| _待执行_ | A4 | CodePilot / Claude / Codex | real credential | canonical memory/skill/MCP projection | ⏳ | session ids / logs / screenshots |

## 决策日志

- 2026-07-30：从 umbrella 拆出独立工程 program，避免与 Asset DB 和 Design R&D 共用状态。
- 2026-07-30：L0/L1 import/export 与 L3 Runtime 使用两套 conformance；数据迁移不再是弱门禁。
- 2026-07-30：file-as-source-of-truth 必须有单写者、journal、atomic write、hash/rescan 和多实例 contract。
- 2026-07-30：SecretStore 在 inventory 后拍板；manifest 永远只持有 `secretRef`。
- 2026-07-30：Full Reference 允许 draft pending，但 stable canonical 必须在 CodePilot executable。
- 2026-07-30：Shared Phase 0 以 `docs/research/harness-home-v0.62-inventory-2026-07-30.md` 收口；用户授权 Codex 在隔离 worktree 直接实施并明确不启动 loop。
- 2026-07-30：A1 完成。核心 contract 使用 opaque Runtime/framework ID；manifest 保留未知 overlay/字段；stable capability 必须 executable；Secret 明文扫描、scope precedence、Taste evidence 门禁均有定向测试。A1 不接入现有 Runtime/UI，保持用户行为零变化。
- 2026-07-30：A2 完成。仓库采用 realpath 单写者 lease、显式 dead-holder takeover、同根 staging、prepared journal、manifest-last atomic rename、启动恢复和 hash/rescan；外部修改与 symlink 越界 fail-closed。SecretStore 首版只代理 v0.62 既有 stores，env/external-owned 只读，诊断不含 resolved value。
- 2026-07-30：A3 完成。首批 Assistant Workspace、Claude Code、Codex source adapters 共用 L0/L1 contract；Codex `config.toml` 不做不安全的整文件 import。普通新 adapter 目标变更面固定为自身目录 + registry + conformance，changed-files guard 强制显式 base。
- 2026-07-30：A4 工程实现完成。Runtime 元数据改为显式 compile-time registry，旧 wire 保持兼容并对 unknown fail-closed；CodePilot stable Full Reference 由自动化强制。Canonical Repository 已接三条 Runtime facade；Skill/MCP 先感知、不冒充挂载。真实凭据 smoke 留在最终 Tier 2。
- 2026-07-31：Claude review hardening 收口于 `ef396b0d`。Canonical defaults 改为 `host_application` / 中立 MIME 与 secret namespace；递归 boundary gate 进入 `npm test` 和 pre-commit。Repository scan 改为流式 hash + stat-backed 32-generation cache；任何外部编辑重新 hash，staged journal / symlink / dead-writer recovery 继续 fail-closed。
- 2026-07-31：`fb77d434` 补齐损坏 journal 的 lease 泄漏链与读侧 Taste poison 隔离。缺 journal 的 orphan transaction 只清理自身，损坏 journal 仍 fail-closed；Taste diagnostics 暴露损坏 identity，但不阻断其余合法记录进入 projection。
- 2026-07-31：`1dea192d` 为 writer lease 增加不暴露 hostname/user 原文的 hashed machine identity；只有同 identity 才进入 PID dead proof，异机和旧 lease 都 fail closed。Method activation phrase 同时补齐 write/import/read 门禁，关闭空串全局命中/屏蔽。
