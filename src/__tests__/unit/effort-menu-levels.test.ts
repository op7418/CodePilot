/**
 * Phase 0 (2026-07-17) — the effort menu may only offer SOURCED tiers.
 *
 * EffortSelectorDropdown.tsx:36 used to read:
 *   const baseLevels = supportedEffortLevels || ['low','medium','high','xhigh','max'];
 * so any model whose capability discovery returned nothing got a full
 * five-tier ladder invented for it. Picking `xhigh` there was a user-visible
 * lie: the tier had no source and the request didn't carry it. The fallback
 * itself was the bug — absence must hide the control, not fabricate it.
 *
 * `resolveEffortMenuLevels` is the real function the component calls (not a
 * replica), plus a source pin below proving the fallback can't come back.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveEffortMenuLevels,
  toWireEffort,
  resolveEffortAfterModelSwitch,
  resolveModelSwitchEffortEffect,
  resolveComposerEffortDisplay,
} from '@/lib/effort-levels';
import { VENDOR_PRESETS } from '@/lib/provider-catalog';

describe('resolveEffortMenuLevels — no capability source → no menu', () => {
  it('returns null for undefined levels (discovery produced nothing)', () => {
    assert.equal(resolveEffortMenuLevels(undefined), null);
  });

  it('returns null for null levels', () => {
    assert.equal(resolveEffortMenuLevels(null), null);
  });

  it('returns null for an empty array', () => {
    assert.equal(resolveEffortMenuLevels([]), null);
  });

  it('returns null when every entry is undefined (the schema-drift shape)', () => {
    assert.equal(resolveEffortMenuLevels([undefined, undefined]), null);
  });

  it('returns null when entries are only empty/whitespace strings', () => {
    assert.equal(resolveEffortMenuLevels(['', '   ']), null);
  });

  it('never invents the old five-tier ladder for an unknown model', () => {
    for (const input of [undefined, null, [], [undefined]]) {
      assert.equal(
        resolveEffortMenuLevels(input as string[] | undefined),
        null,
        `expected hide, got a menu for ${JSON.stringify(input)}`,
      );
    }
  });
});

describe('toWireEffort — Auto must never reach a provider', () => {
  it('auto → undefined (omit the parameter, use the model default)', () => {
    assert.equal(toWireEffort('auto'), undefined);
  });

  it('a real tier passes through verbatim', () => {
    assert.equal(toWireEffort('max'), 'max');
    assert.equal(toWireEffort('high'), 'high');
  });

  it('empty / missing selection → undefined, not an empty effort', () => {
    for (const input of [undefined, null, '', '   ']) {
      assert.equal(toWireEffort(input), undefined, `expected omit for ${JSON.stringify(input)}`);
    }
  });
});

describe('Kimi for Coding — the Auto/Low/High/Max contract end to end (Phase 1)', () => {
  const kimiLevels = VENDOR_PRESETS.find(p => p.key === 'kimi')
    ?.defaultModels[0].capabilities?.supportedEffortLevels;

  it('the menu the user sees is exactly Auto + Low + High + Max', () => {
    assert.deepEqual(resolveEffortMenuLevels(kimiLevels), ['auto', 'low', 'high', 'max']);
  });

  it('picking Auto sends no effort at all — Kimi applies its own default', () => {
    // `auto` is not a vendor tier; sending it would invent a wire value.
    assert.equal(toWireEffort('auto'), undefined);
  });

  it('picking Max sends max', () => {
    assert.equal(toWireEffort('max'), 'max');
  });

  it('does not expose unsupported medium/xhigh tiers', () => {
    const menu = resolveEffortMenuLevels(kimiLevels) ?? [];
    for (const fake of ['medium', 'xhigh']) {
      assert.ok(!menu.includes(fake), `Kimi menu offers ${fake}, which Kimi does not accept`);
    }
  });
});

describe('send sites route effort through toWireEffort (no inline auto filter)', () => {
  // Phase 1 (2026-07-17): both send paths used to re-spell
  // `x && x !== 'auto' ? x : undefined` inline. Pinned here because a third
  // call site copying the old shape — or dropping the check — is exactly how
  // `effort=auto` would reach a provider.
  const sendSites = [
    'src/components/chat/ChatView.tsx',
    'src/app/chat/page.tsx',
  ];

  for (const site of sendSites) {
    it(`${site} imports and uses toWireEffort`, () => {
      const src = fs.readFileSync(path.join(process.cwd(), site), 'utf8');
      assert.match(src, /toWireEffort/, `${site} must resolve effort through the shared helper`);
      assert.doesNotMatch(
        src,
        /selectedEffort\s*!==\s*'auto'/,
        `${site} still filters the auto sentinel inline`,
      );
    });
  }
});

describe('resolveEffortMenuLevels — sourced levels render with auto first', () => {
  it('prepends auto to real levels', () => {
    assert.deepEqual(resolveEffortMenuLevels(['low', 'medium', 'high']), [
      'auto',
      'low',
      'medium',
      'high',
    ]);
  });

  it('passes xhigh / max through — real tiers are not filtered', () => {
    assert.deepEqual(resolveEffortMenuLevels(['xhigh', 'max']), ['auto', 'xhigh', 'max']);
  });

  it('drops undefined holes but keeps the surrounding real tiers', () => {
    assert.deepEqual(resolveEffortMenuLevels(['low', undefined, 'high']), ['auto', 'low', 'high']);
  });

  it('preserves upstream order (menus read as a ladder, not a set)', () => {
    assert.deepEqual(resolveEffortMenuLevels(['max', 'low']), ['auto', 'max', 'low']);
  });

  it('de-dupes and never doubles auto', () => {
    assert.deepEqual(resolveEffortMenuLevels(['auto', 'low', 'low']), ['auto', 'low']);
  });

  it('a single sourced tier is still a legitimate menu (tier + auto)', () => {
    assert.deepEqual(resolveEffortMenuLevels(['max']), ['auto', 'max']);
  });
});

describe('resolveEffortAfterModelSwitch — drop an unsupported tier back to Auto (s07)', () => {
  const SONNET_46 = ['low', 'medium', 'high', 'max'];        // no xhigh
  const SONNET_5 = ['low', 'medium', 'high', 'xhigh', 'max']; // has xhigh

  it('resets to Auto when the new model drops the selected tier (xhigh → sonnet 4.6)', () => {
    const r = resolveEffortAfterModelSwitch('xhigh', SONNET_46);
    assert.deepEqual(r, { effort: undefined, didReset: true });
  });

  it('keeps the tier when the new model still supports it (xhigh → sonnet 5)', () => {
    const r = resolveEffortAfterModelSwitch('xhigh', SONNET_5);
    assert.deepEqual(r, { effort: 'xhigh', didReset: false });
  });

  it('a plain shared tier survives the switch (high → sonnet 4.6)', () => {
    const r = resolveEffortAfterModelSwitch('high', SONNET_46);
    assert.deepEqual(r, { effort: 'high', didReset: false });
  });

  it('Auto / unset never triggers a reset (already neutral)', () => {
    for (const cur of ['auto', undefined, null, '']) {
      assert.deepEqual(
        resolveEffortAfterModelSwitch(cur, SONNET_46),
        { effort: undefined, didReset: false },
        `auto-ish input ${JSON.stringify(cur)} must not reset`,
      );
    }
  });

  it('a concrete tier resets when the new model has NO sourced effort menu', () => {
    // Model with unknown capability (menu === null): a prior concrete pick
    // cannot be honored, so drop it rather than send an unsupported tier.
    for (const levels of [undefined, null, []]) {
      assert.deepEqual(
        resolveEffortAfterModelSwitch('max', levels),
        { effort: undefined, didReset: true },
        `expected reset when new levels = ${JSON.stringify(levels)}`,
      );
    }
  });

  it('the notice is non-misleading only when a reset actually happened', () => {
    // didReset gates the toast; a kept tier must report didReset=false so no
    // spurious "reset to Auto" message fires on a compatible switch.
    assert.equal(resolveEffortAfterModelSwitch('high', SONNET_5).didReset, false);
    assert.equal(resolveEffortAfterModelSwitch('xhigh', SONNET_46).didReset, true);
  });
});

describe('resolveModelSwitchEffortEffect — clear an illegal transient tier on ANY switch (s07, reviewer fix i31)', () => {
  // Executable equivalent of the effort block BOTH composer entries now apply
  // (ChatView.handleProviderModelChange AND the new-chat page). The reviewer's
  // ruling: clearing an unsupported tier is INDEPENDENT of manual-vs-auto —
  // isAuto only gates the session-pin persist at the call site, never the effort
  // effect. So the same inputs must behave the same whether the switch was a
  // user pick or a silent auto-correct.
  const SONNET_46 = ['low', 'medium', 'high', 'max'];        // no xhigh
  const SONNET_5 = ['low', 'medium', 'high', 'xhigh', 'max']; // has xhigh

  it('(1) switch to a model without the tier → reset + toast', () => {
    const e = resolveModelSwitchEffortEffect('xhigh', SONNET_46);
    assert.deepEqual(e, { resetEffort: true, showResetToast: true });
  });

  it('(2) switch keeping a compatible tier → no reset, no toast', () => {
    assert.deepEqual(
      resolveModelSwitchEffortEffect('xhigh', SONNET_5),
      { resetEffort: false, showResetToast: false });
    // a plain shared tier likewise survives
    assert.deepEqual(
      resolveModelSwitchEffortEffect('high', SONNET_46),
      { resetEffort: false, showResetToast: false });
  });

  it('(3) reset and toast are always in lockstep — never one without the other', () => {
    const cases: Array<[string | undefined | null, string[] | undefined | null]> = [
      ['xhigh', SONNET_46], ['xhigh', SONNET_5],
      ['max', null], ['auto', SONNET_46], [undefined, SONNET_46],
    ];
    for (const [cur, levels] of cases) {
      const e = resolveModelSwitchEffortEffect(cur, levels);
      assert.equal(e.resetEffort, e.showResetToast,
        `reset/toast must match for ${JSON.stringify([cur, levels])}`);
    }
  });

  it('(4) auto-correct ⇔ manual: an unsupported tier is cleared the SAME either way', () => {
    // The old design made isAuto inert here, which let an auto-correct leave an
    // illegal transient tier selected and sendable — the exact inconsistency the
    // reviewer flagged. The effort effect no longer takes isAuto: the same inputs
    // that reset on a manual pick MUST reset on an auto-correct too. (The caller
    // still skips the session-pin persist for isAuto — that's separate.)
    assert.deepEqual(
      resolveModelSwitchEffortEffect('xhigh', SONNET_46),
      { resetEffort: true, showResetToast: true },
      'unsupported tier must clear regardless of how the model changed');
    assert.deepEqual(
      resolveModelSwitchEffortEffect('max', null),
      { resetEffort: true, showResetToast: true },
      'a concrete tier on a no-menu model must clear');
  });

  it('(5) the cleared tier never reaches the wire — send omits effort after a reset', () => {
    // The whole point: after resetEffort, the composer selection is undefined, so
    // the send path (toWireEffort) omits the parameter. Assert the end-to-end
    // consequence, not just the flag.
    const { effort } = resolveEffortAfterModelSwitch('xhigh', SONNET_46);
    assert.equal(effort, undefined);
    assert.equal(toWireEffort(effort), undefined,
      'a reset tier must produce no effort on the wire');
    // a kept tier still sends verbatim
    const kept = resolveEffortAfterModelSwitch('xhigh', SONNET_5);
    assert.equal(toWireEffort(kept.effort), 'xhigh');
  });

  it('Auto / unset never triggers an effect (already neutral)', () => {
    for (const cur of ['auto', undefined, null, '']) {
      assert.deepEqual(
        resolveModelSwitchEffortEffect(cur, SONNET_46),
        { resetEffort: false, showResetToast: false },
        `neutral input ${JSON.stringify(cur)} must not reset`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// s07 reviewer fix (run i31, 2026-07-18) — the FULL composer effort state
// chain, driven through the REAL functions the component + both parents call.
//
// The prior round only tested `resolveModelSwitchEffortEffect` (the reset
// decision) and source order. It never exercised MessageInput's DISPLAY
// resolution (`effortProp ?? localEffort`), where the bug actually lived: a
// parent reset to `undefined` re-surfaced the stale `localEffort`, so the
// button showed `xhigh` while the wire omitted effort. That expression is now
// `resolveComposerEffortDisplay`, so the display is testable as real code.
//
// There is no React renderer in this node:test suite (no jsdom / testing-
// library — see card-primitives.test.ts for the same constraint), so this
// harness models the composer + its parent as a tiny state machine whose every
// decision is a REAL exported helper: the button label comes from
// `resolveComposerEffortDisplay`, the reset from `resolveModelSwitchEffortEffect`,
// the wire from `toWireEffort`. The only modeled glue is React state storage
// (a variable) and a toast counter — not logic. Both composer entries (ChatView
// + new-chat page) route through the identical shared helpers, so one harness
// covers both; the source pins below additionally prove each .tsx wires them.
// ─────────────────────────────────────────────────────────────────────

/**
 * A faithful model of the composer effort loop. `pickEffort` mirrors
 * MessageInput.setSelectedEffort (updates localEffort AND calls onEffortChange,
 * exactly as the component does — so a stale localEffort is present to catch a
 * display regression). `switchModel` mirrors the shared parent handler used by
 * BOTH ChatView and the new-chat page (resolveModelSwitchEffortEffect → clear +
 * one-shot toast, independent of isAuto). `displayed`/`wire` read through the
 * same real resolvers the component + send path use.
 */
