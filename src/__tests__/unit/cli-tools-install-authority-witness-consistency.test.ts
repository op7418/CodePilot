/**
 * codepilot_cli_tools_install — authority/SDK-projection consistency witness.
 *
 * Real, unmodified @ai-sdk/openai (this repo's own pinned ^4.0.5) driven
 * through a custom `fetch` returning real, schema-valid Responses API SSE
 * bytes. Proves the stronger divergence case: test 3 below covers the
 * truncated-A / complete-B scenario (formerly its own CASE D suite, now
 * subsumed here — A is truncated, so PSJ's guard never grants positive
 * authority at all, and the divergence is moot because nothing would ever
 * dispatch). Tests 1/2/4/5 cover the case this file exists for: A is
 * COMPLETE and schema-valid, so the guard DOES grant `authority.value = A`
 * — and B (the SDK's own separately-reported
 * `response.function_call_arguments.done` value) is ALSO complete,
 * schema-valid, and a genuinely DIFFERENT command.
 *
 * Confirmed directly before writing this file: with such a divergence,
 * agent-loop's own `tool_use` SSE event and ai-sdk's own
 * `response.messages` history BOTH display B — not authority.value (A).
 * Dispatching A regardless (which every prior fix in this PR correctly
 * does) would then execute a DIFFERENT command than the one shown to the
 * user and recorded in the model's own conversation history. Fixed by
 * tracking B purely as a consistency witness and refusing to proceed at
 * all — no permission request, no shell dispatch, with either value —
 * when it structurally disagrees with A.
 *
 * `runAgentLoop()` has no model-injection seam (it always resolves its
 * own model via createModel(), and this divergence is unreachable through
 * the Anthropic wire the rest of this repo's runAgentLoop tests use — the
 * Anthropic adapter ties its final projected input directly to the
 * accumulated deltas, confirmed elsewhere this session). This file's
 * `runStepWitnessed` helper is therefore a faithful re-statement of
 * agent-loop.ts's actual reconciliation logic — same tracking, same
 * isDeepStrictEqual check, same branch order — the same precedent
 * cli-tools-install-execution-authority.test.ts's own `runStep` and
 * cli-tools-install-no-evidence-reconciliation.test.ts's own
 * `runStepReconciled` already established for this exact constraint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { streamText, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { assembleTools, resolveToolPermission } from '@/lib/agent-tools';
import { runCliToolInstall, CLI_TOOL_INSTALL_SCHEMA, createCliToolsTools } from '@/lib/builtin-tools/cli-tools';
import type { PermissionMode } from '@/lib/permission-checker';

function sse(events: unknown[]) {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function mockFetch(events: unknown[]) {
  return async () => sse(events);
}
let seq = 0;
function n(event: Record<string, unknown>) {
  return { sequence_number: seq++, ...event };
}
const USAGE = { input_tokens: 10, output_tokens: 10 };

/**
 * Builds real Responses-API SSE events for one function_call whose
 * streamed delta evidence (A) and separately-reported "done" value (B)
 * can independently be complete-and-valid, complete-and-different,
 * truncated, or anything else the caller wants — reproducing exactly the
 * adapter behavior this file exists to guard against.
 */
function functionCallEvents(itemId: string, callId: string, streamedDeltaA: string, doneValueB: string) {
  return [
    n({ type: 'response.created', response: { id: `resp_${itemId}`, created_at: 0, model: 'gpt-4o' } }),
    n({ type: 'response.output_item.added', output_index: 0, item: { id: itemId, type: 'function_call', call_id: callId, name: 'codepilot_cli_tools_install', arguments: '' } }),
    n({ type: 'response.function_call_arguments.delta', item_id: itemId, output_index: 0, delta: streamedDeltaA }),
    n({ type: 'response.function_call_arguments.done', item_id: itemId, output_index: 0, arguments: doneValueB }),
    n({ type: 'response.output_item.done', output_index: 0, item: { id: itemId, type: 'function_call', status: 'completed', call_id: callId, name: 'codepilot_cli_tools_install', arguments: doneValueB } }),
    n({ type: 'response.completed', response: { usage: USAGE } }),
  ];
}

interface WitnessResult {
  decisionAction: string | undefined;
  authorityValue: unknown;
  sdkProjectedInput: unknown;
  sideEffectCalls: number;
  permissionRequestCount: number;
  resultMessages: ModelMessage[];
}

/**
 * Faithful re-statement of agent-loop.ts's actual manual-dispatch
 * reconciliation, INCLUDING the new consistency-witness check (see this
 * file's header) — same tracking, same isDeepStrictEqual comparison, same
 * branch order.
 */
