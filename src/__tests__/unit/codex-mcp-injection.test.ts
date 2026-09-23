/**
 * Phase 8 Phase 2 — Codex thread start/resume MCP injection.
 *
 * Run: npx tsx --test src/__tests__/unit/codex-mcp-injection.test.ts
 *
 * Two layers:
 *  - buildCodexThreadParams merges `config.mcp_servers` on BOTH provider
 *    branches without clobbering the proxy `model_providers`.
 *  - Source pins on runtime.ts: resume carries the full thread params
 *    (not just { threadId }), the resume decision is gated on the MCP
 *    fingerprint, and the Memory MCP is the injected server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildCodexThreadParams } from '../../lib/codex/provider-proxy';
import type { CodexMcpServersConfig } from '../../lib/codex/mcp-config';

const MCP: CodexMcpServersConfig = {
  codepilot_memory: { url: 'http://127.0.0.1:3000/api/codex/mcp/memory', http_headers: { 'x-codepilot-workspace-path': '/ws' } },
};

describe('buildCodexThreadParams — MCP merge', () => {
  it('codex_account branch carries mcp_servers only (no model_providers / modelProvider)', () => {
    const params = buildCodexThreadParams({
      providerId: 'codex_account',
      workingDirectory: '/ws',
      proxyBaseUrl: 'http://127.0.0.1:3000',
      model: 'gpt-5.5',
      mcpServers: MCP,
    });
    assert.equal(params.modelProvider, undefined);
    assert.deepEqual(params.config?.mcp_servers, MCP);
    assert.equal(params.config?.model_providers, undefined);
  });

  it('proxy branch carries BOTH model_providers and mcp_servers (neither clobbers the other)', () => {
    const params = buildCodexThreadParams({
      providerId: 'prov-glm',
      workingDirectory: '/ws',
      proxyBaseUrl: 'http://127.0.0.1:3000',
      model: 'glm',
      sessionId: 'sess',
      mcpServers: MCP,
    });
    assert.equal(params.modelProvider, 'codepilot_proxy');
    assert.ok(params.config?.model_providers?.codepilot_proxy, 'proxy injection preserved');
    assert.deepEqual(params.config?.mcp_servers, MCP);
  });

  it('codex_account without mcpServers stays config-less (back-compat)', () => {
    const params = buildCodexThreadParams({
      providerId: 'codex_account',
      workingDirectory: '/ws',
      proxyBaseUrl: 'http://127.0.0.1:3000',
      model: 'gpt-5.5',
    });
    assert.equal(params.config, undefined);
  });

  it('proxy without mcpServers carries only model_providers (back-compat)', () => {
    const params = buildCodexThreadParams({
      providerId: 'prov-glm',
      workingDirectory: '/ws',
      proxyBaseUrl: 'http://127.0.0.1:3000',
      model: 'glm',
    });
    assert.ok(params.config?.model_providers?.codepilot_proxy);
    assert.equal(params.config?.mcp_servers, undefined);
  });

  it('empty mcpServers map is treated as no injection', () => {
    const params = buildCodexThreadParams({
      providerId: 'codex_account',
      workingDirectory: '/ws',
      proxyBaseUrl: 'http://127.0.0.1:3000',
      mcpServers: {},
    });
    assert.equal(params.config, undefined);
  });
});

describe('runtime.ts — start/resume injection wiring (source pins)', () => {
  const runtimeSrc = fs.readFileSync(
    path.resolve(__dirname, '../../lib/codex/runtime.ts'),
    'utf-8',
  );

  it('resume re-attaches the full thread params, not just { threadId }', () => {
    // Must spread ...threadParams into thread/resume so the MCP config
    // (and proxy injection) travels on every continuation turn.
    assert.match(
      runtimeSrc,
      /thread\/resume['"]\s*,\s*\{\s*threadId,[^}]*\.\.\.threadParams/,
      'thread/resume must spread ...threadParams (carry MCP config on resume)',
    );
  });

  it('the resume decision is gated on the MCP config fingerprint', () => {
    const continuation = fs.readFileSync(path.resolve(__dirname, '../../lib/codex/thread-continuation.ts'), 'utf-8');
    assert.match(runtimeSrc, /prepareCodexThread\(\{[\s\S]{0,150}mcpFingerprint,/);
    assert.match(continuation, /ref\.metadata\?\.mcpConfigFingerprint \?\? ''\) === input\.mcpFingerprint/);
    assert.ok(
      runtimeSrc.includes('fingerprintCodexMcpConfig'),
      'runtime must compute the MCP fingerprint',
    );
  });

  it('the injected server is the Memory MCP, gated on assistant workspace', () => {
    assert.ok(runtimeSrc.includes('buildCodexMemoryMcpConfig'));
    assert.ok(runtimeSrc.includes("getSetting('assistant_workspace_path')"));
    // threadParams call forwards the resolved servers
    assert.match(runtimeSrc, /mcpServers:\s*hasMcp\s*\?\s*codexMcpServers\s*:\s*undefined/);
  });
});
