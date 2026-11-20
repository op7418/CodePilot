import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';

import {
  pruneOldToolResults,
  pruneOldToolResultsByBudget,
  estimateTokens,
} from '../../lib/context-pruner';

// ────────────────────────────────────────────────────────────────
// Test helpers — build minimal ModelMessage shapes
// ────────────────────────────────────────────────────────────────

function userMsg(text: string): ModelMessage {
  return { role: 'user', content: text } as ModelMessage;
}

function assistantMsg(text: string): ModelMessage {
  return { role: 'assistant', content: text } as ModelMessage;
}

function toolMsg(toolCallId: string, resultText: string, toolName = 'Read'): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value: resultText },
      },
    ],
  } as ModelMessage;
}

// ────────────────────────────────────────────────────────────────
// pruneOldToolResults (legacy) — unchanged behavior
// ────────────────────────────────────────────────────────────────

describe('pruneOldToolResults (legacy fixed-window mode)', () => {
  it('returns messages as-is when under the recent window', () => {
    const msgs = [
      userMsg('first'),
      assistantMsg('reply 1'),
      toolMsg('call1', 'result 1 body'),
    ];
    const result = pruneOldToolResults(msgs);
    assert.deepEqual(result, msgs);
  });

  it('replaces older tool-result content with a marker that preserves tool name + excerpt', () => {
    // Build 20 messages so indices 0..3 fall outside the 16-turn recent window
    const msgs: ModelMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(toolMsg(`call${i}`, `result ${i} with a lot of body content`));
    }
    const result = pruneOldToolResults(msgs);
    assert.equal(result.length, msgs.length);

    // Index 0..3 should be pruned (older than 16-turn window)
    // Index 4..19 (last 16) should be kept as-is
    const prunedContent = result[0].content as Array<{ output?: { value: string }; toolName?: string }>;
    const output = prunedContent[0].output;
    assert.ok(output);
    // New marker keeps tool name and result excerpt so the model can retain
    // semantic context instead of narrating a tool call that never executed.
    assert.ok(
      output.value.startsWith('[Pruned'),
      `expected "[Pruned ..." marker, got: ${output.value}`,
    );
    assert.ok(
      output.value.includes('result 0 with a lot of body content'),
      `marker should contain a result excerpt for context, got: ${output.value}`,
    );

    // Last message (index 19) should keep its original body
    const keptContent = result[19].content as Array<{ output?: { value: string } }>;
    assert.equal(keptContent[0].output?.value, 'result 19 with a lot of body content');
  });

  it('keeps tool name in the marker so model can match call→result', () => {
    // Semantic regression test: the marker must include the tool name (or at
    // least a placeholder) so the assistant doesn't
    // emit a fake tool call to "retry" what it thinks is a missing result.
    const msgs: ModelMessage[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(toolMsg(`call${i}`, `body${i}`, `MyToolName${i}`));
    }
    const result = pruneOldToolResults(msgs);
    const prunedContent = result[0].content as Array<{ output?: { value: string } }>;
    const marker = prunedContent[0].output?.value || '';
    assert.ok(
      marker.includes('MyToolName0'),
      `marker should include tool name; got: ${marker}`,
    );
  });

  it('leaves user messages unchanged even in the pruned window', () => {
    const msgs: ModelMessage[] = [];
    for (let i = 0; i < 20; i++) msgs.push(userMsg(`msg ${i}`));
    const result = pruneOldToolResults(msgs);
    // All user messages preserved (only tool-result content gets pruned)
    assert.deepEqual(result, msgs);
  });
});

// ────────────────────────────────────────────────────────────────
// pruneOldToolResultsByBudget — enhanced mode
// ────────────────────────────────────────────────────────────────