function makeComposerHarness() {
  let parentEffort: string | undefined = undefined; // parent selectedEffort state
  let localEffort = 'auto'; // MessageInput internal fallback (stays present)
  let toastCount = 0;
  return {
    // MessageInput.setSelectedEffort(v): setLocalEffort(v) + onEffortChange(v)
    pickEffort(v: string) {
      localEffort = v;
      parentEffort = v; // onEffortChange = parent setSelectedEffort (stores verbatim)
    },
    // parent handleProviderModelChange effort effect (shared by both entries)
    switchModel(levels: readonly (string | null | undefined)[] | null, _opts?: { isAuto?: boolean }) {
      const effect = resolveModelSwitchEffortEffect(parentEffort, levels);
      if (effect.resetEffort) parentEffort = undefined; // setSelectedEffort(undefined)
      if (effect.showResetToast) toastCount += 1;
      // isAuto gates only the session-pin persist (not observable here) — the
      // effort effect above runs regardless, which is the whole point of s07.
    },
    displayed() {
      return resolveComposerEffortDisplay(parentEffort, localEffort, /* isControlled */ true);
    },
    wire() {
      return toWireEffort(parentEffort);
    },
    toastCount() {
      return toastCount;
    },
  };
}

describe('composer effort state chain — reset is observable as Auto (s07 behavior, i31)', () => {
  const SONNET_5_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const SONNET_46_LEVELS = ['low', 'medium', 'high', 'max']; // no xhigh

  // Both real entries share the same helpers; parametrize to document intent.
  for (const entry of ['ChatView (existing session)', 'new-chat page']) {
    it(`${entry}: manual pick xhigh → switch to Sonnet 4.6 → button shows Auto, wire omits effort, toast once`, () => {
      const h = makeComposerHarness();
      h.pickEffort('xhigh');
      assert.equal(h.displayed(), 'xhigh', 'button reflects the manual pick');
      assert.equal(h.wire(), 'xhigh', 'the picked tier reaches the wire');

      h.switchModel(SONNET_46_LEVELS, { isAuto: false }); // manual model switch

      assert.equal(h.displayed(), 'auto',
        'after the reset the button MUST show Auto, not the stale xhigh');
      assert.equal(h.wire(), undefined,
        'the dropped tier must not reach the wire');
      assert.equal(h.toastCount(), 1, 'the sourced notice fires exactly once');
    });

    it(`${entry}: AUTO-CORRECT switch (isAuto) also clears an unsupported tier`, () => {
      const h = makeComposerHarness();
      h.pickEffort('xhigh');
      h.switchModel(SONNET_46_LEVELS, { isAuto: true }); // silent auto-correct
      assert.equal(h.displayed(), 'auto',
        'auto-correct must clear the illegal tier the same as a manual pick');
      assert.equal(h.wire(), undefined);
      assert.equal(h.toastCount(), 1);
    });
  }

  it('a still-supported tier survives a switch (no reset, no toast, no lie)', () => {
    const h = makeComposerHarness();
    h.pickEffort('xhigh');
    h.switchModel(SONNET_5_LEVELS); // xhigh still offered
    assert.equal(h.displayed(), 'xhigh', 'a supported tier stays selected');
    assert.equal(h.wire(), 'xhigh');
    assert.equal(h.toastCount(), 0);
  });

  it('the notice never double-fires: a second unsupported switch after a reset is silent', () => {
    const h = makeComposerHarness();
    h.pickEffort('xhigh');
    h.switchModel(SONNET_46_LEVELS); // reset #1 → toast
    h.switchModel(null); // now Auto; a no-menu model can't reset Auto again
    assert.equal(h.displayed(), 'auto');
    assert.equal(h.wire(), undefined);
    assert.equal(h.toastCount(), 1, 'exactly one toast across the whole sequence');
  });

  it('display regression guard: a stale localEffort must NOT leak through when controlled', () => {
    // This is the precise bug: the parent value is the source of truth. Even
    // with a stale local pick present (as the real component keeps), a controlled
    // undefined MUST render Auto. If resolveComposerEffortDisplay regressed to
    // `controlled ?? local`, this assertion fails.
    assert.equal(resolveComposerEffortDisplay(undefined, 'xhigh', true), 'auto',
      'controlled undefined + stale local xhigh must display Auto');
    assert.equal(resolveComposerEffortDisplay('high', 'xhigh', true), 'high',
      'controlled value wins over any local value');
    // Uncontrolled standalone usage still honors the local value.
    assert.equal(resolveComposerEffortDisplay(undefined, 'xhigh', false), 'xhigh',
      'uncontrolled usage (no onEffortChange) falls back to local');
  });
});

