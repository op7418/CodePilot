import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TranslationKey } from '../../i18n';
import {
  CONTEXT_USAGE_COLORS,
  formatTokenCount,
  getContextUsageColor,
  getContextUsageRatio,
  getContextUsageTooltip,
} from '../../components/chat/context-usage';

describe('context-usage helpers', () => {
  it('formats token counts for k/M thresholds', () => {
    assert.equal(formatTokenCount(999), '999');
    assert.equal(formatTokenCount(1500), '2k');
    assert.equal(formatTokenCount(1250000), '1.3M');
  });

  it('computes usage ratio safely', () => {
    assert.equal(getContextUsageRatio(1000, 200000, false), 0.005);
    assert.equal(getContextUsageRatio(10, 0, false), 0);
    assert.equal(getContextUsageRatio(10, 100, true), 0);
    assert.equal(getContextUsageRatio(300, 200, false), 1);
  });

  it('picks color by compacting/stale/threshold priority', () => {
    assert.equal(getContextUsageColor(0.9, true, false), CONTEXT_USAGE_COLORS.compacting);
    assert.equal(getContextUsageColor(0.9, false, true), CONTEXT_USAGE_COLORS.stale);
    assert.equal(getContextUsageColor(0.8, false, false), CONTEXT_USAGE_COLORS.danger);
    assert.equal(getContextUsageColor(0.6, false, false), CONTEXT_USAGE_COLORS.warning);
    assert.equal(getContextUsageColor(0.3, false, false), CONTEXT_USAGE_COLORS.safe);
  });

  it('builds tooltip text from mode and values', () => {
    const t = (key: TranslationKey) => key;
    assert.equal(getContextUsageTooltip(100, 200000, true, false, t), 'messageInput.compacting');
    assert.equal(getContextUsageTooltip(100, 200000, false, true, t), 'messageInput.contextRefreshPending');
    assert.equal(getContextUsageTooltip(1200, 200000, false, false, t), '1k / 200k');
  });
});
