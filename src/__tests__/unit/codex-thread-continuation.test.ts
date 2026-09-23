import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RuntimeSessionRef } from '@/lib/runtime/contract';
import type { CodexTurnInputBlock } from '@/lib/codex/types';
import { prepareCodexThread, startCodexTurnWithContext } from '@/lib/codex/thread-continuation';

const ref = (providerId: string): RuntimeSessionRef => ({
  runtimeId: 'codex_runtime', token: 'old-thread',
  metadata: { providerId, mcpConfigFingerprint: 'mcp' },
});
const history = [
  { role: 'user' as const, content: 'Remember: the project colour is violet.' },
  { role: 'assistant' as const, content: 'Violet, understood.' },
];

describe('Codex continuation within the existing product chat', () => {
  it('resumes a compatible thread when only its model changes', async () => {
    let resumed = '';
    const result = await prepareCodexThread({
      existingRef: ref('deepseek'), providerId: 'deepseek', mcpFingerprint: 'mcp',
      resume: async id => { resumed = id; },
      start: async () => { throw new Error('must not start'); },
    });
    assert.equal(resumed, 'old-thread');
    assert.deepEqual(result, { threadId: 'old-thread', resumed: true });
  });

  for (const [from, to] of [
    ['codex_account', 'deepseek'], ['deepseek', 'glm'], ['glm', 'codex_account'],
  ]) {
    it(`rebuilds provider execution for ${from} → ${to}`, async () => {
      const existingRef = ref(from);
      let resumes = 0;
      const result = await prepareCodexThread({
        existingRef, providerId: to, mcpFingerprint: 'mcp',
        resume: async () => { resumes++; },
        start: async () => 'replacement-thread',
      });
      assert.deepEqual(result, { threadId: 'replacement-thread', resumed: false });
      assert.equal(resumes, 0);
      assert.deepEqual(existingRef, ref(from));
    });
  }

  it('reconstructs history after MCP configuration changes or resume failure', async () => {
    for (const fingerprint of ['mcp', 'changed']) {
      let resumeCalls = 0;
      const result = await prepareCodexThread({
        existingRef: ref('glm'), providerId: 'glm', mcpFingerprint: fingerprint,
        resume: async () => { resumeCalls++; throw new Error('thread unavailable'); },
        start: async () => 'replacement-thread',
      });
      assert.equal(resumeCalls, fingerprint === 'mcp' ? 1 : 0);
      assert.equal(result.resumed, false);
    }
  });

  it('supplies prior context once and saves the ref only after the turn is accepted', async () => {
    const order: string[] = [];
    const result = await startCodexTurnWithContext({
      thread: { threadId: 'replacement-thread', resumed: false },
      prompt: 'What colour?', history, sessionSummary: 'Earlier we chose a project name.',
      startTurn: async blocks => {
        assert.equal(blocks[0].type, 'text');
        const text = (blocks[0] as { text: string }).text;
        assert.match(text, /Earlier we chose a project name/);
        assert.match(text, /Human: Remember: the project colour is violet/);
        assert.match(text, /Assistant: Violet, understood/);
        assert.equal(text.split('What colour?').length - 1, 1);
        order.push('accepted');
        return { turn: { id: 'turn-id' } };
      },
      saveThread: () => { order.push('saved'); },
    });
    assert.deepEqual(result, { turn: { id: 'turn-id' } });
    assert.deepEqual(order, ['accepted', 'saved']);
  });

  it('does not replay history on a successful resume', async () => {
    await startCodexTurnWithContext({
      thread: { threadId: 'old-thread', resumed: true },
      prompt: 'Next question', history, sessionSummary: 'Already in the thread',
      startTurn: async blocks => { assert.deepEqual(blocks, [{ type: 'text', text: 'Next question' }]); },
      saveThread: () => { assert.fail('resumed ref already persisted'); },
    });
  });

  it('keeps the old ref on failed input and replays history again on retry', async () => {
    let saved = ref('codex_account');
    const prompts: CodexTurnInputBlock[][] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const thread = await prepareCodexThread({
        existingRef: saved, providerId: 'deepseek', mcpFingerprint: 'mcp',
        resume: async () => { assert.fail('failed replacement must not be resumed'); },
        start: async () => `replacement-${attempt}`,
      });
      const turn = startCodexTurnWithContext({
        thread, prompt: 'Recall the colour', history,
        startTurn: async blocks => {
          prompts.push(blocks);
          if (attempt === 0) throw new Error('input rejected');
        },
        saveThread: () => { saved = { ...ref('deepseek'), token: thread.threadId }; },
      });
      if (attempt === 0) {
        await assert.rejects(turn, /input rejected/);
        assert.deepEqual(saved, ref('codex_account'));
      } else await turn;
    }
    assert.deepEqual(prompts[0], prompts[1]);
    assert.match(JSON.stringify(prompts[1]), /violet/);
    assert.equal(saved.token, 'replacement-1');
  });

  it('preserves the existing ref when a replacement thread fails to start', async () => {
    const saved = ref('codex_account');
    await assert.rejects(prepareCodexThread({
      existingRef: saved, providerId: 'glm', mcpFingerprint: 'mcp',
      resume: async () => {}, start: async () => { throw new Error('start rejected'); },
    }), /start rejected/);
    assert.deepEqual(saved, ref('codex_account'));
  });

  it('returns to a provider with all intervening conversation rather than its old branch', async () => {
    const thread = await prepareCodexThread({
      existingRef: ref('deepseek'), providerId: 'codex_account', mcpFingerprint: 'mcp',
      resume: async () => { assert.fail('different provider'); }, start: async () => 'account-replacement',
    });
    await startCodexTurnWithContext({
      thread, prompt: 'What changed?',
      history: [...history, { role: 'user', content: 'After switching we renamed it Atlas.' }],
      startTurn: async blocks => {
        assert.match(JSON.stringify(blocks), /violet/);
        assert.match(JSON.stringify(blocks), /renamed it Atlas/);
      }, saveThread: () => {},
    });
  });

  it('preserves the prompt and current image input for a chat with no history', async () => {
    await startCodexTurnWithContext({
      thread: { threadId: 'first-thread', resumed: false }, prompt: 'Describe this',
      files: [{ id: 'image', name: 'test.png', type: 'image/png', size: 1, data: '', filePath: '/tmp/test.png' }],
      startTurn: async blocks => { assert.deepEqual(blocks, [
        { type: 'text', text: 'Describe this' }, { type: 'localImage', path: '/tmp/test.png' },
      ]); }, saveThread: () => {},
    });
  });
});
