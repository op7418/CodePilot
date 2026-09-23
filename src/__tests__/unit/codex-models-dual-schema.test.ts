/**
 * Phase 0 (2026-07-17) — Codex `model/list` schema drift + fail-closed
 * capability parsing.
 *
 * codex-cli 0.144.2 renamed the `supportedReasoningEfforts` element field
 * `effort` → `reasoningEffort`. `models.ts` still read `e.effort`, so against
 * a current binary EVERY tier parsed as `undefined`: models still appeared in
 * the picker, but their capability list became `[undefined, undefined, ...]`.
 * Combined with the selector's old five-tier fallback, the user saw a fully
 * populated effort menu sourced from nothing.
 *
 * These tests pin the dual-schema read and the fail-closed rules around it.
 * POC evidence: docs/research/foundation-experience-refresh-2026-07-17.md
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  listCodexModels,
  getCodexModelForTurn,
  codexUsableContextWindow,
  getCodexContextBudget,
  buildCodexProviderModelGroup,
  getCachedCodexEffortLevels,
  invalidateCodexModelsCache,
} from '@/lib/codex/models';

type EffortEl = Record<string, unknown>;

function modelEntry(over: Record<string, unknown> = {}) {
  return {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    description: 'Frontier',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [] as EffortEl[],
    defaultReasoningEffort: 'low',
    inputModalities: ['text'],
    ...over,
  };
}

/** `capabilities` is typed `Record<string, unknown>` on ProviderModelGroup. */
function effortLevelsOf(caps: Record<string, unknown> | undefined): string[] {
  return (caps?.supportedEffortLevels ?? []) as string[];
}

/** DI seam — a fake app-server returning a canned model/list payload. */
function fakeServer(data: unknown[]) {
  return async () => ({
    client: {
      request: <T>(): Promise<T> => Promise.resolve({ data, nextCursor: null } as T),
    },
  });
}

describe('model/list parsing — dual schema (old { effort } vs new { reasoningEffort })', () => {
  beforeEach(() => invalidateCodexModelsCache());

  it('reads the LEGACY { effort } shape (old codex binary)', async () => {
    const models = await listCodexModels(
      {},
      fakeServer([
        modelEntry({
          supportedReasoningEfforts: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
          defaultReasoningEffort: 'medium',
        }),
      ]),
    );
    assert.deepEqual([...models[0].supportedReasoningEfforts], ['low', 'medium', 'high']);
    assert.equal(models[0].defaultReasoningEffort, 'medium', 'default must survive parsing');
  });

  it('reads the NEW { reasoningEffort } shape (codex-cli 0.144.2) — the drift that broke us', async () => {
    const models = await listCodexModels(
      {},
      fakeServer([
        modelEntry({
          supportedReasoningEfforts: [
            { reasoningEffort: 'low', description: 'Fastest' },
            { reasoningEffort: 'medium', description: '' },
            { reasoningEffort: 'high', description: '' },
            { reasoningEffort: 'xhigh', description: '' },
            { reasoningEffort: 'max', description: '' },
            { reasoningEffort: 'ultra', description: 'Codex-only' },
          ],
          defaultReasoningEffort: 'low',
        }),
      ]),
    );
    assert.deepEqual(
      [...models[0].supportedReasoningEfforts],
      ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      'the real GPT-5.6 Sol tier list must parse — no undefined holes',
    );
    assert.equal(models[0].defaultReasoningEffort, 'low');
    assert.ok(
      !models[0].supportedReasoningEfforts.includes(undefined as unknown as string),
      'no undefined may leak into the capability list',
    );
  });

  it('reads a MIXED response (transitional binary / heterogeneous elements)', async () => {
    const models = await listCodexModels(
      {},
      fakeServer([
        modelEntry({
          supportedReasoningEfforts: [
            { effort: 'low' },
            { reasoningEffort: 'high' },
            // Both present: the new field is authoritative.
            { reasoningEffort: 'max', effort: 'medium' },
          ],
          defaultReasoningEffort: 'high',
        }),
      ]),
    );
    assert.deepEqual([...models[0].supportedReasoningEfforts], ['low', 'high', 'max']);
  });

  it('ALL-EMPTY / junk elements collapse to [] rather than fake tiers', async () => {
    const models = await listCodexModels(
      {},
      fakeServer([
        modelEntry({
          supportedReasoningEfforts: [
            {},
            { effort: '' },
            { reasoningEffort: '   ' },
            { reasoningEffort: null },
            { reasoningEffort: 42 },
            { reasoningEffort: 'wildly-unknown-tier' },
          ],
          defaultReasoningEffort: 'medium',
        }),
      ]),
    );
    assert.deepEqual([...models[0].supportedReasoningEfforts], []);
    assert.equal(
      models[0].defaultReasoningEffort,
      '',
      'a default not present in the parsed list must not be kept',
    );
  });

  it('a missing supportedReasoningEfforts field yields [] (not a crash)', async () => {
    const models = await listCodexModels(
      {},
      fakeServer([modelEntry({ supportedReasoningEfforts: undefined })]),
    );
    assert.deepEqual([...models[0].supportedReasoningEfforts], []);
  });

  it('de-dupes repeated tiers', async () => {
    const models = await listCodexModels(
      {},
      fakeServer([
        modelEntry({
          supportedReasoningEfforts: [{ effort: 'high' }, { reasoningEffort: 'high' }],
          defaultReasoningEffort: 'high',
        }),
      ]),
    );
    assert.deepEqual([...models[0].supportedReasoningEfforts], ['high']);
  });
});

