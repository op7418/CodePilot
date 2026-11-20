<!--
P0/P1 bug 修复 PR 优先评审与合并。
每个合入的 PR 必须有测试，或明确说明为什么不需要。
-->

## Summary / 摘要
<!-- 一句话说清这个 PR 做了什么、面向用户的变化是什么 -->

## Repro / root cause / 复现与根因
<!-- 修 bug 必填：原来怎么错的、根因是什么。纯重构/文档可写 N/A -->

## Changes / 改动
<!-- 按文件或模块列出改了什么、为什么 -->

## Tests / 测试
<!-- 跑了哪些：npm run test / test:smoke / test:e2e / 手测路径。没测要说明原因 -->

## Screenshots / logs（UI 或 Electron 改动必填）
<!-- 截图或日志；响应式/主题相关给多态 -->

## 自查清单 / Checklist
- [ ] 涉及 i18n → 已同步 `src/i18n/en.ts` 与 `zh.ts`
- [ ] 涉及 DB → 已在 `src/lib/db.ts` 更新 schema 迁移（且不删用户数据）
- [ ] 涉及类型 → 已更新 `src/types/index.ts`
- [ ] 涉及文档 → 已更新 `docs/` 对应交接/索引
- [ ] `npm run test` 通过（typecheck + 单元）
- [ ] 已读 [AGENTS.md](../AGENTS.md)，涉及的模块已对照 `docs/guardrails/`
