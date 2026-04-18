import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowThinkingPhaseIndicator } from '@/lib/streaming-status';

describe('shouldShowThinkingPhaseIndicator', () => {
  it('shows thinking indicator when stream has no content and no status', () => {
    assert.equal(
      shouldShowThinkingPhaseIndicator({
        isStreaming: true,
        content: '',
        toolUsesCount: 0,
        thinkingContent: '',
        statusText: undefined,
      }),
      true,
    );
  });

  it('hides thinking indicator when reconnect status is present', () => {
    assert.equal(
      shouldShowThinkingPhaseIndicator({
        isStreaming: true,
        content: '',
        toolUsesCount: 0,
        thinkingContent: '',
        statusText: 'Reconnecting to previous conversation...',
      }),
      false,
    );
  });

  it('hides thinking indicator after stream has content', () => {
    assert.equal(
      shouldShowThinkingPhaseIndicator({
        isStreaming: true,
        content: 'partial answer',
        toolUsesCount: 0,
        thinkingContent: '',
        statusText: undefined,
      }),
      false,
    );
  });
});
