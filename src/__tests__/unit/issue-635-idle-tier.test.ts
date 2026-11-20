/**
 * #635 — two-tier idle budget so a slow third-party proxy queueing BEFORE the
 * first token isn't hard-aborted at the old flat 330s, WITHOUT re-introducing
 * the "blind keepalive masks a real hang" risk (the SDK is silent while queueing
 * — its keep_alive is filtered before the app iterator, so there's no liveness
 * signal to fake; we just give a longer fuse before the first token and keep a
 * real upper bound).
 *
 * Codex P2: "first token" must map to the actual SSE event names — `text` /
 * `thinking` / `tool_use` count; `status`/init, `tool_result`/`tool_output` and
 * the terminal `result` do NOT (a terminal / tool-call-only result flipping the
 * flag would skew the two-tier semantics). This file pins the positive set AND
 * that exactly three callbacks may flip it.
 *
 * Source-pin: the idle checker runs in a setInterval over a live fetch SSE — not
 * unit-drivable without mocking the whole stream (same constraint as
 * stream-result-error-guard / codex-proxy-error-visibility). Real slow-proxy
 * behaviour is a follow-up smoke.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ssm = readFileSync(path.resolve(__dirname, '../../lib/stream-session-manager.ts'), 'utf8');
const cc = readFileSync(path.resolve(__dirname, '../../lib/claude-client.ts'), 'utf8');

describe('#635 — two-tier idle budget (stream-session-manager source pins)', () => {
  it('defines a longer PRE-first-token budget and a shorter POST budget', () => {
    const preMatch = ssm.match(/STREAM_IDLE_PRE_FIRST_TOKEN_MS = ([\d_]+)/);
    const postMatch = ssm.match(/STREAM_IDLE_POST_FIRST_TOKEN_MS = ([\d_]+)/);
    assert.ok(preMatch && postMatch, 'both budget constants must be defined');
    const pre = Number(preMatch![1].replace(/_/g, ''));
    const post = Number(postMatch![1].replace(/_/g, ''));
    assert.ok(pre > post, `PRE (${pre}) must be a longer fuse than POST (${post})`);
  });

  it('the idle checker selects the budget by sawUpstreamModelOutput, and still aborts', () => {
    assert.match(
      ssm,
      /sawUpstreamModelOutput\s*\?\s*STREAM_IDLE_POST_FIRST_TOKEN_MS\s*:\s*STREAM_IDLE_PRE_FIRST_TOKEN_MS/,
    );
    assert.match(ssm, /Date\.now\(\) - stream\.lastEventTime >= idleBudget[\s\S]{0,140}abort\(\)/);
  });

  it('ONLY text / thinking / tool_use flip the first-token flag — exactly 3 (Codex P2)', () => {
    const flips = ssm.match(/sawUpstreamModelOutput = true/g) ?? [];
    assert.equal(
      flips.length,
      3,
      'exactly the three model-output callbacks (text/thinking/tool_use) may flip the flag — ' +
        'status/result/tool_result must NOT (would skew the two-tier semantics)',
    );
    assert.match(ssm, /onText:[\s\S]{0,140}sawUpstreamModelOutput = true/);
    assert.match(ssm, /onThinking:[\s\S]{0,140}sawUpstreamModelOutput = true/);
    assert.match(ssm, /onToolUse:[\s\S]{0,180}sawUpstreamModelOutput = true/);
  });
});

describe('#635 — api_retry liveness wiring + dead keep_alive (claude-client source pins)', () => {
  it('forwards api_retry as a status SSE (→ client onStatus → markActive)', () => {
    assert.match(
      cc,
      /subtype as string\) === 'api_retry'[\s\S]{0,800}type: 'status'[\s\S]{0,200}apiRetry: true/,
    );
  });

  it('marks the keep_alive branch dead (SDK transport filters it before the app iterator)', () => {
    assert.match(cc, /mType === 'keep_alive'[\s\S]{0,140}DEAD BRANCH/);
  });
});

describe('#635 — api_retry status shows human copy, not raw JSON (Codex P2 follow-up)', () => {
  const sse = readFileSync(path.resolve(__dirname, '../../hooks/useSSEStream.ts'), 'utf8');
  const page = readFileSync(path.resolve(__dirname, '../../app/chat/page.tsx'), 'utf8');

  it('useSSEStream has a dedicated apiRetry branch BEFORE the safe generic fallback', () => {
    assert.match(sse, /statusData\.apiRetry[\s\S]{0,600}Retrying upstream/);
    // Must precede the generic fallback. The fallback itself is now safe — it
    // only passes ordinary human strings and degrades structured JSON to
    // localized copy — but apiRetry still carries more useful attempt detail.
    const retryIdx = sse.indexOf('statusData.apiRetry');
    const fallbackIdx = sse.indexOf('callbacks.onStatus(resolveSafeStatusFallback');
    assert.ok(retryIdx > 0 && retryIdx < fallbackIdx, 'apiRetry branch must precede the safe generic fallback');
  });

  it('first-message page.tsx has the same apiRetry branch BEFORE its safe generic fallback', () => {
    assert.match(page, /statusData\.apiRetry[\s\S]{0,600}Retrying upstream/);
    const retryIdx = page.indexOf('statusData.apiRetry');
    const fallbackIdx = page.indexOf('setStatusText(resolveSafeStatusFallback');
    assert.ok(retryIdx > 0 && retryIdx < fallbackIdx, 'apiRetry branch must precede the safe generic fallback');
  });
});