describe('both composer entries wire the s07 effect helper + a sourced notice (source pins)', () => {
  // The helper tests above prove the LOGIC; these pins prove BOTH .tsx entries
  // actually route through it (no JSX transform in this node:test suite, so the
  // wiring is asserted on source — same convention as the codex runtime pins).
  // The reviewer's core gap was that the new-chat page skipped the check
  // entirely, so it is pinned alongside ChatView.
  const entries: Array<[string, string]> = [
    ['ChatView', 'src/components/chat/ChatView.tsx'],
    ['new-chat page', 'src/app/chat/page.tsx'],
  ];
  for (const [label, rel] of entries) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
    it(`${label} applies resolveModelSwitchEffortEffect and clears effort + toast from its result`, () => {
      assert.match(src, /resolveModelSwitchEffortEffect\(/,
        `${label} must consult the shared helper`);
      assert.match(src, /effortEffect\.resetEffort/,
        `${label}: resetEffort must drive setSelectedEffort(undefined)`);
      assert.match(src, /effortEffect\.showResetToast/,
        `${label}: showResetToast must gate the one-shot toast`);
      assert.match(src, /messageInput\.effort\.resetOnModelSwitch/,
        `${label}: the reset must surface a sourced i18n notice, not a hardcoded string`);
    });
    it(`${label} runs the effort clear BEFORE the isAuto persist-skip (so auto-correct still clears)`, () => {
      // Regression pin for the reviewer's finding: if `if (opts?.isAuto) return`
      // came first, an auto-correct would skip the clear. The helper call must
      // precede the isAuto early-return.
      const helperIdx = src.indexOf('resolveModelSwitchEffortEffect(');
      const skipIdx = src.indexOf('opts?.isAuto && !runtimeWasExplicitlySelected) return');
      const effectiveSkipIdx = skipIdx !== -1
        ? skipIdx
        : src.indexOf('opts?.isAuto) return');
      assert.ok(helperIdx !== -1 && effectiveSkipIdx !== -1,
        `${label}: expected both the helper call and the isAuto persist-skip`);
      assert.ok(helperIdx < effectiveSkipIdx,
        `${label}: the effort clear must run before the isAuto persist-skip`);
    });
  }
});

