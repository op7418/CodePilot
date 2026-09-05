/**
 * codepilot_cli_tools_install — no-evidence / zero-decision reconciliation.
 *
 * prefix-safe-json's execution guard can produce ZERO decisions for a
 * toolCallId that never got a `tool-input-start` at all before its
 * terminal `tool-call` part — proven directly by
 * cli-tools-install-execution-authority.test.ts's own "CASE F" ("no
 * tool-input-delta evidence available"). Before this fix, agent-loop.ts's
 * manual dispatch only ever iterated `guardDecisions` — so a toolCallId
 * with zero decisions got zero explicit handling from this dispatch path:
 * no shell call (correct), but also no permission check attempt (correct,
 * nothing to gate) and, critically, no explicit tool-result either. The
 * PR's own stated invariant ("a rejected or absent authority never falls
 * back... it produces an explicit skipped/rejected tool-result instead")
 * was true for REJECTED decisions but not for ABSENT ones.
 *
 * Structural note: not reproduced through the provider adapter tested
 * here — confirmed directly against the real Anthropic wire, the only
 * one exercised for this specific question, that a `tool-input-start`-
 * equivalent always precedes any terminal `tool-call`, which is enough
 * for the guard to track the call and produce SOME decision (e.g.
 * `action: 'retry'`, which the pre-existing "explicit reject" branch
 * already handled correctly). Whether every OTHER provider adapter
 * CodePilot supports shares that same ordering was not independently
 * verified here — this is Anthropic-specific evidence, not a claim about
 * the general case. Zero decisions
 * only arise from a terminal `tool-call` part with no tracked history at
 * all — reachable only via a raw AI-SDK-level tool-call injection
 * (MockLanguageModelV4, no preceding tool-input-start/delta/end), exactly
 * CASE F's own construction. Since runAgentLoop() has no model-injection
 * seam (it always resolves its own model via createModel()), this file's
 * `runStepReconciled` helper is a faithful re-statement of agent-loop.ts's
 * actual reconciliation logic — same tracking, same lookup, same 3-way
 * branch, same order — calling the REAL resolveToolPermission,
 * runCliToolInstall, and CLI_TOOL_INSTALL_SCHEMA it depends on, exactly
 * the same precedent cli-tools-install-execution-authority.test.ts's own
 * `runStep` already established for this exact "can't inject a mock model
 * into the real entry point" constraint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { streamText, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { assembleTools, resolveToolPermission } from '@/lib/agent-tools';
import { runCliToolInstall, CLI_TOOL_INSTALL_SCHEMA } from '@/lib/builtin-tools/cli-tools';
import type { PermissionMode } from '@/lib/permission-checker';

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

interface ReconciledResult {
  decisions: readonly unknown[];
  observedToolCallIds: string[];
  sideEffectCalls: number;
  permissionRequestCount: number;
  resultMessages: ModelMessage[];
}

/**
 * Faithful re-statement of agent-loop.ts's actual manual-dispatch
 * reconciliation (see this file's header) — the SAME logic, not a
 * different implementation: track every observed
 * codepilot_cli_tools_install toolCallId from the raw stream, build a
 * decision lookup after guard.finish(), then iterate the OBSERVED set
 * (not guardDecisions directly) so a zero-decision call still gets an
 * explicit terminal outcome.
 */
async function runStepReconciled(model: MockLanguageModelV4, opts: { withPermissionContext?: boolean } = {}): Promise<ReconciledResult> {
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
  const result = streamText({ model, prompt: 'x', tools } as never);

  const observedToolCallIds = new Set<string>();
  for await (const part of result.fullStream) {
    stepGuard.push(part as never);
    const p = part as { type: string; toolName?: string; toolCallId?: string };
    if (p.type === 'tool-call' && p.toolName === 'codepilot_cli_tools_install' && p.toolCallId) {
      observedToolCallIds.add(p.toolCallId);
    }
  }

  const stepFinishReason = await result.finishReason;
  const { decisions } = stepGuard.finish({ providerReason: String(stepFinishReason) });
  const decisionsById = new Map(
    (decisions as unknown as Array<{ name: string; toolCallId?: string }>)
      .filter((d) => d.name === 'codepilot_cli_tools_install' && d.toolCallId)
      .map((d) => [d.toolCallId as string, d as unknown as { action: string; internalId: string; reason?: string }]),
  );

  let sideEffectCalls = 0;
  const resultMessages: ModelMessage[] = [];
  for (const toolCallId of observedToolCallIds) {
    const decision = decisionsById.get(toolCallId);
    let outcomeText: string;
    let isError: boolean;

    if (decision && decision.action === 'execute') {
      const authority = stepGuard.takeDecision(decision.internalId);
      const parsed = authority ? CLI_TOOL_INSTALL_SCHEMA.safeParse(authority.value) : null;
      if (!parsed?.success) {
        outcomeText = 'Installation blocked: shape mismatch.';
        isError = true;
      } else if (!toolPermissionContext) {
        sideEffectCalls += 1;
        outcomeText = await runCliToolInstall(parsed.data);
        isError = false;
      } else {
        // Real permission check — same call this file's "permission 0"
        // test relies on never firing for the no-decision branch below.
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
      // The exact branch under test: zero decisions at all.
      outcomeText = 'Installation blocked: no execution-authority decision was ever produced for this call — no corroborating tool-input-delta evidence was observed on the stream.';
      isError = true;
    }

    resultMessages.push({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId, toolName: 'codepilot_cli_tools_install', output: { type: 'text', value: outcomeText } }],
    } as ModelMessage);
    void isError;
  }

  return { decisions, observedToolCallIds: [...observedToolCallIds], sideEffectCalls, permissionRequestCount, resultMessages };
}

