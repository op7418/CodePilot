/**
 * #27 — pin-incomplete 不能被渲染成"模型在当前执行环境不可用 / 阻断"。
 *
 * resolver 层（resolveNewChatDefault）已正确区分三种 reason，覆盖在
 * runtime-effective.test.ts（pin-incomplete / provider-missing / model-missing）。
 * 本文件 source-pin 守 **UI 层**：useOverviewData 把 reason plumb 进 state，
 * HealthSection + RuntimePanel 对 pin-incomplete 单独出"固定信息不完整"文案，
 * 且不再用 error/"阻断"/"not executable" 误导（与 RuntimePanel 自动 fallback 口径一致）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

describe('#27 pin-incomplete UI differentiation (source-pin)', () => {
  it('useOverviewData 把 resolved.reason plumb 成 state.defaultInvalidReason', () => {
    const src = read('components/settings/useOverviewData.ts');
    assert.match(src, /defaultInvalidReason\b/);
    assert.match(src, /next\.defaultInvalidReason\s*=\s*resolved\.reason/);
  });

  it('HealthSection 分支 pin-incomplete，且不再 error/阻断/"not executable"', () => {
    const src = read('components/settings/HealthSection.tsx');
    const enSrc = read('i18n/en.ts');
    const zhSrc = read('i18n/zh.ts');
    assert.match(src, /defaultInvalidReason\s*===\s*"pin-incomplete"/);
    assert.match(src, /health\.defaultModel\.pinIncompleteReason/);
    assert.match(zhSrc, /'health\.defaultModel\.pinIncompleteReason':[\s\S]{0,120}固定信息不完整/);
    assert.match(enSrc, /'health\.defaultModel\.pinIncompleteReason':[\s\S]{0,120}incomplete \(missing provider/);
    // 旧的吓人/误导文案必须移除（invalid-default 分支不再用）
    assert.doesNotMatch(src, /not executable under current Runtime/);
    assert.doesNotMatch(src, /新消息会被阻断/);
    const enHealthBlock = enSrc.slice(enSrc.indexOf('// Settings — Health'));
    const zhHealthBlock = zhSrc.slice(zhSrc.indexOf('// Settings — Health'));
    assert.doesNotMatch(enHealthBlock, /not executable under current Runtime/);
    assert.doesNotMatch(zhHealthBlock, /新消息会被阻断/);
  });

  it('RuntimePanel banner 分支 invalidDefault.reason === pin-incomplete', () => {
    const src = read('components/settings/RuntimePanel.tsx');
    const enSrc = read('i18n/en.ts');
    const zhSrc = read('i18n/zh.ts');
    assert.match(src, /invalidDefault\.reason\s*===\s*"pin-incomplete"/);
    assert.match(src, /runtime\.invalidDefault\.pinIncompleteTitle/);
    assert.match(zhSrc, /'runtime\.invalidDefault\.pinIncompleteTitle':\s*'默认模型固定信息不完整'/);
    assert.match(enSrc, /'runtime\.invalidDefault\.pinIncompleteTitle':\s*'Pinned default is incomplete'/);
  });
});
