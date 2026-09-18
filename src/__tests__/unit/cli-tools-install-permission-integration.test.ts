/**
 * codepilot_cli_tools_install — permission-system integration.
 *
 * Uses assembleTools({ permissionContext }) directly — the same entry
 * point agent-loop.ts actually calls — never createCliToolsTools() as a
 * substitute, so this exercises wrapWithPermissions' real
 * MANUAL_AUTHORITY_TOOLS branch. Proves the permission system (ask,
 * allow, deny, updatedInput, session approval, full_access) is never
 * bypassed by the manual-authority dispatch path that runs after
 * prefix-safe-json grants execution authority.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { streamText, type ModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { assembleTools, resolveToolPermission } from '@/lib/agent-tools';
import { runCliToolInstall, CLI_TOOL_INSTALL_SCHEMA } from '@/lib/builtin-tools/cli-tools';
import { resolvePendingPermission } from '@/lib/permission-registry';
import type { PermissionMode } from '@/lib/permission-checker';

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

interface SimResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
}

interface RunOpts {
  bypassPermissions?: boolean;
  permissionMode?: PermissionMode;
  /** Simulated user response to the FIRST permission_request this run sees, keyed by toolCallId order (index). */
  responses?: SimResponse[];
}

/**
 * Faithful re-statement of exactly the logic added to agent-loop.ts for
 * this fix: assembleTools() (real production entry point, real
 * wrapWithPermissions) -> lock ONLY codepilot_cli_tools_install -> drive
 * streamText -> guard -> per decision: takeDecision() -> schema-validate
 * -> (bypass ? direct dispatch : resolveToolPermission()) -> on grant,
 * re-validate the (possibly user-edited) input -> runCliToolInstall().
 */
async function runStepWithPermissions(model: MockLanguageModelV4, opts: RunOpts = {}) {
  const { createAiSdkExecutionLock, createAiSdkExecutionGuard } = await import('prefix-safe-json');
  const sessionId = randomUUID();
  const sseEvents: Array<{ type: string; data: string }> = [];
  let permissionRequestCount = 0;

  const emitSSE = (event: { type: string; data: string }) => {
    sseEvents.push(event);
    if (event.type === 'permission_request') {
      const parsed = JSON.parse(event.data) as { permissionRequestId: string };
      const response = opts.responses?.[permissionRequestCount];
      permissionRequestCount += 1;
      if (response) {
        // Deferred to a microtask: registerPendingPermission's map entry
        // is only guaranteed to exist once the synchronous call that
        // constructs the Promise has returned to its caller — this event
        // fires BEFORE that call even happens. Mirrors how the real HTTP
        // approval route resolves it asynchronously, not synchronously
        // inside the SSE emission itself.
        queueMicrotask(() => {
          resolvePendingPermission(parsed.permissionRequestId, {
            behavior: response.behavior,
            updatedInput: response.updatedInput,
          });
        });
      }
    }
  };

  const toolPermissionContext = opts.bypassPermissions
    ? undefined
    : {
        sessionId,
        permissionMode: opts.permissionMode ?? ('normal' as PermissionMode),
        emitSSE,
        abortSignal: undefined,
      };

  const assembled = assembleTools({
    workingDirectory: process.cwd(),
    sessionId,
    emitSSE,
    bypassPermissions: opts.bypassPermissions,
    permissionContext: toolPermissionContext,
  });

  assert.ok(assembled.tools.codepilot_cli_tools_install, 'the real production assembly path must mount this tool');

  const lockedInstallTool = createAiSdkExecutionLock({
    codepilot_cli_tools_install: assembled.tools.codepilot_cli_tools_install,
  }) as unknown as { codepilot_cli_tools_install: unknown };
  const tools = { ...assembled.tools, ...lockedInstallTool };

  // Structural proof this is genuinely the real, permission-classified
  // tool and not a bare substitute: it went through wrapWithPermissions'
  // MANUAL_AUTHORITY_TOOLS branch, and still carries no execute after the
  // lock — both must hold simultaneously.
  assert.equal((tools.codepilot_cli_tools_install as { execute?: unknown }).execute, undefined);

  const stepGuard = createAiSdkExecutionGuard();
  const result = streamText({ model, prompt: 'x', tools } as never);
  for await (const part of result.fullStream) stepGuard.push(part as never);

  const stepFinishReason = await result.finishReason;
  const { decisions } = stepGuard.finish({ providerReason: String(stepFinishReason) });

  const sideEffectCalls: Array<{ command: string; name?: string }> = [];
  const resultMessages: ModelMessage[] = [];

  for (const decision of decisions) {
    if (decision.name !== 'codepilot_cli_tools_install' || !decision.toolCallId) continue;
    const toolCallId = decision.toolCallId;
    let outcomeText: string;

    if (decision.action === 'execute') {
      const authority = stepGuard.takeDecision(decision.internalId);
      if (!authority) {
        outcomeText = 'Installation blocked: execution authority could not be acquired.';
      } else {
        const parsedInput = CLI_TOOL_INSTALL_SCHEMA.safeParse(authority.value);
        if (!parsedInput.success) {
          outcomeText = 'Installation blocked: shape mismatch.';
        } else if (!toolPermissionContext) {
          sideEffectCalls.push(parsedInput.data);
          outcomeText = await runCliToolInstall(parsedInput.data);
        } else {
          const permission = await resolveToolPermission('codepilot_cli_tools_install', parsedInput.data, toolPermissionContext);
          if (permission.action === 'deny') {
            outcomeText = permission.message ?? 'Permission denied';
          } else {
            const revalidated = CLI_TOOL_INSTALL_SCHEMA.safeParse(permission.input);
            if (!revalidated.success) {
              outcomeText = 'Installation blocked: the user-approved input did not match the expected install-tool shape.';
            } else {
              sideEffectCalls.push(revalidated.data);
              outcomeText = await runCliToolInstall(revalidated.data);
            }
          }
        }
      }
    } else {
      outcomeText = `Installation skipped: the surrounding response was not confirmed safe to execute (${decision.reason ?? 'no positive authority'}).`;
    }

    resultMessages.push({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId, toolName: 'codepilot_cli_tools_install', output: { type: 'text', value: outcomeText } }],
    } as ModelMessage);
  }

  return { decisions, sideEffectCalls, resultMessages, sseEvents, permissionRequestCount };
}

