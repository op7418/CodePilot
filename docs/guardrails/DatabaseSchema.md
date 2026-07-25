# DatabaseSchema Guardrail

> **Status: Active contract** — 覆盖 SQLite schema 初始化、增量加列、保守 backfill、幂等与测试隔离。
> **为什么先读**：用户真实数据在 `~/.codepilot/codepilot.db`；schema 迁移**必须 backfill，不能 DELETE 用户数据**（`feedback_db_migration_safety.md`）。一次错误的 migration 可能让用户丢失所有历史会话 / Provider 配置。
> **已知关键文件**：`src/lib/db.ts`（schema + migration runner）；`src/types/index.ts`（DB 行类型）。

## 词汇表

- **Bootstrap schema**：`getDb()` 首次打开数据库时执行的 `CREATE TABLE IF NOT EXISTS` 基线。
- **On-touch migration**：启动时通过 `PRAGMA table_info` 检测旧库缺列，再用 `ALTER TABLE ... ADD COLUMN` 增量升级。
- **Backfill**：在保留原行与关联数据的前提下，为旧数据补出可证明的新字段值。
- **Conservative fingerprint**：只有全部必要证据同时成立才写入身份；证据不足保持默认空值并交给用户确认。
- **Idempotent migration**：同一数据库重复启动/执行迁移，第二次及以后不再改变结果。
- **DB-wins**：`provider_models` 中的 manual / user-edited 行优先于 catalog，不因 schema/catalog 迁移被覆盖。

## 不变量 / 契约表

| # | 不变量 | 由谁守 |
|---|--------|--------|
| 1 | Migration 必须保留所有用户数据（backfill 而不是 DELETE）；新增字段用默认值填，不要求用户手动迁移 | `src/lib/db.ts` migration 函数 |
| 2 | 每个 migration 必须可重入：先检测列/表状态，backfill 只更新仍处于 legacy 默认值且证据充分的行 | `PRAGMA table_info` + 带条件 `UPDATE` |
| 3 | schema 变更必须同时更新 bootstrap schema、旧库 on-touch migration、TypeScript 行类型和全部 CRUD SQL | `src/lib/db.ts`, `src/types/index.ts` |
| 4 | 多步 backfill 必须在一个 SQLite transaction 内完成；任一步失败不得留下半迁移身份 | `db.transaction(...)` |
| 5 | 身份/协议类 backfill 必须 fail closed：ambiguous 或 fingerprint 不完整时保留空值，不按数组顺序、名称、key 前缀或模型子集猜测 | provider migration helper |
| 6 | provider schema/catalog 迁移不得删除或改写 `manual`、`user_edited=1` 模型行，也不得删除 provider/session/message | migration + provider model reconciliation |
| 7 | 测试不得触碰用户数据库；必须使用 `CLAUDE_GUI_DATA_DIR` 隔离目录并关闭并发 Codex runtime | `db-isolation.setup.ts`, `CODEX_DISABLED=1` |

## 关键文件 + 责任

| 文件 | 守哪条不变量 |
|------|--------------|
| `src/lib/db.ts` | bootstrap schema、on-touch migration、事务 backfill、CRUD SQL、better-sqlite3 句柄管理 |
| `src/types/index.ts` | DB 行类型与 create/update API 请求形状一致 |
| `src/lib/provider-catalog.ts` | preset identity 的唯一/ambiguous 判定；migration 不自造另一套 matcher |
| `src/__tests__/db-isolation.setup.ts` | 每个测试进程使用隔离数据库目录 |

## 改动检查表

- [ ] 加新列时填默认值不要让历史行变 NULL
- [ ] 同时修改最早 bootstrap `CREATE TABLE` 与兼容旧库的 `CREATE TABLE IF NOT EXISTS`
- [ ] 同时修改 `ApiProvider` / request type / INSERT / UPDATE / masked API response
- [ ] backfill 是否只写可证明行，ambiguous/invalid 是否保持默认值
- [ ] 多表读取或多行更新是否包在 transaction，重复执行结果是否相同
- [ ] 是否保留 provider、model、session、message 数量及 manual/user-edited 字段
- [ ] 加新表时考虑用户已有的同名表冲突（不应该发生但要兜底）
- [ ] 改字段类型时必须有显式 migration step，不能依赖 SQLite 隐式 coerce
- [ ] 删字段 / 删表前先确认无用户数据依赖
- [ ] targeted migration test + `npm run test`；Provider/Runtime 字段再跑 build 与相关 smoke

## 常见坑

- 跨 Worktree / 多进程共用同一份 DB 文件时会抢 SQLite 锁（Phase 5b round 6 的 30 分钟卡死事件根因）。测试要用 `CODEX_DISABLED=1` 隔离。
- 只改后面的兼容 `CREATE TABLE`、漏改文件开头 bootstrap schema，会让新库与旧库最终形状不同。
- 只靠 `ALTER TABLE ... DEFAULT` 不等于完成语义迁移；身份字段需要保守 backfill，无法证明时必须留空。
- 用 URL first-match 回填同 host 的多个套餐会制造静默 cross-wire；必须先判断候选是否唯一。
- catalog 更新时直接重建 `provider_models` 会抹掉 manual/user-edited 状态；只能 reconcile catalog 管理行。
- tech-debt #7 — `claude-settings-credentials.test.ts` 和 `project-mcp-injection.test.ts` 的 DB-related test 在 CI 上 skip，本地通过；疑似 tsx + node 20 ESM module identity 去重在 linux 行为差异。

## 测试覆盖

| 契约 | 测试文件 |
|------|----------|
| schema 加列、legacy backfill、幂等、ambiguous 保留 | `src/__tests__/unit/provider-preset-identity-migration.test.ts` |
| provider create/update 字段 roundtrip | `src/__tests__/unit/provider-key-lifecycle.test.ts`, `provider-preset-switch-route.test.ts` |
| DB-wins、hidden/manual/user-edited 保留 | `provider-resolver.test.ts`, `apply-discovery-diff.test.ts`, `align-enabled-with-catalog.test.ts` |
| 全量类型与单测门禁 | `npm run test` |

## 设计决策日志

- 2026-07-21 — 首次激活 guardrail。为 Qwen personal/team 同 URL 身份新增 `preset_key` 时，规定显式 identity 为真源、legacy 只允许唯一匹配、团队旧 preset 仅按完整 catalog/role fingerprint 回填；不确定行保留空值等待用户确认。