describe('buildCodexProviderModelGroup — fail-closed capability surface', () => {
  beforeEach(() => invalidateCodexModelsCache());

  it('ultra is parsed but does NOT enter the generic effort selector', async () => {
    const group = await buildCodexProviderModelGroup(
      {},
      fakeServer([
        modelEntry({
          supportedReasoningEfforts: [
            { reasoningEffort: 'low' },
            { reasoningEffort: 'high' },
            { reasoningEffort: 'xhigh' },
            { reasoningEffort: 'max' },
            { reasoningEffort: 'ultra' },
          ],
        }),
      ]),
    );
    const levels = effortLevelsOf(group!.models[0].capabilities);
    assert.deepEqual(levels, ['low', 'high', 'xhigh', 'max']);
    assert.ok(!levels.includes('ultra'), 'ultra is Codex-only — not promised in the shared menu');
  });

  it('xhigh / max reach the selector verbatim (not clamped away)', async () => {
    const group = await buildCodexProviderModelGroup(
      {},
      fakeServer([
        modelEntry({
          supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' }],
        }),
      ]),
    );
    assert.deepEqual(effortLevelsOf(group!.models[0].capabilities), ['xhigh', 'max']);
  });

  it('a model with NO recognizable tiers omits supportedEffortLevels and claims no effort support', async () => {
    const group = await buildCodexProviderModelGroup(
      {},
      fakeServer([modelEntry({ supportedReasoningEfforts: [{ reasoningEffort: '' }] })]),
    );
    const caps = group!.models[0].capabilities!;
    assert.equal(caps.supportsEffort, false, 'must not claim effort support with no sourced tiers');
    assert.ok(
      !('supportedEffortLevels' in caps),
      'field must be OMITTED, not [] — absence is what makes the selector hide',
    );
  });

  it('an ultra-only model does not claim generic effort support', async () => {
    const group = await buildCodexProviderModelGroup(
      {},
      fakeServer([modelEntry({ supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] })]),
    );
    assert.equal(group!.models[0].capabilities!.supportsEffort, false);
  });

  it('an empty model/list (logged out / no entitlement) yields no group — no fabricated catalog', async () => {
    const group = await buildCodexProviderModelGroup({}, fakeServer([]));
    assert.equal(group, null);
  });
});

describe('getCachedCodexEffortLevels — per-model allowlist source', () => {
  beforeEach(() => invalidateCodexModelsCache());

  const server = fakeServer([
    modelEntry({
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'max' }],
    }),
  ]);

  it('returns the declared tiers for a warm-cached model, by id', async () => {
    await listCodexModels({}, server); // warm the cache
    assert.deepEqual([...(await getCachedCodexEffortLevels('gpt-5.6-sol'))!], ['low', 'max']);
  });

  it('returns undefined on a COLD cache — no capability info, never a spawn', async () => {
    assert.equal(await getCachedCodexEffortLevels('gpt-5.6-sol'), undefined);
  });

  it('returns undefined for an unknown model / undefined id', async () => {
    await listCodexModels({}, server);
    assert.equal(await getCachedCodexEffortLevels('some-other-model'), undefined);
    assert.equal(await getCachedCodexEffortLevels(undefined), undefined);
  });

  it('invalidation (logout / account switch) drops back to no capability info', async () => {
    await listCodexModels({}, server);
    invalidateCodexModelsCache();
    assert.equal(
      await getCachedCodexEffortLevels('gpt-5.6-sol'),
      undefined,
      'a stale allowlist must not outlive the account it came from',
    );
  });
});