const SAFE_ARGS = JSON.stringify({ command: 'echo permcheck', name: 'permcheck' });
function safeInstallStream(toolCallId = 'call_perm') {
  return mockModel([
    { type: 'stream-start', warnings: [] },
    ...toolInputParts(toolCallId, 'codepilot_cli_tools_install', SAFE_ARGS),
    toolCallPart(toolCallId, 'codepilot_cli_tools_install', SAFE_ARGS),
    { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
  ]);
}

// ── PERM-A ────────────────────────────────────────────────────────────
describe('PERM-A — normal mode, ask, user ALLOW', () => {
  it('PSJ authority yes, permission requested, shell executes exactly once', async () => {
    const r = await runStepWithPermissions(safeInstallStream(), {
      permissionMode: 'normal',
      responses: [{ behavior: 'allow' }],
    });
    assert.equal(r.decisions.find((d) => d.name === 'codepilot_cli_tools_install')?.action, 'execute', 'PSJ authority granted');
    assert.equal(r.permissionRequestCount, 1, 'permission was actually requested');
    assert.equal(r.sideEffectCalls.length, 1, 'shell executes exactly once');
    assert.deepEqual(r.sideEffectCalls[0], { command: 'echo permcheck', name: 'permcheck' });
  });
});

// ── PERM-B ────────────────────────────────────────────────────────────
describe('PERM-B — normal mode, user DENY', () => {
  it('PSJ authority yes, shell executes zero times', async () => {
    const r = await runStepWithPermissions(safeInstallStream(), {
      permissionMode: 'normal',
      responses: [{ behavior: 'deny' }],
    });
    assert.equal(r.decisions.find((d) => d.name === 'codepilot_cli_tools_install')?.action, 'execute', 'PSJ authority was granted — the denial is the human, not PSJ');
    assert.equal(r.permissionRequestCount, 1);
    assert.equal(r.sideEffectCalls.length, 0, 'shell never executes');
    const resultText = (r.resultMessages[0]?.content as Array<{ output: { value: string } }>)[0]?.output.value;
    assert.match(resultText ?? '', /denied/i);
  });
});

// ── PERM-C ────────────────────────────────────────────────────────────
describe('PERM-C — PSJ rejects, user would have allowed', () => {
  it('permission is never even reached; zero side effects', async () => {
    const truncated = '{"command":"brew install ffm';
    const model = mockModel([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call_c', toolName: 'codepilot_cli_tools_install' },
      { type: 'tool-input-delta', id: 'call_c', delta: truncated },
      { type: 'tool-input-end', id: 'call_c' },
      toolCallPart('call_c', 'codepilot_cli_tools_install', truncated + '"}'),
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
    ]);
    // Would-allow response registered, but must never be consumed since
    // resolveToolPermission should never even be called for a rejected PSJ decision.
    const r = await runStepWithPermissions(model, { permissionMode: 'normal', responses: [{ behavior: 'allow' }] });
    assert.notEqual(r.decisions.find((d) => d.name === 'codepilot_cli_tools_install')?.action, 'execute', 'PSJ itself rejects truncated evidence');
    assert.equal(r.permissionRequestCount, 0, 'permission system never even asked — PSJ authority is the earlier gate');
    assert.equal(r.sideEffectCalls.length, 0);
  });
});

// ── PERM-D ────────────────────────────────────────────────────────────
describe('PERM-D — user edits the command during approval', () => {
  it('original authority.value.command is NOT executed; the explicitly-approved edited command is revalidated and executed once', async () => {
    const r = await runStepWithPermissions(safeInstallStream(), {
      permissionMode: 'normal',
      responses: [{ behavior: 'allow', updatedInput: { command: 'echo user-edited-command', name: 'permcheck' } }],
    });
    assert.equal(r.sideEffectCalls.length, 1);
    assert.notDeepEqual(r.sideEffectCalls[0], { command: 'echo permcheck', name: 'permcheck' }, 'original authority.value is not what ran');
    assert.deepEqual(r.sideEffectCalls[0], { command: 'echo user-edited-command', name: 'permcheck' }, 'the explicitly user-approved edit is what ran, revalidated');
  });

  it('an updatedInput that fails schema revalidation is blocked, not executed', async () => {
    const r = await runStepWithPermissions(safeInstallStream(), {
      permissionMode: 'normal',
      // missing required "command" — must never reach the shell even though the user "approved"
      responses: [{ behavior: 'allow', updatedInput: { name: 'no-command-field' } as unknown as Record<string, unknown> }],
    });
    assert.equal(r.sideEffectCalls.length, 0, 'malformed user-edited input is never dispatched, even after approval');
    const resultText = (r.resultMessages[0]?.content as Array<{ output: { value: string } }>)[0]?.output.value;
    assert.match(resultText ?? '', /shape/i);
  });
});

// ── PERM-E ────────────────────────────────────────────────────────────
describe('PERM-E — full_access / bypassPermissions', () => {
  it('no permission prompt; valid PSJ authority executes once', async () => {
    const r = await runStepWithPermissions(safeInstallStream(), { bypassPermissions: true });
    assert.equal(r.permissionRequestCount, 0, 'no permission prompt in bypass mode');
    assert.equal(r.sideEffectCalls.length, 1, 'executes once, directly, from authority.value');
    assert.deepEqual(r.sideEffectCalls[0], { command: 'echo permcheck', name: 'permcheck' });
  });
});

// ── PERM-F ────────────────────────────────────────────────────────────
describe('PERM-F — no PSJ authority, any permission mode', () => {
  for (const bypassPermissions of [false, true]) {
    it(`bypassPermissions=${bypassPermissions}: never executes`, async () => {
      const truncated = '{"command":"brew install ffm';
      const model = mockModel([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: 'call_f', toolName: 'codepilot_cli_tools_install' },
        { type: 'tool-input-delta', id: 'call_f', delta: truncated },
        { type: 'tool-input-end', id: 'call_f' },
        toolCallPart('call_f', 'codepilot_cli_tools_install', truncated + '"}'),
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } },
      ]);
      const r = await runStepWithPermissions(model, { bypassPermissions, responses: [{ behavior: 'allow' }] });
      assert.equal(r.sideEffectCalls.length, 0);
    });
  }
});