describe('MessageInput feeds the SAME picker capability data to every switch consumer (s07 i31)', () => {
  // The reviewer required both entries validate against the SAME real capability
  // feed. MessageInput resolves the new model's supportedEffortLevels from its
  // own providerGroups/modelOptions (the exact feed the picker renders) and hands
  // it through opts, so ChatView and the new-chat page don't re-derive or miss it.
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/components/chat/MessageInput.tsx'), 'utf8');
  it('enriches onProviderModelChange opts with supportedEffortLevels from the picker feed', () => {
    assert.match(src, /supportedEffortLevels:\s*option\?\.supportedEffortLevels/,
      'the emitted opts must carry the resolved tiers');
    assert.match(src, /findModelOption\(/,
      'the tiers must be resolved from the same modelOptions/providerGroups feed');
  });
  it('routes BOTH the auto-correct effect and the manual picker through the enriching wrapper', () => {
    assert.match(src, /emitProviderModelChange\(currentProviderIdValue, fallback, \{ isAuto: true \}\)/,
      'the auto-correct path must go through the enriching wrapper');
    assert.match(src, /onProviderModelChange=\{emitProviderModelChange\}/,
      'the manual picker must go through the enriching wrapper');
  });
  it('resolves the displayed tier through the CONTROLLED resolver, not `effortProp ?? localEffort`', () => {
    // The behavior test above proves resolveComposerEffortDisplay clears a stale
    // local value; this pin proves the COMPONENT actually calls it (no renderer
    // here). If the old `effortProp ?? localEffort` returned, a parent reset would
    // re-surface the stale pick and the button would lie again.
    assert.match(src, /resolveComposerEffortDisplay\(effortProp,\s*localEffort,\s*isEffortControlled\)/,
      'the displayed tier must come from the controlled resolver');
    assert.doesNotMatch(src, /const selectedEffort = effortProp \?\? localEffort/,
      'the stale-local fallback expression must not return');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Source pin — the helper tests above can't prove the COMPONENT uses it.
// The component is .tsx (no JSX transform in this node:test suite), so we
// pin at the source level, same convention as the codex runtime wiring pins.
// ─────────────────────────────────────────────────────────────────────

describe('EffortSelectorDropdown — hardcoded-fallback regression pin', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../components/chat/EffortSelectorDropdown.tsx'),
    'utf8',
  );

  it("no longer contains the five-tier hardcoded fallback", () => {
    assert.doesNotMatch(
      src,
      /\[\s*'low'\s*,\s*'medium'\s*,\s*'high'\s*,\s*'xhigh'\s*,\s*'max'\s*\]/,
      'the fake-tier fallback must not return',
    );
  });

  it('has no `supportedEffortLevels ||` / `??` defaulting at all', () => {
    assert.doesNotMatch(
      src,
      /supportedEffortLevels\s*(\|\||\?\?)/,
      'defaulting supportedEffortLevels to anything reintroduces unsourced tiers',
    );
  });

  it('resolves levels through resolveEffortMenuLevels', () => {
    assert.match(src, /import\s*\{\s*resolveEffortMenuLevels\s*\}\s*from\s*['"]@\/lib\/effort-levels['"]/);
    assert.match(src, /resolveEffortMenuLevels\(\s*supportedEffortLevels\s*\)/);
  });

  it('renders nothing when the resolver says there is no sourced menu', () => {
    assert.match(
      src,
      /if\s*\(\s*!levels\s*\)\s*return null/,
      'a null resolution must hide the selector',
    );
  });
});
