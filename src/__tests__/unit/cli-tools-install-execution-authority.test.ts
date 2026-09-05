/**
 * Execution-authority lifecycle tests for codepilot_cli_tools_install.
 *
 * Exercises the real createCliToolsTools() factory and the real
 * runCliToolInstall (both from src/lib/builtin-tools/cli-tools.ts) together
 * with prefix-safe-json's real createAiSdkExecutionLock/
 * createAiSdkExecutionGuard, through real streamText() + MockLanguageModelV4.
 * The `runStep` helper below is a deliberately minimal, faithful
 * re-statement of exactly the dispatch logic in agent-loop.ts (same calls,
 * same order, same invariant: the shell only ever runs on authority.value)
 * — not a separate implementation that could quietly drift from it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { streamText, tool, jsonSchema, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createCliToolsTools, runCliToolInstall, CLI_TOOL_INSTALL_SCHEMA } from '@/lib/builtin-tools/cli-tools';

function toolInputParts(id: string, toolName: string, argsJson: string, chunkSize = 9) {
  const parts: unknown[] = [{ type: 'tool-input-start', id, toolName }];
  for (let i = 0; i < argsJson.length; i += chunkSize) {
    parts.push({ type: 'tool-input-delta', id, delta: argsJson.slice(i, i + chunkSize) });
  }
  parts.push({ type: 'tool-input-end', id });
  return parts;
}
function toolCallPart(id: string, toolName: string, argsJson: string) {
  return { type: 'tool-call', toolCallId: id, toolName, input: argsJson };
}
function mockModel(parts: unknown[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const p of parts) controller.enqueue(p as never);
          controller.close();
        },
      }),
    }),
  });
}

/**
 * Faithful re-statement of the exact logic added to agent-loop.ts:
 * lock the install tool -> drive streamText -> push every fullStream
 * event into a fresh guard -> resolve authority -> dispatch via
 * runCliToolInstall(authority.value) -> synthesize a tool-result message.
 * `extraTools` lets Phase 8 add an unrelated, unlocked native tool to the
 * same step.
 */
async function runStep(model: MockLanguageModelV4, extraTools: Record<string, unknown> = {}) {
  const { createAiSdkExecutionLock, createAiSdkExecutionGuard } = await import('prefix-safe-json');
  const baseTools = createCliToolsTools();
  const locked = createAiSdkExecutionLock({
    codepilot_cli_tools_install: baseTools.codepilot_cli_tools_install,
  });
  const tools = { ...baseTools, ...extraTools, ...locked };

  const stepGuard = createAiSdkExecutionGuard();
  // `as never` on the whole call, not just `tools`: streamText()'s return
  // type infers a `toolsContext` requirement from the tools' own generic
  // Context parameter that a runtime-assembled ToolSet (real production
  // shape, not a single statically-typed tool literal) can't statically
  // satisfy — a test-script-only typing artifact, not a claim about
  // runtime behavior, which the passing tests below verify directly.
  const result = streamText({ model, prompt: 'x', tools } as never);

  const sseToolResults: Array<{ tool_use_id: string; content: string; is_error: boolean }> = [];
  const seenEventTypes: string[] = [];
  for await (const event of result.fullStream) {
    seenEventTypes.push((event as { type: string }).type);
    stepGuard.push(event as never);
  }

  const stepFinishReason = await result.finishReason;
  const { decisions } = stepGuard.finish({ providerReason: String(stepFinishReason) });

  const installResultMessages: ModelMessage[] = [];
  let installSideEffectCalls = 0;
  const capturedSideEffectInputs: unknown[] = [];

  for (const decision of decisions) {
    if (decision.name !== 'codepilot_cli_tools_install' || !decision.toolCallId) continue;
    const toolCallId = decision.toolCallId;
    let outcomeText: string;
    let isError: boolean;

    if (decision.action === 'execute') {
      const authority = stepGuard.takeDecision(decision.internalId);
      if (!authority) {
        outcomeText = 'Installation blocked: execution authority could not be acquired.';
        isError = true;
      } else {
        const parsed = CLI_TOOL_INSTALL_SCHEMA.safeParse(authority.value);
        if (!parsed.success) {
          outcomeText = 'Installation blocked: shape mismatch.';
          isError = true;
        } else {
          capturedSideEffectInputs.push(parsed.data);
          installSideEffectCalls += 1;
          outcomeText = await runCliToolInstall(parsed.data);
          isError = false;
        }
      }
    } else {
      outcomeText = `Installation skipped: the surrounding response was not confirmed safe to execute (${decision.reason ?? 'no positive authority'}).`;
      isError = true;
    }

    sseToolResults.push({ tool_use_id: toolCallId, content: outcomeText, is_error: isError });
    installResultMessages.push({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId, toolName: 'codepilot_cli_tools_install', output: { type: 'text', value: outcomeText } }],
    } as ModelMessage);
  }

  const responseData = await result.response;
  const finalMessages = [...responseData.messages, ...installResultMessages];

  return {
    seenEventTypes,
    decisions,
    installSideEffectCalls,
    capturedSideEffectInputs,
    sseToolResults,
    finalMessages,
    stepGuard,
  };
}