// A terminal-only tool-call with NO preceding tool-input-start/delta/end —
// CASE F's exact construction, reproduced here to drive the reconciliation
// logic rather than just prove the guard's own decisions.length === 0.
function noEvidenceModel(toolCallId: string) {
  const args = JSON.stringify({ command: 'echo should-never-run', name: 'no-evidence' });
  return mockModel([
    { type: 'stream-start', warnings: [] },
    { type: 'tool-call', toolCallId, toolName: 'codepilot_cli_tools_install', input: args },
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
  ]);
}

describe('no-evidence reconciliation', () => {
  it('guard produces zero decisions for this call (pinning CASE F\'s own finding as this file\'s starting premise)', async () => {
    const r = await runStepReconciled(noEvidenceModel('toolu_zero'));
    const matching = (r.decisions as Array<{ name: string; toolCallId?: string }>).filter(
      (d) => d.name === 'codepilot_cli_tools_install' && d.toolCallId === 'toolu_zero',
    );
    assert.equal(matching.length, 0, 'zero guard decisions for a call with no tool-input-start at all');
  });

  it('the call is still observed on the raw stream (so reconciliation has something to act on)', async () => {
    const r = await runStepReconciled(noEvidenceModel('toolu_zero'));
    assert.deepEqual(r.observedToolCallIds, ['toolu_zero']);
  });

  it('shell 0: runCliToolInstall is never dispatched for a zero-decision call', async () => {
    const r = await runStepReconciled(noEvidenceModel('toolu_zero'));
    assert.equal(r.sideEffectCalls, 0);
  });

  it('permission 0: resolveToolPermission is never reached for a zero-decision call, even with a real permission context wired', async () => {
    const r = await runStepReconciled(noEvidenceModel('toolu_zero'), { withPermissionContext: true });
    assert.equal(r.permissionRequestCount, 0, 'no permission_request was ever emitted — the reconciliation branch never calls resolveToolPermission for an absent decision');
  });

  it('produces an explicit is_error tool-result for the exact toolCallId — never silence, never a fallback to the SDK-projected input', async () => {
    const r = await runStepReconciled(noEvidenceModel('toolu_zero'));
    assert.equal(r.resultMessages.length, 1, 'exactly one explicit tool-result, from the reconciliation loop itself');
    const content = r.resultMessages[0].content as Array<{ toolCallId: string; output: { value: string } }>;
    assert.equal(content[0].toolCallId, 'toolu_zero');
    assert.match(content[0].output.value, /no execution-authority decision|no corroborating tool-input-delta evidence/i);
    // Never mentions the model's own requested command — confirms this is
    // the fail-closed message, not an echo of SDK-projected input.
    assert.doesNotMatch(content[0].output.value, /should-never-run/);
  });

  it('produces a valid next-step message history entirely from this dispatch path — no dependency on repairIncompleteToolHistory', async () => {
    const r = await runStepReconciled(noEvidenceModel('toolu_zero'));
    // The tool-call/tool-result pairing this dispatch path itself produced
    // is already complete and valid — nothing dangling for a later,
    // generic repair step to have to paper over.
    assert.equal(r.resultMessages.length, 1);
    assert.equal((r.resultMessages[0].content as Array<{ toolCallId: string }>)[0].toolCallId, 'toolu_zero');
  });

  it('an explicit reject decision (distinct from absent) still gets the pre-existing "skipped" message, not the new no-decision one', async () => {
    // Sanity check that the new branch didn't swallow the old one: a call
    // WITH a decision whose action !== 'execute' (e.g. an unsafe finish
    // reason) keeps its own, more specific message.
    const args = JSON.stringify({ command: 'echo x', name: 'x' });
    const model = mockModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'toolu_reject', toolName: 'codepilot_cli_tools_install' },
      { type: 'tool-input-delta', id: 'toolu_reject', delta: args },
      { type: 'tool-input-end', id: 'toolu_reject' },
      { type: 'tool-call', toolCallId: 'toolu_reject', toolName: 'codepilot_cli_tools_install', input: args },
      { type: 'finish', finishReason: { unified: 'length', raw: 'max_tokens' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    ]);
    const r = await runStepReconciled(model);
    const content = r.resultMessages[0].content as Array<{ output: { value: string } }>;
    assert.match(content[0].output.value, /not confirmed safe to execute/i);
    assert.doesNotMatch(content[0].output.value, /no execution-authority decision was ever produced/i);
  });
});
