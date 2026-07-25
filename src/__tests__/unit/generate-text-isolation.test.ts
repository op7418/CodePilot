/**
 * `generateTextViaSdk` isolation contract, asserted on the WIRE object (g04/g08/g09).
 *
 * The previous version of title generation passed `allowedTools: []` and
 * believed that meant "no tools". It does not: `allowedTools` is a permission
 * ALLOWLIST (which tools skip the approval prompt), while `tools` is the
 * availability filter. A subprocess with `allowedTools: []` still has Bash,
 * Read, Edit and the rest in its context. Likewise `mcpServers: {}` does not
 * stop `settingSources: ['user']` from loading the user's MCP servers, plugins,
 * skills, hooks and CLAUDE.md.
 *
 * So these cases assert the built `Options` object itself rather than the call
 * site's intent — a comment saying "no tools" is not evidence, the wire is.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGenerateTextQueryOptions,
  buildGenerateTextSdkEnv,
} from '../../lib/claude-client';
import type { ResolvedProvider } from '../../lib/provider-resolver';

/** A DB-backed provider resolution — settingSources ['user'], as production. */
const resolved = {
  provider: { id: 'provider-a', name: 'Vendor A' },
  protocol: 'anthropic',
  authStyle: 'api_key',
  model: 'claude-haiku-4-5',
  upstreamModel: 'claude-haiku-4-5',
  modelDisplayName: 'Haiku',
  headers: {},
  envOverrides: {},
  roleModels: {},
  hasCredentials: true,
  availableModels: [],
  settingSources: ['user'],
} as unknown as ResolvedProvider;

const base = { callScene: 'automatic_title' as const, system: 'You write titles.', prompt: 'Hello' };

function build(params: Parameters<typeof buildGenerateTextQueryOptions>[0]) {
  return buildGenerateTextQueryOptions(params, resolved, {}, new AbortController());
}

describe('generateTextViaSdk isolation — isolate: true', () => {
  const opts = build({ ...base, isolate: true });

  it('disables built-in tools with `tools: []`, not just `allowedTools`', () => {
    // `tools: []` is the ONLY option that removes built-in tools from the
    // subprocess. Its absence is exactly the bug this test exists for.
    assert.deepEqual(opts.tools, [], 'tools must be an empty array, not undefined');
    assert.deepEqual(opts.allowedTools, [], 'allowedTools stays empty too, belt and braces');
  });

  it('loads no setting sources — no user MCP, plugins, skills, hooks or CLAUDE.md', () => {
    // The resolver handed us ['user']; the isolated call must drop it. That one
    // layer is what pulls in the user's whole Claude Code environment.
    assert.deepEqual(resolved.settingSources, ['user'], 'precondition: resolver supplies user layer');
    assert.deepEqual(opts.settingSources, [], 'isolated call must load none of it');
  });

  it('attaches no MCP servers', () => {
    assert.deepEqual(opts.mcpServers, {});
  });

  it('makes no permission claim it does not need', () => {
    // With zero tools there is nothing to permit, so bypassPermissions would be
    // an untrue statement about this subprocess rather than a convenience.
    assert.equal(opts.permissionMode, undefined);
    assert.equal(opts.allowDangerouslySkipPermissions, undefined);
  });

  it('replaces the Claude Code preset system prompt with a plain string', () => {
    // A STRING systemPrompt replaces the preset; an object with
    // `{ type: 'preset' }` would append to it and carry memory along.
    assert.equal(typeof opts.systemPrompt, 'string');
    assert.equal(opts.systemPrompt, base.system);
  });

  it('is one turn', () => {
    assert.equal(opts.maxTurns, 1);
  });
});

describe('generateTextViaSdk isolation — legacy callers are untouched', () => {
  // dashboard/refresh, cli-tools/describe and context-compressor all want the
  // normal Claude Code surface. Isolation is strictly opt-in.
  const opts = build({ ...base });

  it('keeps the resolver settingSources and the previous permission posture', () => {
    assert.deepEqual(opts.settingSources, ['user']);
    assert.equal(opts.permissionMode, 'bypassPermissions');
    assert.equal(opts.allowDangerouslySkipPermissions, true);
  });

  it('does not restrict tools or MCP', () => {
    assert.equal(opts.tools, undefined);
    assert.equal(opts.allowedTools, undefined);
    assert.equal(opts.mcpServers, undefined);
  });
});

describe('generateTextViaSdk isolation — reasoning policy reaches the subprocess env', () => {
  it('keeps the original low-cost default for providers that can disable thinking', () => {
    const env = buildGenerateTextSdkEnv(
      { ...base, isolate: true, maxOutputTokens: 16 },
      { EXISTING: 'kept' },
    );
    assert.equal(env.EXISTING, 'kept');
    assert.equal(env.MAX_THINKING_TOKENS, '0');
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '16');
  });

  it('does not force thinking off for an always-thinking provider', () => {
    const env = buildGenerateTextSdkEnv(
      {
        ...base,
        isolate: true,
        reasoningPolicy: 'provider-managed',
        maxOutputTokens: 2048,
      },
      { EXISTING: 'kept', MAX_THINKING_TOKENS: '0' },
    );
    assert.equal(env.EXISTING, 'kept');
    assert.equal(
      env.MAX_THINKING_TOKENS,
      undefined,
      'provider-managed thinking must remove inherited thinking:disabled overrides',
    );
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '2048');
  });

  it('does not change reasoning for non-isolated legacy callers', () => {
    const env = buildGenerateTextSdkEnv({ ...base }, { EXISTING: 'kept' });
    assert.deepEqual(env, { EXISTING: 'kept' });
  });
});

describe('title generation uses the isolated path', () => {
  it('the Claude Code branch passes isolation and the resolved provider profile', async () => {
    // Structural pin at the seam that the wire assertions above protect: if a
    // future edit drops `isolate`, the options built for a title call silently
    // become the legacy full-surface ones and every assertion above still passes.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../lib/title-generation.ts'),
      'utf-8',
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(code, /isolate: true/);
    assert.match(code, /reasoningPolicy: callProfile\.reasoningPolicy/);
    assert.match(code, /maxOutputTokens: callProfile\.maxOutputTokens/);
    assert.match(code, /timeoutMs: callProfile\.timeoutMs/);
    assert.match(
      code,
      /setTimeout\(\(\) => controller\.abort\(\), callProfile\.timeoutMs\)/,
      'the orchestrator timeout must use the same provider profile as the SDK call',
    );
    // The old, ineffective isolation must not come back.
    assert.ok(!/disableMcp|disableThinking/.test(code), 'superseded flags must be gone');
  });
});