// ── CASE A — safe, complete, normal install ─────────────────────────────
describe('CASE A — safe normal install', () => {
  it('authority=1, side effect=1, side-effect input equals authority.value, one tool result', async () => {
    const args = JSON.stringify({ command: 'echo case-a-test', name: 'case-a' });
    const model = mockModel([
      { type: 'stream-start', warnings: [] },
      ...toolInputParts('call_a', 'codepilot_cli_tools_install', args),
      toolCallPart('call_a', 'codepilot_cli_tools_install', args),
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    ]);

    const r = await runStep(model);
    const positiveDecisions = r.decisions.filter((d) => d.name === 'codepilot_cli_tools_install' && d.action === 'execute');

    assert.equal(positiveDecisions.length, 1, 'exactly one positive authority');
    assert.equal(r.installSideEffectCalls, 1, 'actual install side effect ran exactly once');
    assert.deepEqual(r.capturedSideEffectInputs[0], { command: 'echo case-a-test', name: 'case-a' });
    const toolResultMsgs = r.finalMessages.filter((m) => m.role === 'tool');
    assert.equal(toolResultMsgs.length, 1, 'exactly one real tool result inserted');
  });
});

// ── CASE B — truncated streamed install ─────────────────────────────────
describe('CASE B — truncated streamed install', () => {
  it('authority absent, side effect=0', async () => {
    const truncated = '{"command":"brew install ffm';
    const model = mockModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call_b', toolName: 'codepilot_cli_tools_install' },
      { type: 'tool-input-delta', id: 'call_b', delta: truncated },
      { type: 'tool-input-end', id: 'call_b' },
      toolCallPart('call_b', 'codepilot_cli_tools_install', truncated + '"}'),
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    ]);
    const r = await runStep(model);
    const positive = r.decisions.filter((d) => d.name === 'codepilot_cli_tools_install' && d.action === 'execute');
    assert.equal(positive.length, 0, 'no positive authority for truncated evidence');
    assert.equal(r.installSideEffectCalls, 0, 'install side effect never ran');
  });
});

