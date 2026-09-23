/**
 * Phase 5c (2026-05-16) — Codex Account never sees the bridge.
 *
 * Codex Account routes through Codex's own auth path (chat.openai
 * backend) WITHOUT the codepilot_proxy injection. The proxy's
 * `adapter.ts` virtual-provider check fires earlier with a routing-
 * bug error if the request ever reaches the proxy, but the bridge
 * itself ALSO refuses to mount for codex_account as defence in
 * depth — if a future change accidentally removes the upstream
 * guard, the bridge wouldn't suddenly hijack Codex Account's
 * native tool surface (Skills / image_gen / etc.).
 *
 * This file pins both layers:
 *   1. createCodePilotBuiltinTools refuses codex_account.
 *   2. buildCodexThreadParams for codex_account produces NO proxy
 *      injection (verified via header / config absence) — confirmed
 *      separately in codex-proxy-headers.test.ts but mirrored here
 *      because the bridge guardrail and the routing guardrail are
 *      conceptually paired.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCodePilotBuiltinTools,
  createCodexAccountManagedTools,
} from '@/lib/codex/proxy/builtin-bridge';
import { buildCodexThreadParams } from '@/lib/codex/provider-proxy';
import fs from 'node:fs';
import path from 'node:path';

describe('Codex Account guardrails — bridge layer', () => {
  it('createCodePilotBuiltinTools returns empty bridge for codex_account', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'codex_account',
      workspacePath: '/Users/me/proj',
    });
    assert.equal(Object.keys(bridge.tools).length, 0, 'no tools must mount for Codex Account — its native paths own these capabilities');
    assert.equal(bridge.toolNames.size, 0);
    assert.equal(bridge.systemPrompt, '');
    assert.match(bridge.skippedReason ?? '', /Codex Account/);
  });

  it('Codex Account dynamic surface adds only exact-route managed delegation', () => {
    const bridge = createCodexAccountManagedTools({
      sessionId: 'chat-1',
      targetProviderId: 'codex_account',
      workspacePath: '/Users/me/proj',
    });
    assert.deepEqual(
      [...bridge.toolNames].sort(),
      ['codepilot_list_subagent_runs', 'codepilot_spawn_subagent'],
    );
    assert.equal(bridge.dynamicTools.length, 2);
    assert.ok(
      bridge.dynamicTools.every((spec) => spec.type === 'function'),
      'managed tools must use app-server dynamic function calls without proxy injection',
    );
  });

  it('non-codex_account provider gets the full bridge surface (control)', () => {
    const bridge = createCodePilotBuiltinTools({
      sessionId: 'chat-1',
      targetProviderId: 'prov-glm',
      workspacePath: '/Users/me/proj',
    });
    assert.ok(Object.keys(bridge.tools).length > 0, 'control: non-codex_account must mount tools');
    assert.equal(bridge.skippedReason, undefined);
  });
});

describe('Codex Account guardrails — thread params layer (mirror of codex-proxy-headers.test.ts)', () => {
  it('buildCodexThreadParams emits NO modelProvider/config for codex_account', () => {
    const params = buildCodexThreadParams({
      providerId: 'codex_account',
      workingDirectory: '/Users/me/proj',
      proxyBaseUrl: 'http://127.0.0.1:3000',
      model: 'gpt-5.5',
      sessionId: 'chat-1',
    });
    // codex_account path returns cwd + model only — the proxy
    // injection (modelProvider + config + headers) is absent so
    // Codex's native model_providers["openai"] entry wins.
    assert.equal(params.modelProvider, undefined);
    assert.equal(params.config, undefined);
    assert.equal(params.cwd, '/Users/me/proj');
    assert.equal(params.model, 'gpt-5.5');
  });

  it('runtime mounts managed dynamic tools only on thread/start and revisions stale refs', () => {
    const runtimeSource = fs.readFileSync(
      path.resolve(__dirname, '../../lib/codex/runtime.ts'),
      'utf8',
    );
    assert.match(runtimeSource, /createCodexAccountManagedTools/);
    assert.match(
      runtimeSource,
      /dynamicTools:\s*codexAccountManagedBridge\.dynamicTools/,
      'Codex Account start params must contain the exact managed tool declarations',
    );
    assert.match(
      runtimeSource,
      /codex-account-managed-subagents-v1/,
      'old Codex Account thread refs must be invalidated once because dynamic tools are start-only',
    );
    assert.match(
      runtimeSource,
      /'thread\/resume',[\s\S]*threadId,[\s\S]*\.\.\.threadParams/,
      'resume must omit the start-only dynamicTools field',
    );
    assert.match(
      runtimeSource,
      /Never use native spawn_agent\/multi_agent_v1 as a substitute/,
      'named Provider/Model delegation must not silently fall back to a native inherited worker',
    );

    const managerSource = fs.readFileSync(
      path.resolve(__dirname, '../../lib/codex/app-server-manager.ts'),
      'utf8',
    );
    assert.match(
      managerSource,
      /capabilities:\s*\{[\s\S]*experimentalApi:\s*true[\s\S]*requestAttestation:\s*false/,
      'app-server initialize must opt into dynamicTools while declining unsupported attestation requests',
    );
  });
});
