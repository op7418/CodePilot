/**
 * Phase 5c slice 7 (2026-05-16) — Harness Capability Contract tests.
 *
 * Goal: catch the kind of drift that produced the slice-6 widget
 * regression — three independent `WIDGET_SYSTEM_PROMPT` copies, each
 * paraphrasing the same rules differently, so ClaudeCode SDK / Native
 * Runtime / Codex Runtime users got different format expectations.
 *
 * The contract module `src/lib/harness/capability-contract.ts` names
 * the canonical prompt fragment per capability and points at the
 * factory function in each runtime that exposes it. These tests check:
 *
 *   1. Catalog hygiene — every entry has the required fields; live
 *      capabilities have all three runtimes flagged; deferred/
 *      unsupported entries have a deferredReason.
 *   2. Tool-name agreement — the runtime exposure factories actually
 *      register the names the contract claims.
 *   3. Drift detection — every runtime exposure file either re-exports
 *      the canonical prompt verbatim (TypeScript import) OR includes
 *      it as a substring of the local constant. Anything else is
 *      paraphrasing and fails the test.
 *   4. Widget artifact wire format — the `canonicalJson` in the
 *      contract MUST JSON.parse + parseAllShowWidgets MUST return a
 *      `widget` segment (not malformed_widget). This is the slice-7
 *      direct fix for the slice-6 broken example.
 *   5. UI render path consistency — for media-bearing capabilities
 *      the render path mentions MediaPreview / SSE tool_result.media.
 *
 * The test is intentionally strict on widget (the smoke-broken one)
 * and looser on capabilities where Native/MCP drift is tech-debt
 * (memory / tasks). Those use a "core rule must appear in some form"
 * check rather than full string equality.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  HARNESS_CAPABILITIES,
  getCapability,
  liveCapabilities,
  deferredCapabilities,
  unsupportedCapabilities,
} from '@/lib/harness/capability-contract';
import { parseAllShowWidgets } from '@/components/chat/MessageItem';
import {
  WIDGET_SYSTEM_PROMPT as CANONICAL_WIDGET_PROMPT,
  WIDGET_WIRE_FORMAT_SPEC,
} from '@/lib/widget-guidelines';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function readSource(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────
// (1) Catalog hygiene
// ─────────────────────────────────────────────────────────────────────

describe('HARNESS_CAPABILITIES — catalog hygiene', () => {
  it('every entry has the required fields', () => {
    for (const cap of HARNESS_CAPABILITIES) {
      assert.ok(cap.id, `entry must have id; got: ${JSON.stringify(cap)}`);
      assert.ok(cap.displayName, `${cap.id}: displayName required`);
      assert.ok(Array.isArray(cap.toolNames), `${cap.id}: toolNames must be array`);
      assert.ok(cap.exposure.claudecode_sdk, `${cap.id}: claudecode_sdk exposure required`);
      assert.ok(cap.exposure.native, `${cap.id}: native exposure required`);
      assert.ok(cap.exposure.codex_proxy, `${cap.id}: codex_proxy exposure required`);
      assert.ok(cap.uiRenderPath, `${cap.id}: uiRenderPath required`);
      assert.ok(Array.isArray(cap.canonicalEventTypes), `${cap.id}: canonicalEventTypes must be array`);
    }
  });

  it('ids are unique', () => {
    const ids = HARNESS_CAPABILITIES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate capability ids: ${ids.join(', ')}`);
  });

  it('non-live capabilities have a deferredReason', () => {
    for (const cap of HARNESS_CAPABILITIES) {
      if (cap.status === 'live') continue;
      assert.ok(
        cap.deferredReason && cap.deferredReason.length > 20,
        `${cap.id} status=${cap.status} must include a substantive deferredReason; got: ${cap.deferredReason ?? 'undefined'}`,
      );
    }
  });

  it('live capabilities have NO unsupported exposures (strict semantics)', () => {
    // Phase 5d slice 7b (2026-05-16) — pre-fix the test accepted
    // "live with one unsupported runtime" if at least two runtimes
    // were wired. That permitted exactly the混合口径 the user flagged:
    // a `live` capability that's actually missing on Codex (or any
    // other runtime). Strict rule: status === 'live' must have
    // EVERY declared exposure executable. If a runtime can't wire
    // the capability, flip status to `deferred` or split it.
    for (const cap of liveCapabilities()) {
      const unsupportedRuntimes = (
        ['claudecode_sdk', 'native', 'codex_proxy'] as const
      ).filter((r) => cap.exposure[r].kind === 'unsupported');
      assert.equal(
        unsupportedRuntimes.length,
        0,
        `${cap.id} is live but ${unsupportedRuntimes.join(', ')} marked unsupported. Either implement those runtimes or flip status to "deferred" / split the capability.`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// (2) Tool-name surface agreement
// ─────────────────────────────────────────────────────────────────────

describe('Tool names declared in the contract appear in the runtime exposure files', () => {
  it('every tool name in `live` capabilities appears verbatim in at least one wired exposure file', () => {
    for (const cap of liveCapabilities()) {
      const wiredFiles = [cap.exposure.claudecode_sdk, cap.exposure.native, cap.exposure.codex_proxy]
        .filter((e) => e.kind !== 'unsupported' && e.module)
        .map((e) => readSource(e.module!));
      for (const name of cap.toolNames) {
        const inAny = wiredFiles.some((src) => src.includes(name));
        assert.ok(
          inAny,
          `${cap.id} tool "${name}" missing from every wired runtime exposure file. Either remove it from toolNames or wire it.`,
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// (3) Drift detection — Codex bridge alignment is strict
// ─────────────────────────────────────────────────────────────────────

describe('Codex bridge prompt does not redefine widget semantics', () => {
  it('bridge holds NO local prompt scalars; compiler is the sole producer (slice 2e + Phase 3 facade)', () => {
    // Phase 5d Phase 2 slice 2e (2026-05-17) — pre-fix the bridge held
    // WIDGET_PROMPT (and MEDIA / MEMORY / NOTIFY before that). Slice 2e
    // removed all four scalars; the Context Compiler is the only
    // producer of capability prompts now.
    //
    // Phase 5d Phase 3 (2026-05-17) — assertion shifted from "direct
    // compileContext import" to "Runtime Capability Adapter facade
    // (`adaptForCodexProxy`) wraps the compiler call". The contract is
    // strictly stronger: the bridge prompt MUST flow through the
    // facade, which itself is the only consumer of `compileContext`
    // on the Codex path.
    const bridgeSrc = readSource('src/lib/codex/proxy/builtin-bridge.ts');
    assert.equal(
      /^const\s+(WIDGET_PROMPT|MEDIA_PROMPT|MEMORY_PROMPT|NOTIFY_PROMPT)\s*=/m.test(bridgeSrc),
      false,
      'bridge MUST NOT declare WIDGET_PROMPT / MEDIA_PROMPT / MEMORY_PROMPT / NOTIFY_PROMPT scalars — capability prompts flow through the Runtime Capability Adapter now',
    );
    // unified-adapter.ts must call adaptForCodexProxy and use its
    // systemPromptInstructions for the bridge prompt.
    const adapterSrc = readSource('src/lib/codex/proxy/unified-adapter.ts');
    assert.match(
      adapterSrc,
      /import\s*\{\s*adaptForCodexProxy\s*\}\s*from\s*'@\/lib\/harness\/runtime-adapter'/,
      'unified-adapter must import adaptForCodexProxy from the Runtime Capability Adapter',
    );
    assert.equal(
      /from\s+['"]@\/lib\/harness\/context-compiler['"]/.test(adapterSrc),
      false,
      'unified-adapter must NOT import the compiler directly — go through the adapter facade',
    );
    assert.match(
      adapterSrc,
      /adapted\.systemPromptInstructions|systemPromptInstructions/,
      'unified-adapter must consume adapted.systemPromptInstructions',
    );
  });

  it('Native Runtime widget builtin-tools file re-exports the canonical', () => {
    const nativeSrc = readSource('src/lib/builtin-tools/widget-guidelines.ts');
    assert.match(
      nativeSrc,
      /import\s*\{[^}]*WIDGET_SYSTEM_PROMPT[^}]*\}\s*from\s*'@\/lib\/widget-guidelines'/,
      'Native widget tools file MUST import the canonical WIDGET_SYSTEM_PROMPT',
    );
    assert.match(
      nativeSrc,
      /export\s+const\s+WIDGET_SYSTEM_PROMPT\s*=\s*CANONICAL_WIDGET_SYSTEM_PROMPT\s*;/,
      'Native widget tools must re-export the canonical, not redefine it',
    );
  });

  it('Native Runtime memory / notification / media builtin-tools files consume shared canonicals (slice 2d)', () => {
    // Phase 5d Phase 2 slice 2d (2026-05-17) — Native ran with its
    // own paraphrased prompts pre-Phase-5d. Slice 2d migrated them
    // to consume shared prompt authorities. Media now uses a pure
    // dependency-free authority so Native loading cannot pull the
    // Claude SDK async chunk into Turbopack. Drift tests pin each so
    // a future commit re-introducing a local string trips here.
    const memorySrc = readSource('src/lib/builtin-tools/memory-search.ts');
    assert.match(
      memorySrc,
      /export\s*\{[^}]*MEMORY_SEARCH_SYSTEM_PROMPT[^}]*\}\s*from\s*'@\/lib\/memory-service'/,
      'Native memory must re-export the SDK-neutral memory service prompt',
    );
    assert.match(
      memorySrc,
      /createMemoryAdapterQueryTools[\s\S]*from\s*'@\/lib\/memory-rerank'/,
    );

    const notificationSrc = readSource('src/lib/builtin-tools/notification.ts');
    assert.match(
      notificationSrc,
      /import\s*\{[^}]*NOTIFICATION_MCP_SYSTEM_PROMPT[^}]*\}\s*from\s*'@\/lib\/notification-mcp'/,
      'Native notification must re-export from notification-mcp.ts',
    );
    assert.match(
      notificationSrc,
      /export\s+const\s+NOTIFICATION_SYSTEM_PROMPT\s*=\s*NOTIFICATION_MCP_SYSTEM_PROMPT\s*;/,
    );

    const mediaPromptSrc = readSource('src/lib/media-capability-prompt.ts');
    const mediaSrc = readSource('src/lib/builtin-tools/media.ts');
    const mediaMcpSrc = readSource('src/lib/media-import-mcp.ts');
    assert.match(
      mediaSrc,
      /import\s*\{[^}]*MEDIA_CAPABILITY_SYSTEM_PROMPT[^}]*\}\s*from\s*'@\/lib\/media-capability-prompt'/,
      'Native media must consume the dependency-free canonical prompt',
    );
    assert.match(
      mediaSrc,
      /export\s+const\s+MEDIA_SYSTEM_PROMPT\s*=\s*MEDIA_CAPABILITY_SYSTEM_PROMPT\s*;/,
    );
    assert.match(
      mediaMcpSrc,
      /export\s+const\s+MEDIA_MCP_SYSTEM_PROMPT\s*=\s*MEDIA_CAPABILITY_SYSTEM_PROMPT\s*;/,
      'Claude SDK MCP must consume the same dependency-free canonical prompt',
    );
    assert.doesNotMatch(
      mediaPromptSrc,
      /@anthropic-ai\/claude-agent-sdk|media-import-mcp|createSdkMcpServer/,
      'canonical media prompt must stay dependency-free so Turbopack keeps Native media synchronous',
    );
  });

  it('ClaudeCode SDK Runtime claude-client.ts calls the Runtime Capability Adapter facade (slice 2c + Phase 3)', () => {
    // Phase 5d Phase 2 slice 2c — claude-client.ts mounts MCP servers
    // per-gate (transport layer) and let the Context Compiler produce
    // the capability system prompt content (semantic layer).
    // Pre-Phase-5d this file appended per-capability `_SYSTEM_PROMPT`
    // strings inline.
    //
    // Phase 5d Phase 3 (2026-05-17) — the compiler call is now wrapped
    // by `adaptForClaudeCode`. The entry point consumes the adapter
    // facade, not the compiler directly; the adapter is the only path
    // from this file to the catalog.
    const claudeSrc = readSource('src/lib/claude-client.ts');

    // (a) No drift sources: no import from builtin-tools/* (Native path).
    assert.equal(
      /from\s+['"]@\/lib\/builtin-tools\/(memory-search|notification|media|cli-tools|dashboard|widget-guidelines)['"]/.test(claudeSrc),
      false,
      'claude-client.ts must not import capability prompts from builtin-tools/* — those are the Native runtime path',
    );

    // (b) No local _SYSTEM_PROMPT declarations.
    assert.equal(
      /^export\s+const\s+\w+_SYSTEM_PROMPT\s*=\s*[`'"]/m.test(claudeSrc),
      false,
      'claude-client.ts must not declare its own _SYSTEM_PROMPT scalars',
    );

    // (c) Phase 3 integration: claude-client.ts must consume the
    //     Runtime Capability Adapter facade + use
    //     `adapted.systemPromptAppend` for the capability prompt append.
    assert.match(
      claudeSrc,
      /adaptForClaudeCode.*from.*['"]@\/lib\/harness\/runtime-adapter['"]|import\(['"]@\/lib\/harness\/runtime-adapter['"]\)/,
      'claude-client.ts must import adaptForClaudeCode (static or dynamic) from the runtime-adapter facade',
    );
    assert.equal(
      /from\s+['"]@\/lib\/harness\/context-compiler['"]/.test(claudeSrc),
      false,
      'claude-client.ts must NOT import the compiler directly — go through adaptForClaudeCode',
    );
    assert.match(
      claudeSrc,
      /adapted\.systemPromptAppend/,
      'claude-client.ts must consume adapted.systemPromptAppend (Phase 3 facade output)',
    );

    // (d) No per-capability inline append patterns left over.
    // The old shape was
    //   `queryOptions.systemPrompt.append = ... + MEMORY_SEARCH_SYSTEM_PROMPT;`
    // (or any of the other capability constants). Source-grep
    // catches a future regression that adds back inline appends.
    const inlineAppendRe = /\.append\s*=\s*\([^)]*\)\s*\+\s*['"]?\\?n\\?n['"]?\s*\+\s*(MEMORY_SEARCH_SYSTEM_PROMPT|NOTIFICATION_MCP_SYSTEM_PROMPT|MEDIA_MCP_SYSTEM_PROMPT|CLI_TOOLS_MCP_SYSTEM_PROMPT|DASHBOARD_MCP_SYSTEM_PROMPT|WIDGET_SYSTEM_PROMPT)/;
    assert.equal(
      inlineAppendRe.test(claudeSrc),
      false,
      'claude-client.ts must not inline-append per-capability _SYSTEM_PROMPT strings — use the adapter facade output instead',
    );
  });

  it('Native Runtime builtin-tools/index.ts routes capability prompts through the Runtime Capability Adapter (slice 2d + Phase 3)', () => {
    // Phase 5d Phase 2 slice 2d — getBuiltinTools() decides gating
    // per group (workspace / keyword / always), then calls into the
    // Context Compiler to produce the canonical capability prompt.
    //
    // Phase 5d Phase 3 (2026-05-17) — the compiler call is wrapped by
    // `adaptForNative`. Non-capability groups (session-search /
    // ask-user-question) still pass through their raw `systemPrompt`
    // until they get their own capability contract entries.
    const indexSrc = readSource('src/lib/builtin-tools/index.ts');

    assert.match(
      indexSrc,
      /import\s*\{\s*adaptForNative\s*\}\s*from\s*['"]@\/lib\/harness\/runtime-adapter['"]/,
      'builtin-tools/index.ts must import adaptForNative from the Runtime Capability Adapter facade',
    );
    assert.equal(
      /from\s+['"]@\/lib\/harness\/context-compiler['"]/.test(indexSrc),
      false,
      'builtin-tools/index.ts must NOT import the compiler directly — go through adaptForNative',
    );
    assert.match(
      indexSrc,
      /capabilityIdsForGroup/,
      'builtin-tools/index.ts must declare capabilityIdsForGroup mapping (group name → list of capability ids)',
    );
    assert.match(
      indexSrc,
      /adapted\.systemPromptText/,
      'getBuiltinTools must consume adapted.systemPromptText for the capability prompt slot (Phase 3 facade)',
    );
    assert.match(
      indexSrc,
      /import\s*\{[^}]*createMediaTools[^}]*MEDIA_SYSTEM_PROMPT[^}]*\}\s*from\s*['"]\.\/media['"]/,
      'required Native media tools must use a static import so Turbopack cannot silently drop an async require',
    );
    assert.doesNotMatch(
      indexSrc,
      /require\(['"]\.\/media['"]\)/,
      'Native media must not cross a synchronous require boundary in a Next/Turbopack route',
    );

    const toolGroupBody = indexSrc.slice(indexSrc.indexOf('function getToolGroups'));
    assert.doesNotMatch(
      toolGroupBody,
      /catch\s*\{\s*(?:\/\*[\s\S]*?\*\/)?\s*\}/,
      'built-in group load failures must be observable; empty catches create false capability success',
    );
  });

  it('codepilot-media group maps to BOTH media_import and image_generation capabilities (slice 2d P1 fix)', () => {
    // Phase 5d Phase 2 P1 fix (2026-05-17) — `createMediaTools()`
    // mounts `codepilot_import_media` (media_import) AND
    // `codepilot_generate_image` (image_generation). Pre-fix the
    // builtin-tools/index.ts capability map only listed
    // media_import; the compiler then thought image_generation was
    // not active on Native, even though the tool was actually
    // callable. Source-pin the new multi-capability mapping.
    const indexSrc = readSource('src/lib/builtin-tools/index.ts');
    // Find the `case 'codepilot-media':` arm and confirm both
    // capability ids appear within its return list. The window is
    // widened to 1500 chars because the slice-2d P1 fix landed a
    // long explanatory comment between the case label and the
    // return statement.
    const arm = indexSrc.match(/case 'codepilot-media':[\s\S]{0,1500}?return\s*\[([^\]]*)\]/);
    assert.ok(arm, 'capabilityIdsForGroup must have a `codepilot-media` arm that returns an array');
    const ids = arm![1];
    assert.match(ids, /'media_import'/, 'codepilot-media must include media_import');
    assert.match(ids, /'image_generation'/, 'codepilot-media must include image_generation — createMediaTools mounts the codepilot_generate_image tool too');
  });

  it('Native getBuiltinTools — codepilot_generate_image present implies image_generation in compiled toolDescriptors (runtime check)', async () => {
    // Live runtime check via the compiler: when Native gates in the
    // codepilot-media group (always-on per builtin-tools/index.ts)
    // the compiler MUST emit a toolDescriptor for
    // codepilot_generate_image. Pre-P1-fix this assertion failed
    // because the group was only marked `media_import`.
    const { compileContext } = await import('@/lib/harness/context-compiler');
    const compiled = compileContext({
      sessionId: 'native-test',
      workingDirectory: '/tmp/native-test',
      runtimeId: 'codepilot_runtime',
      providerId: '',
      model: '',
      userPrompt: '',
      enabledCapabilities: new Set(['media_import', 'image_generation']),
      tokenBudget: { systemPromptMax: 100_000, contextMax: 200_000 },
    });
    const names = new Set(compiled.toolDescriptors.map((t) => t.name));
    assert.ok(
      names.has('codepilot_generate_image'),
      'compiler must emit codepilot_generate_image toolDescriptor when image_generation is enabled',
    );
    assert.ok(
      names.has('codepilot_import_media'),
      'compiler must emit codepilot_import_media toolDescriptor when media_import is enabled',
    );
  });
});

describe('Capability prompts inject WITHOUT a base systemPrompt (P1 fix, 2026-05-17)', () => {
  it('Native: agent-loop.ts effectiveSystemPrompt joins tool prompts even when base systemPrompt is empty', () => {
    // Pre-fix source had:
    //   `toolSystemPrompts.length > 0 && systemPrompt
    //     ? systemPrompt + ... : systemPrompt`
    // which dropped toolSystemPrompts whenever systemPrompt was
    // falsy. Source-pin the new shape (filter(Boolean).join).
    const src = readSource('src/lib/agent-loop.ts');
    // The new combining expression must contain `.filter(Boolean)`
    // applied to an array that includes both systemPrompt and
    // toolSystemPrompts.
    assert.match(
      src,
      /\[\s*systemPrompt\s*,\s*\.\.\.toolSystemPrompts\s*\]\.filter\(Boolean\)\.join/,
      'agent-loop.ts must compose effectiveSystemPrompt via [systemPrompt, ...toolSystemPrompts].filter(Boolean).join — drops nothing when one side is empty',
    );
    // Negative: the broken pre-fix shape must be gone.
    assert.equal(
      /toolSystemPrompts\.length\s*>\s*0\s*&&\s*systemPrompt\s*\?\s*systemPrompt\s*\+/.test(src),
      false,
      'agent-loop.ts must not use the pre-fix conditional that dropped tool prompts when base systemPrompt was empty',
    );
  });

  it('ClaudeCode: claude-client.ts initialises queryOptions.systemPrompt with preset shape (adapter block always runs)', () => {
    // Pre-fix the compileContext block was guarded by
    // `&& queryOptions.systemPrompt && typeof ... === 'object'`. If
    // the caller didn't pass a base systemPrompt, queryOptions.
    // systemPrompt was undefined and the compiled prompt was
    // silently dropped. Pin the new fallback branch that mounts
    // the SDK preset shape on demand.
    //
    // Phase 5d Phase 3 (2026-05-17) — `compiled.systemPromptText` was
    // renamed to `adapted.systemPromptAppend` when the call moved into
    // the Runtime Capability Adapter facade.
    //
    // Phase 5e review round 4 fix P2 #1 (2026-05-18) — the
    // `if (enabledCapabilities.size > 0)` outer guard around the
    // entire scan + adapter block was removed: User / External
    // harness extensions also need injection, even when no built-in
    // capability is gated in. The block now runs unconditionally;
    // the `adapted.systemPromptAppend.length > 0` check inside is
    // the only gate before splicing into queryOptions.systemPrompt.
    //
    // Pin shape:
    //   - adaptForClaudeCode is called
    //   - the preset-shape mount uses adapted.systemPromptAppend
    const src = readSource('src/lib/claude-client.ts');
    assert.match(
      src,
      /adaptForClaudeCode\(\{/,
      'claude-client.ts must call adaptForClaudeCode',
    );
    assert.match(
      src,
      /if\s*\(adapted\.systemPromptAppend\.length\s*>\s*0\)/,
      'claude-client.ts must gate the systemPrompt splice on `adapted.systemPromptAppend.length > 0` — that is the sole condition (no outer enabledCapabilities.size gate)',
    );
    assert.match(
      src,
      /queryOptions\.systemPrompt\s*=\s*\{\s*[\s\S]*?type:\s*['"]preset['"][\s\S]*?preset:\s*['"]claude_code['"][\s\S]*?append:\s*adapted\.systemPromptAppend/,
      'claude-client.ts must initialise queryOptions.systemPrompt with the Claude Code preset shape when none was provided',
    );
  });

  it('Native runtime: getBuiltinTools returns the compiler-produced systemPrompt[0] even when caller passes no prompt', async () => {
    // Live runtime check. getBuiltinTools is the Native-side entry
    // — its return value is used as `toolSystemPrompts` in
    // agent-loop.ts. With workspacePath provided but no userPrompt,
    // tasks_and_notify (always-on, always-mounted) should still
    // produce a capability prompt — proving the path from group
    // gating through compileContext returns a non-empty fragment
    // independent of base prompt presence.
    const { getBuiltinTools } = await import('@/lib/builtin-tools');
    const { tools, systemPrompts } = getBuiltinTools({
      workspacePath: '/tmp/test',
      prompt: '',
      grokVideoAvailable: true,
    });
    assert.ok(Object.keys(tools).length > 0, 'getBuiltinTools must mount at least one tool (notify is always-on)');
    assert.ok(tools.codepilot_generate_image, 'Native runtime must mount codepilot_generate_image');
    assert.ok(tools.codepilot_generate_video, 'Native runtime must mount codepilot_generate_video');
    assert.ok(tools.codepilot_import_media, 'Native runtime must mount codepilot_import_media');
    assert.ok(systemPrompts.length > 0, 'getBuiltinTools must return a non-empty systemPrompts array');
    assert.ok(
      systemPrompts[0].length > 0,
      'compiler-produced systemPrompts[0] must be non-empty when at least one capability is gated in',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// (4) Widget artifact wire format — copy/paste-safe JSON
// ─────────────────────────────────────────────────────────────────────

describe('Widget artifact contract — canonicalJson is JSON.parse-safe + renders via parseAllShowWidgets', () => {
  it('JSON.parse(canonicalJson) returns an object with the required fields', () => {
    const widget = getCapability('widget');
    assert.ok(widget?.artifactContract, 'widget capability must declare an artifactContract');
    const { canonicalJson, requiredFields } = widget!.artifactContract!;
    // The slice-7 fix: this string must round-trip through JSON.parse
    // without escape-counting tricks. Slice 6 had `\\\"` here and
    // would fail this assertion.
    const parsed = JSON.parse(canonicalJson) as Record<string, unknown>;
    assert.equal(typeof parsed, 'object');
    for (const field of requiredFields) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(parsed, field),
        `canonicalJson missing required field "${field}"`,
      );
    }
    // Widget-specific shape checks.
    assert.equal(typeof parsed.title, 'string');
    assert.equal(typeof parsed.widget_code, 'string');
    assert.ok((parsed.widget_code as string).length > 0);
  });

  it('canonicalJson wrapped in a show-widget fence renders via parseAllShowWidgets (not malformed_widget)', () => {
    const widget = getCapability('widget');
    assert.ok(widget?.artifactContract);
    const { fenceLanguage, canonicalJson } = widget!.artifactContract!;
    // Build the literal fence the model would emit — three backticks
    // + fence language + JSON + three backticks. If the renderer
    // returns malformed_widget for this, the example in the prompt
    // is broken (slice-6 regression mode).
    const fence = '```' + fenceLanguage + '\n' + canonicalJson + '\n```';
    const segs = parseAllShowWidgets(fence);
    const widgetSeg = segs.find((s) => s.type === 'widget');
    const malformed = segs.find((s) => s.type === 'malformed_widget');
    assert.ok(widgetSeg, `canonical show-widget example must parse as a widget segment, got: ${JSON.stringify(segs)}`);
    assert.equal(malformed, undefined, 'canonical example must never trip malformed_widget — if it does, the prompt is broken');
    if (widgetSeg?.type !== 'widget') return;
    assert.equal(widgetSeg.data.title, 'Hello');
    // The widget_code should be exactly what's in the JSON, no
    // escape-counting weirdness.
    assert.match(widgetSeg.data.widget_code, /Hello world/);
  });

  it('the canonical example appears inside WIDGET_WIRE_FORMAT_SPEC; artifactContract is the sole carrier (slice 2c)', () => {
    // Phase 5d Phase 2 slice 2c (2026-05-17) — pin shifted. The
    // Context Compiler's artifactContract for `widget` is now the
    // single source of the wire-format spec + canonical example.
    // WIDGET_SYSTEM_PROMPT no longer embeds the literal example so
    // the compiler can produce a duplicate-free system prompt.
    const widget = getCapability('widget');
    assert.ok(widget?.artifactContract);
    const example = widget!.artifactContract!.canonicalJson;
    assert.ok(
      WIDGET_WIRE_FORMAT_SPEC.includes(example),
      'WIDGET_WIRE_FORMAT_SPEC must still embed the canonical example — that block lives in the compiled artifactContract',
    );
    assert.equal(
      CANONICAL_WIDGET_PROMPT.includes(example),
      false,
      'WIDGET_SYSTEM_PROMPT must NOT embed the canonical example after slice 2c — duplicates would let the wire format land in the compiled prompt twice',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// (5) UI render path consistency for media-bearing capabilities
// ─────────────────────────────────────────────────────────────────────

describe('Media-bearing capabilities declare a MediaPreview render path', () => {
  it('every capability with toolResultShape === "media" mentions MediaPreview in its uiRenderPath', () => {
    for (const cap of HARNESS_CAPABILITIES) {
      if (cap.toolResultShape !== 'media') continue;
      assert.match(
        cap.uiRenderPath,
        /MediaPreview/,
        `${cap.id} produces media but renderPath doesn't mention MediaPreview — the chain is broken`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// (6) Status-aware exposure invariants
// ─────────────────────────────────────────────────────────────────────

describe('Deferred / unsupported capabilities have honest exposure shapes', () => {
  it('deferred capabilities have at least ONE runtime marked unsupported (otherwise they are actually live)', () => {
    for (const cap of deferredCapabilities()) {
      const anyUnsupported = [
        cap.exposure.claudecode_sdk,
        cap.exposure.native,
        cap.exposure.codex_proxy,
      ].some((e) => e.kind === 'unsupported');
      assert.ok(
        anyUnsupported,
        `${cap.id} is deferred but every exposure is wired — should be flipped to 'live'`,
      );
    }
  });

  it('unsupported runtime exposures carry a `notes` explanation', () => {
    for (const cap of HARNESS_CAPABILITIES) {
      for (const [runtime, exp] of Object.entries(cap.exposure)) {
        if (exp.kind === 'unsupported') {
          assert.ok(
            exp.notes && exp.notes.length > 10,
            `${cap.id}.${runtime} is unsupported but has no explanatory notes`,
          );
        }
      }
    }
  });

  it('liveCapabilities() / deferredCapabilities() / unsupportedCapabilities() partition the catalog', () => {
    const total = liveCapabilities().length + deferredCapabilities().length + unsupportedCapabilities().length;
    assert.equal(total, HARNESS_CAPABILITIES.length, 'every capability must fall into exactly one status bucket');
  });
});

// ─────────────────────────────────────────────────────────────────────
// (7) System prompt fragments aren't accidentally empty
// ─────────────────────────────────────────────────────────────────────

describe('System prompt fragments are present for live capabilities (unless explicitly noted)', () => {
  it('every live capability with a documented authority file has a non-empty prompt', () => {
    for (const cap of liveCapabilities()) {
      // cli_tools is currently the only documented exception (prompt
      // lives inline in the factory; future slice extracts it).
      if (cap.id === 'cli_tools') continue;
      assert.ok(
        cap.systemPromptFragment.length > 0,
        `${cap.id} is live but systemPromptFragment is empty — either point at the canonical source or mark as tech-debt`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// (8) Cross-check: the contract list matches the bridge's mounted set
// ─────────────────────────────────────────────────────────────────────

describe('Codex bridge tool surface matches the contract', () => {
  it('every codex_proxy.kind = bridge_executable tool name is mounted by createCodePilotBuiltinTools (no notes exceptions)', async () => {
    // Phase 5d slice 7b (2026-05-16) — strict mount check. Pre-fix
    // the test had a `notes`-based exception clause: if a tool was
    // declared bridge_executable but not actually mounted, a note
    // mentioning "not exposed" silenced the failure. That let
    // tasks_and_notify carry codepilot_hatch_buddy in its toolNames
    // while the bridge mounted only 4 of 5 — a half-truth in the
    // catalog.
    //
    // New rule: if codex_proxy.kind === 'bridge_executable', then
    // EVERY tool name in toolNames must mount. If a runtime can't
    // host a tool, either:
    //   - flip that runtime's `kind` to 'unsupported' + add notes
    //   - split the tool out into its own capability (e.g.
    //     assistant_buddy holds codepilot_hatch_buddy separately
    //     from tasks_and_notify — its codex_proxy is still
    //     'unsupported' even though Native + ClaudeCode both ship
    //     post-round-8)
    const { createCodePilotBuiltinTools } = await import('@/lib/codex/proxy/builtin-bridge');
    const os = await import('node:os');
    const { createSession, setSetting } = await import('@/lib/db');
    const { bindAssistantMemory } = await import('@/lib/memory-binding');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-memory-'));
    setSetting('assistant_workspace_path', root);
    const session = createSession('capability contract', undefined, undefined, root);
    bindAssistantMemory(session.id);
    const bridge = createCodePilotBuiltinTools({
      sessionId: session.id,
      targetProviderId: 'prov-test',
      workspacePath: root,
      grokVideoAvailable: true,
    });
    const mounted = new Set(Object.keys(bridge.tools));
    for (const cap of HARNESS_CAPABILITIES) {
      if (cap.exposure.codex_proxy.kind !== 'bridge_executable') continue;
      for (const toolName of cap.toolNames) {
        assert.ok(
          mounted.has(toolName),
          `${cap.id}.${toolName} is declared bridge_executable but createCodePilotBuiltinTools does NOT mount it. Fix the bridge factory, mark this runtime unsupported, or split the tool into a deferred capability — notes-based exceptions are no longer accepted.`,
        );
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});
