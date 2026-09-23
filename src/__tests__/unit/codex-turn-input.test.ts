/**
 * codex-turn-input.test.ts — #632 / Phase 2 #3 guardrail.
 *
 * Codex Runtime used to send `turn/start` input as text-only, silently dropping
 * image attachments (codex/runtime.ts). buildCodexTurnInput now maps image/*
 * attachments to the app-server's image / localImage blocks (wire format
 * confirmed by POC: docs/research/codex-image-input-poc/FINDINGS.md).
 *
 * Behavioral tests on the pure helper + source-pins that runtime.ts actually
 * uses it (so a refactor can't quietly restore the text-only regression).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCodexTurnInput } from '../../lib/codex/turn-input';
import type { FileAttachment } from '../../types';

const file = (over: Partial<FileAttachment>): FileAttachment => ({
  id: 'id', name: 'f', type: 'image/png', size: 1, data: '', filePath: undefined, ...over,
});

describe('buildCodexTurnInput (#632 / Phase 2 #3)', () => {
  it('text-only when there are no files', () => {
    assert.deepEqual(buildCodexTurnInput('hello'), [{ type: 'text', text: 'hello' }]);
  });

  it('text always leads, then image blocks', () => {
    const out = buildCodexTurnInput('describe', [file({ type: 'image/png', filePath: '/abs/a.png' })]);
    assert.equal(out[0].type, 'text');
    assert.equal((out[0] as { text: string }).text, 'describe');
    assert.equal(out.length, 2);
  });

  it('a persisted image (filePath) → localImage block with the path', () => {
    const out = buildCodexTurnInput('x', [file({ type: 'image/png', filePath: '/work/.codepilot-uploads/a.png', data: '' })]);
    assert.deepEqual(out[1], { type: 'localImage', path: '/work/.codepilot-uploads/a.png' });
  });

  it('an in-memory image (base64 data, no path) → image block with a data URL', () => {
    const out = buildCodexTurnInput('x', [file({ type: 'image/jpeg', data: 'QUJD', filePath: undefined })]);
    assert.deepEqual(out[1], { type: 'image', url: 'data:image/jpeg;base64,QUJD' });
  });

  it('prefers filePath over data when both are present (avoids a multi-MB data URL)', () => {
    const out = buildCodexTurnInput('x', [file({ type: 'image/png', data: 'QUJD', filePath: '/abs/a.png' })]);
    assert.deepEqual(out[1], { type: 'localImage', path: '/abs/a.png' });
  });

  it('skips non-image files (Codex turn input has no generic file block)', () => {
    const out = buildCodexTurnInput('x', [
      file({ type: 'text/plain', name: 'c.txt', data: 'x', filePath: '/abs/c.txt' }),
      file({ type: 'application/pdf', name: 'd.pdf', filePath: '/abs/d.pdf' }),
    ]);
    assert.deepEqual(out, [{ type: 'text', text: 'x' }]);
  });

  it('skips an image with neither a path nor data (nothing to send)', () => {
    const out = buildCodexTurnInput('x', [file({ type: 'image/png', data: '', filePath: undefined })]);
    assert.deepEqual(out, [{ type: 'text', text: 'x' }]);
  });

  it('handles multiple mixed attachments in order', () => {
    const out = buildCodexTurnInput('x', [
      file({ type: 'image/png', filePath: '/a.png' }),
      file({ type: 'text/plain', data: 'skip', filePath: '/c.txt' }),
      file({ type: 'image/webp', data: 'V0VC', filePath: undefined }),
    ]);
    assert.deepEqual(out, [
      { type: 'text', text: 'x' },
      { type: 'localImage', path: '/a.png' },
      { type: 'image', url: 'data:image/webp;base64,V0VC' },
    ]);
  });
});

describe('codex/runtime.ts wires buildCodexTurnInput into turn/start (no text-only regression)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib/codex/runtime.ts'), 'utf8');

  it('turn/start receives context-aware input with the current attachments', () => {
    assert.match(
      src,
      /startCodexTurnWithContext\(\{[\s\S]{0,150}prompt: options\.prompt,[\s\S]{0,100}files: turnFiles/,
      'context-aware turn input must receive both the prompt and current attachments',
    );
    const continuation = fs.readFileSync(path.join(__dirname, '..', '..', 'lib/codex/thread-continuation.ts'), 'utf8');
    assert.match(continuation, /buildCodexTurnInput\(input\.prompt, input\.files\)/);
    assert.match(continuation, /await buildCodexContinuationInput\(input\)/);
    assert.match(continuation, /input\.startTurn\(blocks\)/);
    assert.match(src, /startTurn: \(input\) => client\.request[\s\S]{0,120}'turn\/start',[\s\S]{0,80}input,/);
  });

  it('the old text-only hardcoded input is gone', () => {
    assert.doesNotMatch(
      src,
      /input:\s*\[\s*\{\s*type:\s*'text',\s*text:\s*options\.prompt\s*\}\s*\]/,
      'the text-only input array must not be restored (it silently drops image attachments under Codex)',
    );
  });

  it('reads image attachments from runtimeOptions.files', () => {
    assert.match(
      src,
      /options\.runtimeOptions\?\.files as FileAttachment\[\]/,
      'runtime must read the file attachments passed through runtimeOptions.files',
    );
  });
});