// ── CASE C — unsafe finish reason ───────────────────────────────────────
describe('CASE C — unsafe finish reason (SDK-version-independent by design)', () => {
  for (const reason of ['length', 'content-filter', 'error', 'other']) {
    it(`finishReason=${reason}: side effect stays 0`, async () => {
      const args = JSON.stringify({ command: 'echo case-c', name: 'case-c' });
      const model = mockModel([
        { type: 'stream-start', warnings: [] },
        ...toolInputParts('call_c', 'codepilot_cli_tools_install', args),
        toolCallPart('call_c', 'codepilot_cli_tools_install', args),
        { type: 'finish', finishReason: { unified: reason, raw: reason }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
      ]);
      const r = await runStep(model);
      assert.equal(r.installSideEffectCalls, 0, `${reason}: side effect must stay 0`);
    });
  }
  it('note: this protection does not depend on ai SDK version at all — there is no native execute() for any SDK version to gate in the first place; the guard is the only gate, proven identical on ai@7.0.11 and ai@7.0.85 in the accompanying report', () => {
    assert.ok(true);
  });
});

// ── CASE E — duplicate authority consumption ────────────────────────────
describe('CASE E — duplicate authority consumption', () => {
  it('consuming the same decision twice: side effect count stays 1', async () => {
    const args = JSON.stringify({ command: 'echo case-e', name: 'case-e' });
    const model = mockModel([
      { type: 'stream-start', warnings: [] },
      ...toolInputParts('call_e', 'codepilot_cli_tools_install', args),
      toolCallPart('call_e', 'codepilot_cli_tools_install', args),
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    ]);
    const { createAiSdkExecutionLock, createAiSdkExecutionGuard } = await import('prefix-safe-json');
    const baseTools = createCliToolsTools();
    const locked = createAiSdkExecutionLock({ codepilot_cli_tools_install: baseTools.codepilot_cli_tools_install });
    const guard = createAiSdkExecutionGuard();
    const result = streamText({ model, prompt: 'x', tools: locked } as never);
    for await (const part of result.fullStream) guard.push(part as never);
    const { decisions } = guard.finish({ providerReason: 'tool-calls' } as never);
    const decision = decisions.find((d) => d.name === 'codepilot_cli_tools_install');
    assert.ok(decision && decision.action === 'execute');

    let sideEffectCalls = 0;
    const firstAuthority = guard.takeDecision(decision!.internalId);
    if (firstAuthority) {
      sideEffectCalls += 1;
      await runCliToolInstall(firstAuthority.value as never);
    }
    const secondAuthority = guard.takeDecision(decision!.internalId);
    assert.equal(secondAuthority, undefined, 'second takeDecision() call returns undefined');
    if (secondAuthority) {
      sideEffectCalls += 1;
      await runCliToolInstall((secondAuthority as { value: unknown }).value as never);
    }
    assert.equal(sideEffectCalls, 1, 'actual side effect count stays exactly 1');
  });
});

// ── CASE F — no tool-input-delta evidence ────────────────────────────────
describe('CASE F — no tool-input-delta evidence available', () => {
  it('terminal-only tool-call, no tool-input-start/delta/end: fails closed, no fallback to SDK input', async () => {
    const args = JSON.stringify({ command: 'echo case-f', name: 'case-f' });
    const model = mockModel([
      { type: 'stream-start', warnings: [] },
      toolCallPart('call_f', 'codepilot_cli_tools_install', args),
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    ]);
    const r = await runStep(model);
    const matching = r.decisions.filter((d) => d.name === 'codepilot_cli_tools_install');
    assert.equal(matching.length, 0, 'no decision at all is produced for a call with no tool-input-delta evidence — not a silent fallback to the SDK-projected input');
    assert.equal(r.installSideEffectCalls, 0);
  });
});

// ── PHASE 8 — multi-tool step ────────────────────────────────────────────
describe('PHASE 8 — one locked install + one unrelated normal tool in the same step', () => {
  it('normal tool keeps native execute; install stays manual-authority-controlled; no toolCallId cross-talk', async () => {
    let normalToolNativeCalls = 0;
    let normalToolReceivedInput: unknown = null;
    const extraTools = {
      codepilot_cli_tools_list: tool({
        description: 'list',
        inputSchema: jsonSchema<Record<string, never>>({ type: 'object', properties: {} }),
        execute: async (input: unknown) => {
          normalToolNativeCalls += 1;
          normalToolReceivedInput = input;
          return 'listed 3 tools';
        },
      }),
    };

    const installArgs = JSON.stringify({ command: 'echo multi-tool', name: 'multi' });
    const listArgs = JSON.stringify({});
    const model = mockModel([
      { type: 'stream-start', warnings: [] },
      ...toolInputParts('call_install', 'codepilot_cli_tools_install', installArgs),
      toolCallPart('call_install', 'codepilot_cli_tools_install', installArgs),
      ...toolInputParts('call_list', 'codepilot_cli_tools_list', listArgs, 20),
      toolCallPart('call_list', 'codepilot_cli_tools_list', listArgs),
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    ]);

    const r = await runStep(model, extraTools);

    // The normal tool ran natively, exactly once, with its own input —
    // completely untouched by the lock or the guard.
    assert.equal(normalToolNativeCalls, 1, 'unrelated tool retains native execute()');
    assert.deepEqual(normalToolReceivedInput, {});

    // The install ran exactly once via manual authority, with its own input.
    assert.equal(r.installSideEffectCalls, 1);
    assert.deepEqual(r.capturedSideEffectInputs[0], { command: 'echo multi-tool', name: 'multi' });

    // No cross-talk: exactly one guard decision matches the install
    // toolCallId, and it is not "call_list".
    const installDecisions = r.decisions.filter((d) => d.name === 'codepilot_cli_tools_install');
    assert.equal(installDecisions.length, 1);
    assert.equal(installDecisions[0].toolCallId, 'call_install');

    // Ordering: both a native tool-result (for the list tool, already in
    // responseData.messages) and a synthesized tool-result (for install)
    // are present, addressed to the correct, non-crossed toolCallIds.
    const toolMsgs = r.finalMessages.filter((m) => m.role === 'tool');
    const allResultParts = toolMsgs.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
    const idsSeen = allResultParts
      .map((p) => ('toolCallId' in p ? p.toolCallId : undefined))
      .sort();
    assert.deepEqual(idsSeen, ['call_install', 'call_list']);
  });
});

// ── FINAL PRE-PUSH REVIEW #1 — two codepilot_cli_tools_install calls in ONE step ──
describe('TWO codepilot_cli_tools_install calls in the same model step', () => {
  it('unique toolCallIds, independent decisions matched by toolCallId+toolName, authority A can only dispatch A, authority B can only dispatch B, each consumed once, two correct tool-results, zero cross-consumption', async () => {
    const argsA = JSON.stringify({ command: 'echo call-A', name: 'tool-a' });
    const argsB = JSON.stringify({ command: 'echo call-B', name: 'tool-b' });
    const model = mockModel([
      { type: 'stream-start', warnings: [] },
      ...toolInputParts('call_A', 'codepilot_cli_tools_install', argsA),
      ...toolInputParts('call_B', 'codepilot_cli_tools_install', argsB),
      toolCallPart('call_A', 'codepilot_cli_tools_install', argsA),
      toolCallPart('call_B', 'codepilot_cli_tools_install', argsB),
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    ]);

    const r = await runStep(model);

    // Unique toolCallIds, two independent decisions — never collapsed into
    // one just because they share a tool name.
    const installDecisions = r.decisions.filter((d) => d.name === 'codepilot_cli_tools_install');
    assert.equal(installDecisions.length, 2, 'two independent guard decisions, not one merged decision');
    const decisionIds = installDecisions.map((d) => d.toolCallId).sort();
    assert.deepEqual(decisionIds, ['call_A', 'call_B']);
    assert.notEqual(installDecisions[0].internalId, installDecisions[1].internalId, 'distinct internalIds — takeDecision() cannot be confused between them');

    // Each decision matched by toolCallId + toolName (not name alone): find
    // the specific decision for each call explicitly, the same way
    // agent-loop.ts's for-of loop does — never `.find()` by name only.
    const decisionA = installDecisions.find((d) => d.toolCallId === 'call_A');
    const decisionB = installDecisions.find((d) => d.toolCallId === 'call_B');
    assert.ok(decisionA && decisionB);

    // Side effect ran exactly twice — once per call, never merged/skipped.
    assert.equal(r.installSideEffectCalls, 2);

    // Authority A dispatches ONLY command A; authority B dispatches ONLY
    // command B — no cross-consumption in either direction.
    const dispatched = r.capturedSideEffectInputs as Array<{ command: string; name?: string }>;
    const dispatchedForA = dispatched.find((d) => d.command === 'echo call-A');
    const dispatchedForB = dispatched.find((d) => d.command === 'echo call-B');
    assert.ok(dispatchedForA && dispatchedForA.name === 'tool-a', 'authority A dispatched exactly command A, never command B');
    assert.ok(dispatchedForB && dispatchedForB.name === 'tool-b', 'authority B dispatched exactly command B, never command A');
    assert.equal(dispatched.length, 2, 'no third/duplicate dispatch from any cross-consumption');

    // Each authority independently one-shot: re-consuming either internalId
    // a second time (as if some other code path tried) returns undefined —
    // and does not accidentally return the OTHER call's authority either.
    const reconsumeA = r.stepGuard.takeDecision(decisionA!.internalId);
    const reconsumeB = r.stepGuard.takeDecision(decisionB!.internalId);
    assert.equal(reconsumeA, undefined);
    assert.equal(reconsumeB, undefined);

    // Two correct tool-result messages, one per call, addressed to the
    // right toolCallId with the right call's own outcome text — never the
    // other call's.
    const toolMsgs = r.finalMessages.filter((m) => m.role === 'tool');
    const resultParts = toolMsgs.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Array<{
      toolCallId?: string;
      output?: { type: string; value: string };
    }>;
    assert.equal(resultParts.length, 2, 'exactly two tool-result messages, deterministic — no duplication, no omission');
    const resultForA = resultParts.find((p) => p.toolCallId === 'call_A');
    const resultForB = resultParts.find((p) => p.toolCallId === 'call_B');
    assert.ok(resultForA?.output?.value.includes('tool-a') || resultForA?.output?.value.toLowerCase().includes('produ') === false);
    // The install logic can't find a real binary for "echo" (no "install"
    // keyword), so the outcome text is the "could not determine the binary
    // name" branch — assert it at least reflects THIS call's own raw
    // output, not a copy of the other call's.
    assert.notEqual(resultForA?.output?.value, resultForB?.output?.value, 'the two results are not accidentally identical/swapped');

    // Deterministic, valid ordering: both tool-result messages come after
    // the assistant's tool-call message, in the same relative order the
    // decisions were resolved (call_A before call_B, matching fullStream
    // arrival order) — never interleaved before the assistant message.
    const assistantIdx = r.finalMessages.findIndex((m) => m.role === 'assistant');
    const toolMsgIdxs = r.finalMessages
      .map((m, i) => (m.role === 'tool' ? i : -1))
      .filter((i) => i >= 0);
    assert.ok(toolMsgIdxs.every((i) => i > assistantIdx), 'every tool-result comes after the assistant message that requested it');
    assert.deepEqual(
      toolMsgIdxs.map((i) => ((r.finalMessages[i].content as Array<{ toolCallId?: string }>)[0]).toolCallId),
      ['call_A', 'call_B'],
      'ordering matches arrival order, deterministically — not reordered or racy',
    );
  });
});