describe('Codex model pagination and vision', () => {
  beforeEach(() => invalidateCodexModelsCache());
  it('finds Astra on page two and deduplicates the catalog', async () => {
    const cursors: unknown[] = [];
    const group = await buildCodexProviderModelGroup({}, async () => ({ client: {
      request: async <T>(_method: string, params: unknown): Promise<T> => {
        const cursor = (params as { cursor?: string }).cursor;
        cursors.push(cursor);
        return (cursor ? { data: [modelEntry(), modelEntry({ id:'gpt-6-astra', model:'gpt-6-astra', inputModalities:['text','image'] })], nextCursor:null }
          : { data:[modelEntry()], nextCursor:'second' }) as T;
      },
    }}));
    assert.deepEqual(cursors,[undefined,'second']);
    assert.equal(group?.models.length,2);
    assert.equal(group?.models.find(m=>m.value==='gpt-6-astra')?.capabilities?.vision,true);
    assert.equal(group?.models[0].capabilities?.vision,false);
  });
  it('rejects repeated cursors rather than hanging or caching a partial catalog', async () => {
    await assert.rejects(listCodexModels({},async()=>({client:{request:async <T>() => ({data:[modelEntry()],nextCursor:'loop'}) as T}})),/pagination/);
  });
});


it('Codex context budget honors effective override, maximum and smaller windows', () => {
  const metadata = {context_window:272000,max_context_window:872000,effective_context_window_percent:95};
  assert.equal(codexUsableContextWindow(metadata),258400);
  assert.equal(codexUsableContextWindow(metadata,1050000),828400);
  assert.equal(codexUsableContextWindow(metadata,100000),95000);
  assert.equal(codexUsableContextWindow({context_window:'unknown'}),null);
  assert.equal(codexUsableContextWindow({...metadata,effective_context_window_percent:200}),null);
});


it('reads project-effective config and same-home catalog for the selected Codex model', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'codex-window-fixture-'));
  const old = process.env.CODEPILOT_CODEX_HOME;
  process.env.CODEPILOT_CODEX_HOME = home;
  try {
    fs.writeFileSync(path.join(home,'models_cache.json'),JSON.stringify({models:[{slug:'gpt-6-astra',context_window:272000,max_context_window:872000}]}));
    const window = await getCodexContextBudget('gpt-6-astra','/fixture/project',async()=>({client:{
      request: async <T>(method: string, params: unknown): Promise<T> => {
        assert.equal(method,'config/read');
        assert.deepEqual(params,{includeLayers:false,cwd:'/fixture/project'});
        return {config:{model_context_window:1000000}} as T;
      },
    }}));
    assert.equal(window,828400);
    assert.equal(await getCodexContextBudget('gpt-6-astra',undefined,async()=>{throw Error('offline')}),null);
  } finally {
    if (old === undefined) delete process.env.CODEPILOT_CODEX_HOME;
    else process.env.CODEPILOT_CODEX_HOME = old;
    fs.rmSync(home,{recursive:true,force:true});
  }
});


describe('execution-only cold model discovery', () => {
  beforeEach(() => invalidateCodexModelsCache());
  it('uses the running client to discover vision and reuses the warm result', async () => {
    const found = await getCodexModelForTurn('gpt-5.6-sol', fakeServer([modelEntry({inputModalities:['text','image']})]));
    assert.equal(found?.inputModalities.includes('image'),true);
    const warm = await getCodexModelForTurn('gpt-5.6-sol', async () => { throw Error('must not discover twice'); });
    assert.equal(warm,found);
  });
  it('keeps capability unknown when the running client cannot discover models', async () => {
    assert.equal(await getCodexModelForTurn('gpt-5.6-sol', async () => { throw Error('offline'); }),undefined);
  });
});