// ── PERM-G ────────────────────────────────────────────────────────────
describe('PERM-G — two same-step installs, full permission integration', () => {
  it('independent PSJ authorities, independent permission decisions, no cross-consumption', async () => {
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
    // call_A (arrives first) gets denied; call_B gets allowed — proves the
    // two permission decisions are independent, not a single shared one.
    const r = await runStepWithPermissions(model, {
      permissionMode: 'normal',
      responses: [{ behavior: 'deny' }, { behavior: 'allow' }],
    });

    assert.equal(r.permissionRequestCount, 2, 'two independent permission requests, one per call');
    assert.equal(r.sideEffectCalls.length, 1, 'only the allowed call actually ran');
    assert.deepEqual(r.sideEffectCalls[0], { command: 'echo call-B', name: 'tool-b' }, 'the allowed call is B, never A');

    assert.equal(r.resultMessages.length, 2);
    const forA = r.resultMessages.find((m) => (m.content as Array<{ toolCallId: string }>)[0].toolCallId === 'call_A');
    const forB = r.resultMessages.find((m) => (m.content as Array<{ toolCallId: string }>)[0].toolCallId === 'call_B');
    const textA = (forA?.content as Array<{ output: { value: string } }>)[0]?.output.value ?? '';
    const textB = (forB?.content as Array<{ output: { value: string } }>)[0]?.output.value ?? '';
    assert.match(textA, /denied/i, 'A was denied');
    assert.doesNotMatch(textB, /denied/i, 'B was not denied — no cross-consumption of the decision');
  });
});