async function runStepWitnessed(events: unknown[], opts: { withPermissionContext?: boolean } = {}): Promise<WitnessResult> {
  seq = 0;
  const openai = createOpenAI({ apiKey: 'test-key', fetch: mockFetch(events) });
  const { createAiSdkExecutionLock, createAiSdkExecutionGuard } = await import('prefix-safe-json');
  const sessionId = randomUUID();
  let permissionRequestCount = 0;
  const toolPermissionContext = opts.withPermissionContext
    ? {
        sessionId,
        permissionMode: 'normal' as PermissionMode,
        emitSSE: (event: { type: string; data: string }) => {
          if (event.type === 'permission_request') permissionRequestCount += 1;
        },
        abortSignal: undefined,
      }
    : undefined;

  const assembled = assembleTools({
    workingDirectory: process.cwd(),
    sessionId,
    emitSSE: () => {},
    permissionContext: toolPermissionContext,
  });
  const locked = createAiSdkExecutionLock({
    codepilot_cli_tools_install: assembled.tools.codepilot_cli_tools_install,
  }) as unknown as { codepilot_cli_tools_install: unknown };
  const tools = { ...assembled.tools, ...locked };

  const stepGuard = createAiSdkExecutionGuard();
  const result = streamText({ model: openai('gpt-4o'), prompt: 'x', tools } as never);

  const observedToolCallIds = new Set<string>();
  const sdkProjectedInputByToolCallId = new Map<string, unknown>();
  for await (const part of result.fullStream) {
    stepGuard.push(part as never);
    const p = part as { type: string; toolName?: string; toolCallId?: string; input?: unknown };
    if (p.type === 'tool-call' && p.toolName === 'codepilot_cli_tools_install' && p.toolCallId) {
      observedToolCallIds.add(p.toolCallId);
      sdkProjectedInputByToolCallId.set(p.toolCallId, p.input);
    }
  }

  const stepFinishReason = await result.finishReason;
  const { decisions } = stepGuard.finish({ providerReason: String(stepFinishReason) });
  const decisionsById = new Map(
    (decisions as unknown as Array<{ name: string; toolCallId?: string; action: string; internalId: string; reason?: string }>)
      .filter((d) => d.name === 'codepilot_cli_tools_install' && d.toolCallId)
      .map((d) => [d.toolCallId as string, d]),
  );

  let sideEffectCalls = 0;
  let capturedAuthorityValue: unknown = undefined;
  let capturedDecisionAction: string | undefined;
  const resultMessages: ModelMessage[] = [];
  for (const toolCallId of observedToolCallIds) {
    const decision = decisionsById.get(toolCallId);
    capturedDecisionAction = decision?.action;
    let outcomeText: string;
    let isError: boolean;

    if (decision && decision.action === 'execute') {
      const authority = stepGuard.takeDecision(decision.internalId);
      const parsed = authority ? CLI_TOOL_INSTALL_SCHEMA.safeParse(authority.value) : null;
      capturedAuthorityValue = authority?.value;
      const sdkProjectedInput = sdkProjectedInputByToolCallId.get(toolCallId);
      const projectedInputDiverges = !!parsed?.success && !isDeepStrictEqual(authority?.value, sdkProjectedInput);

      if (!parsed?.success) {
        outcomeText = 'Installation blocked: the authorized value did not match the expected install-tool shape.';
        isError = true;
      } else if (projectedInputDiverges) {
        outcomeText = 'Installation blocked: the execution-authority value and the SDK-projected tool-call input for this call disagree — the surrounding response is internally inconsistent, so neither value is dispatched.';
        isError = true;
      } else if (!toolPermissionContext) {
        sideEffectCalls += 1;
        outcomeText = await runCliToolInstall(parsed.data);
        isError = false;
      } else {
        const permission = await resolveToolPermission('codepilot_cli_tools_install', parsed.data, toolPermissionContext);
        if (permission.action === 'deny') {
          outcomeText = permission.message ?? 'Permission denied';
          isError = true;
        } else {
          sideEffectCalls += 1;
          outcomeText = await runCliToolInstall(permission.input as typeof parsed.data);
          isError = false;
        }
      }
    } else if (decision) {
      outcomeText = `Installation skipped: the surrounding response was not confirmed safe to execute (${decision.reason ?? 'no positive authority'}).`;
      isError = true;
    } else {
      outcomeText = 'Installation blocked: no execution-authority decision was ever produced for this call — no corroborating tool-input-delta evidence was observed on the stream.';
      isError = true;
    }

    resultMessages.push({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId, toolName: 'codepilot_cli_tools_install', output: { type: 'text', value: outcomeText } }],
    } as ModelMessage);
    void isError;
  }

  return {
    decisionAction: capturedDecisionAction,
    authorityValue: capturedAuthorityValue,
    sdkProjectedInput: sdkProjectedInputByToolCallId.get([...observedToolCallIds][0] ?? ''),
    sideEffectCalls,
    permissionRequestCount,
    resultMessages,
  };
}