describe('pruneOldToolResultsByBudget (enhanced)', () => {
  it('returns messages unchanged when under budget', () => {
    const msgs = [userMsg('short'), assistantMsg('also short')];
    const result = pruneOldToolResultsByBudget(msgs, { tokenBudget: 10_000 });
    assert.deepEqual(result, msgs);
  });

  it('returns messages unchanged when protectFirstN + protectLastN >= length', () => {
    const msgs = [userMsg('a'), assistantMsg('b'), userMsg('c')];
    const result = pruneOldToolResultsByBudget(msgs, {
      protectFirstN: 2,
      protectLastN: 2,
      tokenBudget: 1,
    });
    assert.deepEqual(result, msgs);
  });

  it('protects head + tail, prunes middle tool results', () => {
    // Build: [protectFirstN=2] user0, assistant1, [middle] tool2, tool3, tool4, tool5, [protectLastN=2] tool6, assistant7
    const longBody = 'x'.repeat(5000); // inflate estimate so budget triggers
    const msgs: ModelMessage[] = [
      userMsg('head 0'),
      assistantMsg('head 1'),
      toolMsg('call2', longBody),
      toolMsg('call3', longBody),
      toolMsg('call4', longBody),
      toolMsg('call5', longBody),
      toolMsg('call6', longBody),
      assistantMsg('tail final'),
    ];

    const result = pruneOldToolResultsByBudget(msgs, {
      tokenBudget: 1_000, // force pruning
      protectFirstN: 2,
      protectLastN: 2,
    });

    assert.equal(result.length, msgs.length);

    // Head preserved verbatim
    assert.equal((result[0] as { content: string }).content, 'head 0');
    assert.equal((result[1] as { content: string }).content, 'head 1');

    // Middle (indices 2..5) pruned
    for (let i = 2; i < 6; i++) {
      const content = result[i].content as Array<{ output?: { value: string } }>;
      const output = content[0].output;
      assert.ok(output);
      assert.ok(
        output.value.length < 200,
        `middle msg ${i} should be short, got ${output.value.length} chars`,
      );
    }

    // Tail preserved verbatim (indices 6 and 7)
    const tailContent = result[6].content as Array<{ output?: { value: string } }>;
    assert.equal(tailContent[0].output?.value, longBody);
    assert.equal((result[7] as { content: string }).content, 'tail final');
  });

  it('keepToolCallSummary=true embeds the toolCallId in the marker', () => {
    const longBody = 'x'.repeat(10_000);
    const msgs: ModelMessage[] = [
      userMsg('head'),
      toolMsg('abc12345xyz', longBody),
      toolMsg('def67890abc', longBody),
      userMsg('tail'),
    ];

    const result = pruneOldToolResultsByBudget(msgs, {
      tokenBudget: 500,
      protectFirstN: 1,
      protectLastN: 1,
      keepToolCallSummary: true,
    });

    const pruned1 = result[1].content as Array<{ output?: { value: string } }>;
    assert.ok(pruned1[0].output?.value.includes('abc12345'));
  });

  it('keepToolCallSummary=false falls back to the generic marker', () => {
    const longBody = 'x'.repeat(10_000);
    const msgs: ModelMessage[] = [
      userMsg('head'),
      toolMsg('abc12345', longBody),
      userMsg('tail'),
    ];

    const result = pruneOldToolResultsByBudget(msgs, {
      tokenBudget: 100,
      protectFirstN: 1,
      protectLastN: 1,
      keepToolCallSummary: false,
    });

    const pruned = result[1].content as Array<{ output?: { value: string } }>;
    assert.ok(pruned[0].output?.value.includes('truncated'));
    assert.ok(!pruned[0].output?.value.includes('abc12345'));
  });

  it('empty message array returns empty', () => {
    const result = pruneOldToolResultsByBudget([], { tokenBudget: 1 });
    assert.deepEqual(result, []);
  });

  it('does not modify user or assistant text messages in the middle', () => {
    const msgs: ModelMessage[] = [
      userMsg('head'),
      userMsg('middle user — stays'),
      assistantMsg('middle assistant — stays'),
      userMsg('tail'),
    ];
    // Force pruning with a tiny budget
    const result = pruneOldToolResultsByBudget(msgs, {
      tokenBudget: 1,
      protectFirstN: 1,
      protectLastN: 1,
    });
    // Middle should be exactly the same objects
    assert.equal(result[1], msgs[1]);
    assert.equal(result[2], msgs[2]);
  });
});

// ────────────────────────────────────────────────────────────────
// estimateTokens
// ────────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty message array', () => {
    assert.equal(estimateTokens([]), 0);
  });

  it('scales with content length', () => {
    const short = [userMsg('hi')];
    const long = [userMsg('x'.repeat(1000))];
    assert.ok(estimateTokens(long) > estimateTokens(short));
  });

  it('handles tool-result output objects', () => {
    const msgs = [toolMsg('c1', 'this is a tool result with some content')];
    const tokens = estimateTokens(msgs);
    assert.ok(tokens > 0);
  });
});
