/**
 * Phase 5d Phase 3 (2026-05-17) — Runtime Capability Adapter contract tests.
 *
 * Phase 2's `compileContext` is a pure function with its own
 * `harness-context-compiler.test.ts` pinning catalog hygiene + widget
 * wire-format single-source + runtimeHints prose ban.
 *
 * Phase 3 adds three runtime-specific facades on top
 * (`adaptForClaudeCode`, `adaptForNative`, `adaptForCodexProxy`). The
 * facades thin out the per-runtime entry points so each entry point
 * consumes exactly ONE adapter call. These tests pin:
 *
 *   1. Shape contract — each facade returns the documented fields.
 *   2. Phase 2 review invariants — survived the migration into Phase 3:
 *      a. ClaudeCode/Native ALWAYS produce a string (never null) so
 *         the caller can inject the prompt even without a base
 *         systemPrompt.
 *      b. Native `codepilot-media` enabled set with BOTH
 *         `media_import` + `image_generation` emits BOTH tool names.
 *   3. Cross-runtime fragment identity — the compiler's "same fragment
 *      text across runtimes" promise is preserved through each facade.
 *   4. Entry-point cleanliness — `claude-client.ts` / `builtin-tools/index.ts`
 *      / `codex/proxy/unified-adapter.ts` no longer import
 *      `compileContext` directly (drift surface closed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  adaptForClaudeCode,
  adaptForNative,
  adaptForCodexProxy,
  type RuntimeAdapterInput,
} from '@/lib/harness/runtime-adapter';
import { HARNESS_CAPABILITIES } from '@/lib/harness/capability-contract';
import {
  CANONICAL_SHOW_WIDGET_JSON,
  WIDGET_WIRE_FORMAT_SPEC,
} from '@/lib/widget-guidelines';

const REPO_ROOT = path.resolve(__dirname, '../../..');

function readSource(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

function baseInput(
  overrides: Partial<RuntimeAdapterInput> = {},
): RuntimeAdapterInput {
  return {
    sessionId: 'test-session',
    workingDirectory: '/tmp/test-workspace',
    providerId: 'prov-test',
    model: 'test-model',
    userPrompt: 'irrelevant — gating happens in caller',
    enabledCapabilities: new Set<string>(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 1. Shape contract — each facade returns the documented fields.
// ─────────────────────────────────────────────────────────────────────

describe('adaptForClaudeCode — shape contract', () => {
  it('returns systemPromptAppend (string) + mcpServerNames + allowedToolNames + compiled', () => {
    const out = adaptForClaudeCode(
      baseInput({ enabledCapabilities: new Set(['widget']) }),
    );
    assert.equal(typeof out.systemPromptAppend, 'string');
    assert.ok(Array.isArray(out.mcpServerNames));
    assert.ok(Array.isArray(out.allowedToolNames));
    assert.ok(out.compiled);
    assert.equal(out.compiled.runtimeHints.claudecode_sdk !== undefined, true);
  });

  it('empty enabledCapabilities → empty append + empty hint arrays (no nulls)', () => {
    const out = adaptForClaudeCode(
      baseInput({ enabledCapabilities: new Set<string>() }),
    );
    assert.equal(out.systemPromptAppend, '');
    assert.equal(out.mcpServerNames.length, 0);
    assert.equal(out.allowedToolNames.length, 0);
  });

  it('widget enabled → systemPromptAppend non-empty + mcpServerNames includes "codepilot-widget" + allowed includes widget tool', () => {
    const out = adaptForClaudeCode(
      baseInput({ enabledCapabilities: new Set(['widget']) }),
    );
    assert.ok(out.systemPromptAppend.length > 0);
    assert.ok(out.mcpServerNames.includes('codepilot-widget'));
    assert.ok(out.allowedToolNames.includes('codepilot_load_widget_guidelines'));
  });
});

describe('adaptForNative — shape contract', () => {
  it('returns systemPromptText (string) + toolSetKeys + compiled', () => {
    const out = adaptForNative(
      baseInput({ enabledCapabilities: new Set(['widget']) }),
    );
    assert.equal(typeof out.systemPromptText, 'string');
    assert.ok(Array.isArray(out.toolSetKeys));
    assert.ok(out.compiled);
    assert.equal(out.compiled.runtimeHints.native !== undefined, true);
  });

  it('empty enabledCapabilities → empty text + empty toolSetKeys (no nulls)', () => {
    const out = adaptForNative(
      baseInput({ enabledCapabilities: new Set<string>() }),
    );
    assert.equal(out.systemPromptText, '');
    assert.equal(out.toolSetKeys.length, 0);
  });
});

describe('adaptForCodexProxy — shape contract', () => {
  it('returns systemPromptInstructions + builtinToolNames + stopWhen + stepCount + compiled', () => {
    const out = adaptForCodexProxy(
      baseInput({ enabledCapabilities: new Set(['widget']) }),
    );
    assert.equal(typeof out.systemPromptInstructions, 'string');
    assert.ok(out.builtinToolNames instanceof Set);
    assert.ok(['stepCountIs', 'never'].includes(out.stopWhen));
    assert.equal(typeof out.stepCount, 'number');
    assert.ok(out.compiled);
    assert.equal(out.compiled.runtimeHints.codex_proxy !== undefined, true);
  });

  it('empty enabledCapabilities → empty instructions + builtinToolNames=∅ + stopWhen=never', () => {
    const out = adaptForCodexProxy(
      baseInput({ enabledCapabilities: new Set<string>() }),
    );
    assert.equal(out.systemPromptInstructions, '');
    assert.equal(out.builtinToolNames.size, 0);
    assert.equal(out.stopWhen, 'never');
    // `stepCount` is the static `BUILTIN_BRIDGE_STEP_LIMIT` (8) the
    // catalog declares for the Codex proxy hint, regardless of the
    // enabled set — the caller (`unified-adapter.ts`) gates use of
    // `stopWhen: stepCountIs(stepCount)` on `builtinToolNames.size > 0`
    // separately, so the constant being non-zero when nothing is
    // enabled is harmless. Pin the constant so a future refactor of
    // the catalog's step-limit value trips this test.
    assert.equal(out.stepCount, 8);
  });

  it('capability enabled → stopWhen=stepCountIs with stepCount=8 (matches BUILTIN_BRIDGE_STEP_LIMIT)', () => {
    const out = adaptForCodexProxy(
      baseInput({ enabledCapabilities: new Set(['widget']) }),
    );
    assert.equal(out.stopWhen, 'stepCountIs');
    assert.equal(out.stepCount, 8);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2a. Phase 2 review invariant — capability prompt is always a string
//     (never null) so the runtime entry point can inject it even
//     when no upstream systemPrompt was supplied.
// ─────────────────────────────────────────────────────────────────────

describe('adapter Phase 2 review invariant — string-always shape', () => {
  it('ClaudeCode adapter returns string systemPromptAppend even with no base prompt context', () => {
    const out = adaptForClaudeCode(
      baseInput({ enabledCapabilities: new Set(['tasks_and_notify']) }),
    );
    // The caller (`claude-client.ts`) inspects `length > 0`; the
    // structural promise here is that the value is a string,
    // regardless of upstream `systemPrompt` presence.
    assert.equal(typeof out.systemPromptAppend, 'string');
    assert.ok(out.systemPromptAppend.length > 0);
  });

  it('Native adapter returns string systemPromptText even with no base prompt context', () => {
    const out = adaptForNative(
      baseInput({ enabledCapabilities: new Set(['tasks_and_notify']) }),
    );
    assert.equal(typeof out.systemPromptText, 'string');
    assert.ok(out.systemPromptText.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2b. Phase 2 review invariant — Native `codepilot-media` exposes
//     BOTH `media_import` + `image_generation`.
// ─────────────────────────────────────────────────────────────────────

describe('adapter Phase 2 review invariant — Native media dual capability', () => {
  it('Native adapter with {media_import, image_generation} emits both tool names', () => {
    const out = adaptForNative(
      baseInput({
        enabledCapabilities: new Set(['media_import', 'image_generation']),
      }),
    );
    assert.ok(
      out.toolSetKeys.includes('codepilot_import_media'),
      'media_import tool missing from toolSetKeys',
    );
    assert.ok(
      out.toolSetKeys.includes('codepilot_generate_image'),
      'image_generation tool missing from toolSetKeys',
    );
  });

  it('builtin-tools/index.ts maps the `codepilot-media` group to BOTH capability ids', () => {
    const src = readSource('src/lib/builtin-tools/index.ts');
    // The mapping function returns an array; find the
    // `case 'codepilot-media':` clause and confirm both ids appear
    // before the next `case` keyword.
    const idx = src.indexOf("case 'codepilot-media':");
    assert.ok(idx >= 0, "case 'codepilot-media': missing");
    const after = src.slice(idx, idx + 700);
    const nextCaseIdx = after.indexOf("case '", 5);
    const clause = nextCaseIdx >= 0 ? after.slice(0, nextCaseIdx) : after;
    assert.ok(
      /['"]media_import['"]/.test(clause),
      "codepilot-media → does not return 'media_import'",
    );
    assert.ok(
      /['"]image_generation['"]/.test(clause),
      "codepilot-media → does not return 'image_generation'",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2c. Phase 5e round 8 follow-up — Native `codepilot-notify` group
//     mounts BOTH the task/notify quartet AND `codepilot_hatch_buddy`,
//     so it must map to BOTH `tasks_and_notify` + `assistant_buddy`.
//     Same shape as the media case — Codex review caught this gap
//     after the Native parity patch landed: tool was mounted at
//     runtime, exposure.kind flipped to ai_sdk_tool, but the compiler
//     never saw `assistant_buddy` because the group map only returned
//     `tasks_and_notify`. Pin so a refactor can't quietly drop the
//     second id back out.
// ─────────────────────────────────────────────────────────────────────

describe('adapter Phase 5e round 8 — Native notify dual capability', () => {
  it('Native adapter with {tasks_and_notify, assistant_buddy} emits codepilot_hatch_buddy in toolSetKeys', () => {
    const out = adaptForNative(
      baseInput({
        enabledCapabilities: new Set(['tasks_and_notify', 'assistant_buddy']),
      }),
    );
    assert.ok(
      out.toolSetKeys.includes('codepilot_hatch_buddy'),
      'assistant_buddy is enabled but codepilot_hatch_buddy is not in toolSetKeys — adapter not forwarding the second capability',
    );
  });

  it('Native adapter with {tasks_and_notify} ONLY does NOT emit codepilot_hatch_buddy (compiler shape, not Native ToolSet shape)', () => {
    // Belt: the compiler honors the enabledCapabilities set verbatim.
    // If a caller passes only tasks_and_notify, hatch_buddy must NOT
    // appear in the compiler's toolSetKeys — that's the signal the
    // capability wasn't gated in. (The Native ToolSet still carries
    // hatch_buddy because createNotificationTools mounts it
    // unconditionally; the compiler's view is what matters for
    // system prompt + tool descriptor generation.)
    const out = adaptForNative(
      baseInput({
        enabledCapabilities: new Set(['tasks_and_notify']),
      }),
    );
    assert.ok(
      !out.toolSetKeys.includes('codepilot_hatch_buddy'),
      'codepilot_hatch_buddy leaked into toolSetKeys without assistant_buddy in enabledCapabilities',
    );
  });

  it('builtin-tools/index.ts maps the `codepilot-notify` group to BOTH capability ids', () => {
    const src = readSource('src/lib/builtin-tools/index.ts');
    const idx = src.indexOf("case 'codepilot-notify':");
    assert.ok(idx >= 0, "case 'codepilot-notify': missing");
    // Wide slice because the notify clause carries a long round-8
    // follow-up comment block. The actual `return [...]` statement
    // lands well after 700 chars; find the next case marker by
    // searching the full tail instead.
    const tail = src.slice(idx);
    const nextCaseIdx = tail.indexOf("case '", 5);
    const clause = nextCaseIdx >= 0 ? tail.slice(0, nextCaseIdx) : tail.slice(0, 2000);
    assert.ok(
      /['"]tasks_and_notify['"]/.test(clause),
      "codepilot-notify → does not return 'tasks_and_notify'",
    );
    assert.ok(
      /['"]assistant_buddy['"]/.test(clause),
      "codepilot-notify → does not return 'assistant_buddy' — Native factory mounts codepilot_hatch_buddy but the compiler won't know about the capability",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. Cross-runtime fragment identity — the compiler promise is
//    preserved through every facade. For any capability that is
//    `live` and supported on all three runtimes, the compiled
//    fragment text MUST be byte-identical across the three adapters.
// ─────────────────────────────────────────────────────────────────────

describe('adapter cross-runtime fragment identity', () => {
  it('widget fragment text is byte-identical across the three adapters', () => {
    const enabled = new Set(['widget']);
    const a = adaptForClaudeCode(baseInput({ enabledCapabilities: enabled }));
    const b = adaptForNative(baseInput({ enabledCapabilities: enabled }));
    const c = adaptForCodexProxy(baseInput({ enabledCapabilities: enabled }));

    const fragA = a.compiled.capabilityFragments.find(
      (f) => f.sourceCapability === 'widget',
    );
    const fragB = b.compiled.capabilityFragments.find(
      (f) => f.sourceCapability === 'widget',
    );
    const fragC = c.compiled.capabilityFragments.find(
      (f) => f.sourceCapability === 'widget',
    );
    assert.ok(fragA && fragB && fragC, 'widget fragment missing on some adapter');
    assert.equal(fragA!.text, fragB!.text);
    assert.equal(fragB!.text, fragC!.text);
  });

  it('every live + cross-runtime-supported capability has byte-identical fragment text', () => {
    const liveCapIds = HARNESS_CAPABILITIES.filter(
      (c) =>
        c.status === 'live' &&
        c.exposure.claudecode_sdk.kind !== 'unsupported' &&
        c.exposure.native.kind !== 'unsupported' &&
        c.exposure.codex_proxy.kind !== 'unsupported' &&
        c.systemPromptFragment.length > 0,
    ).map((c) => c.id);
    for (const id of liveCapIds) {
      const enabled = new Set([id]);
      const a = adaptForClaudeCode(baseInput({ enabledCapabilities: enabled }));
      const b = adaptForNative(baseInput({ enabledCapabilities: enabled }));
      const c = adaptForCodexProxy(baseInput({ enabledCapabilities: enabled }));
      const fragA = a.compiled.capabilityFragments.find(
        (f) => f.sourceCapability === id,
      );
      const fragB = b.compiled.capabilityFragments.find(
        (f) => f.sourceCapability === id,
      );
      const fragC = c.compiled.capabilityFragments.find(
        (f) => f.sourceCapability === id,
      );
      assert.ok(
        fragA && fragB && fragC,
        `${id} fragment missing on at least one adapter`,
      );
      assert.equal(fragA!.text, fragB!.text, `${id} drift between claude/native`);
      assert.equal(fragB!.text, fragC!.text, `${id} drift between native/codex`);
    }
  });

  it('widget artifact contract is byte-identical across the three adapters and contains the canonical JSON exactly once', () => {
    const enabled = new Set(['widget']);
    const a = adaptForClaudeCode(baseInput({ enabledCapabilities: enabled }));
    const b = adaptForNative(baseInput({ enabledCapabilities: enabled }));
    const c = adaptForCodexProxy(baseInput({ enabledCapabilities: enabled }));
    const wireA = a.compiled.artifactContracts.find(
      (ac) => ac.sourceCapability === 'widget',
    );
    const wireB = b.compiled.artifactContracts.find(
      (ac) => ac.sourceCapability === 'widget',
    );
    const wireC = c.compiled.artifactContracts.find(
      (ac) => ac.sourceCapability === 'widget',
    );
    assert.ok(wireA && wireB && wireC);
    assert.equal(wireA!.text, WIDGET_WIRE_FORMAT_SPEC);
    assert.equal(wireA!.text, wireB!.text);
    assert.equal(wireB!.text, wireC!.text);

    // Per Phase 2 review invariant #10 — canonical JSON appears once.
    const occurrences = (a.systemPromptAppend.match(
      new RegExp(escapeRegExp(CANONICAL_SHOW_WIDGET_JSON), 'g'),
    ) || []).length;
    assert.equal(occurrences, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. Entry-point cleanliness — three runtime entry points no longer
//    import `compileContext` directly. Drift surface closed.
// ─────────────────────────────────────────────────────────────────────

describe('adapter entry-point cleanliness', () => {
  it('claude-client.ts does NOT import compileContext directly', () => {
    const src = readSource('src/lib/claude-client.ts');
    assert.equal(
      /from\s+['"]@\/lib\/harness\/context-compiler['"]/.test(src),
      false,
      'claude-client.ts should consume the adapter facade, not compileContext directly',
    );
    assert.ok(
      /adaptForClaudeCode/.test(src),
      'claude-client.ts should call adaptForClaudeCode',
    );
  });

  it('builtin-tools/index.ts does NOT import compileContext directly', () => {
    const src = readSource('src/lib/builtin-tools/index.ts');
    assert.equal(
      /from\s+['"]@\/lib\/harness\/context-compiler['"]/.test(src),
      false,
      'builtin-tools/index.ts should consume the adapter facade, not compileContext directly',
    );
    assert.ok(
      /adaptForNative/.test(src),
      'builtin-tools/index.ts should call adaptForNative',
    );
  });

  it('codex/proxy/unified-adapter.ts does NOT import compileContext directly', () => {
    const src = readSource('src/lib/codex/proxy/unified-adapter.ts');
    assert.equal(
      /from\s+['"]@\/lib\/harness\/context-compiler['"]/.test(src),
      false,
      'unified-adapter.ts should consume the adapter facade, not compileContext directly',
    );
    assert.ok(
      /adaptForCodexProxy/.test(src),
      'unified-adapter.ts should call adaptForCodexProxy',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5. Codex proxy MUST consume adapter outputs — no local step-limit
//    constant; PathInput shape carries stopWhen + stepCount from
//    `adapted.*`; bridge.toolNames is no longer the suppression set.
//
//    Phase 5d Phase 3 review fix #1 (2026-05-17). Pre-fix
//    `unified-adapter.ts` declared its own `BUILTIN_BRIDGE_STEP_LIMIT`
//    constant and passed `bridge.toolNames` straight to streamPath /
//    nonStreamPath, leaving the adapter's `stopWhen / stepCount /
//    builtinToolNames` fields half-dead.
// ─────────────────────────────────────────────────────────────────────

describe('Codex proxy — single source for stop / step / builtin tool names', () => {
  function adapterSrc(): string {
    return readSource('src/lib/codex/proxy/unified-adapter.ts');
  }

  it('unified-adapter.ts does NOT declare a local BUILTIN_BRIDGE_STEP_LIMIT constant', () => {
    const src = adapterSrc();
    // Allow the literal to appear in JSDoc that references the
    // compiler's CODEX_BRIDGE_STEP_LIMIT (for context). Forbid an
    // actual `const BUILTIN_BRIDGE_STEP_LIMIT =` declaration.
    assert.equal(
      /^\s*const\s+BUILTIN_BRIDGE_STEP_LIMIT\s*=/m.test(src),
      false,
      'unified-adapter.ts must not keep its own step-limit constant — the value is sourced from adapter.stepCount (compiler-owned CODEX_BRIDGE_STEP_LIMIT)',
    );
  });

  it('streamPath / nonStreamPath callers pass adapted stop/step decisions and the adapter-seeded bridge suppression set', () => {
    const src = adapterSrc();
    assert.match(
      src,
      /availableToolNames:\s*compilerToolNames/,
      'compiler hints must be filtered by the actual bridge and routed MCP surface',
    );
    assert.match(
      src,
      /const bridgeOwnedToolNames = new Set\(\[\s*\.\.\.adapted\.builtinToolNames,\s*\.\.\.bridge\.toolNames,/,
      'the concrete bridge suppression set must be seeded from adapter.builtinToolNames before adding runtime-mounted bridge names',
    );
    assert.match(
      src,
      /streamPath\(\{[\s\S]*?builtinToolNames:\s*bridgeOwnedToolNames[\s\S]*?stopWhen:\s*adapted\.stopWhen[\s\S]*?stepCount:\s*adapted\.stepCount[\s\S]*?\}\)/,
      'streamPath caller must forward adapter outputs (builtinToolNames + stopWhen + stepCount)',
    );
    assert.match(
      src,
      /nonStreamPath\(\{[\s\S]*?builtinToolNames:\s*bridgeOwnedToolNames[\s\S]*?stopWhen:\s*adapted\.stopWhen[\s\S]*?stepCount:\s*adapted\.stepCount[\s\S]*?\}\)/,
      'nonStreamPath caller must forward adapter outputs',
    );
  });

  it('bridge.toolNames is no longer passed straight to streamPath / nonStreamPath', () => {
    const src = adapterSrc();
    // Pre-fix shape was `builtinToolNames: bridge.toolNames`. Forbid
    // it inside PathInput callers — the suppression set must come
    // from the adapter, not from bridge state.
    assert.equal(
      /builtinToolNames:\s*bridge\.toolNames/.test(src),
      false,
      'streamPath / nonStreamPath must NOT receive bridge.toolNames directly — they receive adapter.builtinToolNames (catalog-derived single source)',
    );
  });

  it('PathInput type declares stopWhen + stepCount as adapter-sourced fields', () => {
    const src = adapterSrc();
    assert.match(
      src,
      /interface\s+PathInput\s*\{[\s\S]*?stopWhen:\s*['"]stepCountIs['"]\s*\|\s*['"]never['"][\s\S]*?stepCount:\s*number/,
      'PathInput must declare stopWhen and stepCount fields (forwarded from adapter)',
    );
  });

  it('compiler is the sole owner of CODEX_BRIDGE_STEP_LIMIT (single source)', () => {
    const compilerSrc = readSource('src/lib/harness/context-compiler.ts');
    assert.match(
      compilerSrc,
      /const\s+CODEX_BRIDGE_STEP_LIMIT\s*=\s*8\b/,
      'context-compiler.ts must define CODEX_BRIDGE_STEP_LIMIT as the single source for the Codex bridge step ceiling',
    );
    assert.match(
      compilerSrc,
      /stepCount:\s*CODEX_BRIDGE_STEP_LIMIT/,
      'compiler must feed CODEX_BRIDGE_STEP_LIMIT into the codex_proxy runtimeHints',
    );
  });

  it('adaptForCodexProxy outputs stepCount = compiler CODEX_BRIDGE_STEP_LIMIT (runtime check, capability enabled)', () => {
    const out = adaptForCodexProxy(
      baseInput({ enabledCapabilities: new Set(['widget']) }),
    );
    // Pin the runtime contract: when any capability is enabled, the
    // adapter's stepCount equals the compiler-owned constant. The
    // literal `8` here is the test's expectation of the constant's
    // current value — if that constant changes, this assertion
    // changes alongside the source pin above.
    assert.equal(out.stepCount, 8);
    assert.equal(out.stopWhen, 'stepCountIs');
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