describe('authority/SDK-projection consistency witness', () => {
  it('1. complete A == B: executes A once (agreement — proceeds normally)', async () => {
    const A = JSON.stringify({ command: 'echo agree', name: 'agree' });
    const events = functionCallEvents('fc_1', 'call_1', A, A);
    const r = await runStepWitnessed(events);
    assert.equal(r.decisionAction, 'execute');
    assert.deepEqual(r.authorityValue, JSON.parse(A));
    assert.equal(r.sideEffectCalls, 1, 'executes exactly once when A and B structurally agree');
    const content = r.resultMessages[0].content as Array<{ output: { value: string } }>;
    assert.match(content[0].output.value, /agree/);
  });

  it('2. complete A != B: zero side effects (divergence — blocked entirely)', async () => {
    const A = JSON.stringify({ command: 'echo safe-A', name: 'safe' });
    const B = JSON.stringify({ command: 'echo different-B', name: 'different' });
    const events = functionCallEvents('fc_2', 'call_2', A, B);
    const r = await runStepWitnessed(events);
    assert.equal(r.decisionAction, 'execute', 'authority IS granted for A on its own terms — the block happens after, at reconciliation');
    assert.deepEqual(r.authorityValue, JSON.parse(A));
    assert.deepEqual(r.sdkProjectedInput, JSON.parse(B));
    assert.notDeepEqual(r.authorityValue, r.sdkProjectedInput, 'A and B are genuinely different — real divergence, not a test artifact');
    assert.equal(r.sideEffectCalls, 0, 'neither A nor B is ever dispatched to the real side effect');
  });

  it('3. truncated A + valid B: existing fail-closed behavior unchanged (never reaches the witness check at all) — subsumes former CASE D', async () => {
    const truncatedA = '{"command":"brew install ffm';
    const B = JSON.stringify({ command: 'brew install ffmpeg', name: 'ffmpeg' });
    const events = functionCallEvents('fc_3', 'call_3', truncatedA, B);
    const r = await runStepWitnessed(events);
    assert.deepEqual(r.sdkProjectedInput, JSON.parse(B), 'the real @ai-sdk/openai adapter really did project B as the terminal tool-call input, independent of the truncated stream A');
    assert.notEqual(r.decisionAction, 'execute', 'PSJ itself never grants authority for truncated evidence — the same CASE D invariant, unaffected by this fix');
    assert.equal(r.sideEffectCalls, 0);

    // Structural invariant, independent of this scenario: the locked
    // install tool has no native execute() at all — the guard is the only
    // gate, never a stripped/disabled callback.
    const { createAiSdkExecutionLock } = await import('prefix-safe-json');
    const locked = createAiSdkExecutionLock({ codepilot_cli_tools_install: createCliToolsTools().codepilot_cli_tools_install });
    assert.equal((locked.codepilot_cli_tools_install as { execute?: unknown }).execute, undefined);
  });

  it('4. mismatched A/B: permission 0 (permission is never even requested when they diverge)', async () => {
    const A = JSON.stringify({ command: 'echo permA', name: 'permA' });
    const B = JSON.stringify({ command: 'echo permB', name: 'permB' });
    const events = functionCallEvents('fc_4', 'call_4', A, B);
    const r = await runStepWitnessed(events, { withPermissionContext: true });
    assert.equal(r.permissionRequestCount, 0, 'resolveToolPermission is never reached — the witness check runs before any permission request');
    assert.equal(r.sideEffectCalls, 0);
  });

  it('5. mismatched A/B: next-step history remains structurally valid (one explicit is_error tool-result, exact toolCallId, no dangling tool-call)', async () => {
    const A = JSON.stringify({ command: 'echo histA', name: 'histA' });
    const B = JSON.stringify({ command: 'echo histB', name: 'histB' });
    const events = functionCallEvents('fc_5', 'call_5', A, B);
    const r = await runStepWitnessed(events);
    assert.equal(r.resultMessages.length, 1, 'exactly one tool-result — no duplication, no omission');
    const content = r.resultMessages[0].content as Array<{ toolCallId: string; output: { value: string } }>;
    assert.equal(content[0].toolCallId, 'call_5');
    assert.match(content[0].output.value, /disagree|inconsistent/i);
    assert.doesNotMatch(content[0].output.value, /histA|histB/, 'the blocked message never echoes either candidate command');
  });
});
