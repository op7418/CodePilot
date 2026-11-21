/**
 * Phase 3 (2026-06-02) — Windows app shell / installer / packaged cache.
 *
 * Three packaged-Windows blockers from preview feedback:
 *   3.1 Duplicate tray / multiple background processes — main process had no
 *       app.requestSingleInstanceLock(); ensureTray()'s `if (tray) return` only
 *       guards within ONE process, so relaunching spun up another process+tray.
 *   3.2 Installer offered no path choice — nsis.allowToChangeInstallationDirectory
 *       was false.
 *   3.3 EPERM mkdir '...\standalone\.next\cache' — the standalone server runs
 *       with cwd inside the read-only install dir; Next's default FileSystemCache
 *       wrote there. Fixed with an in-memory cacheHandler (cache-handler.js).
 *
 * 3.1 / 3.2 / 3.3-no-EPERM are Windows-real-machine verifications (left to the
 * Phase 7 ledger). Here we (a) behaviourally test the cache handler (platform-
 * independent: it must never touch disk) and (b) source/config-pin the wiring.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(__dirname, '../../..');
const requireCjs = createRequire(import.meta.url);

type CacheValue = { value: unknown; lastModified: number } | null;
interface CacheHandlerLike {
  get(key: string): Promise<CacheValue>;
  set(key: string, data: unknown, ctx?: { tags?: string[] }): Promise<void>;
  revalidateTag(tags: string | string[]): Promise<void>;
  resetRequestCache(): void;
}
const InMemoryCacheHandler = requireCjs(
  path.join(root, 'cache-handler.js'),
) as new () => CacheHandlerLike;

function freshHandler(): CacheHandlerLike {
  // The handler shares one store on globalThis; reset it for test isolation.
  delete (globalThis as Record<string, unknown>).__codepilotNextCache;
  return new InMemoryCacheHandler();
}

describe('cache-handler.js — in-memory incremental cache (3.3, no disk writes)', () => {
  it('round-trips a value with a lastModified timestamp', async () => {
    const h = freshHandler();
    await h.set('k1', { kind: 'PAGE', html: '<p>hi</p>' }, {});
    const got = await h.get('k1');
    assert.ok(got, 'set value must be retrievable');
    assert.deepEqual(got?.value, { kind: 'PAGE', html: '<p>hi</p>' });
    assert.equal(typeof got?.lastModified, 'number');
  });

  it('returns null for an unknown key', async () => {
    const h = freshHandler();
    assert.equal(await h.get('missing'), null);
  });

  it('set(key, null) drops the entry', async () => {
    const h = freshHandler();
    await h.set('k', { v: 1 }, {});
    await h.set('k', null, {});
    assert.equal(await h.get('k'), null, 'a null payload must delete the entry');
  });

  it('revalidateTag purges only the keys carrying that tag', async () => {
    const h = freshHandler();
    await h.set('a', { v: 'a' }, { tags: ['t1'] });
    await h.set('b', { v: 'b' }, { tags: ['t2'] });
    await h.set('c', { v: 'c' }, { tags: ['t1', 't2'] });
    await h.revalidateTag('t1');
    assert.equal(await h.get('a'), null, 'a (t1) purged');
    assert.equal(await h.get('c'), null, 'c (t1,t2) purged');
    assert.ok(await h.get('b'), 'b (t2 only) survives');
  });

  it('revalidateTag accepts an array of tags', async () => {
    const h = freshHandler();
    await h.set('a', { v: 'a' }, { tags: ['t1'] });
    await h.set('b', { v: 'b' }, { tags: ['t2'] });
    await h.revalidateTag(['t1', 't2']);
    assert.equal(await h.get('a'), null);
    assert.equal(await h.get('b'), null);
  });

  it('is bounded — evicts the oldest entry past the FIFO cap (cap = 1000)', async () => {
    const h = freshHandler();
    for (let i = 0; i <= 1000; i++) {
      await h.set('cap-' + i, { v: i }, {});
    }
    assert.equal(await h.get('cap-0'), null, 'the oldest entry must be evicted once over the cap');
    assert.ok(await h.get('cap-1000'), 'the newest entry must still be present');
  });

  it('resetRequestCache is a safe no-op', () => {
    const h = freshHandler();
    assert.doesNotThrow(() => h.resetRequestCache());
  });
});

describe('next.config.ts — cacheHandler wiring (3.3)', () => {
  const src = readFileSync(path.join(root, 'next.config.ts'), 'utf8');
  it('points cacheHandler at cache-handler.js', () => {
    assert.match(src, /cacheHandler:\s*path\.join\(import\.meta\.dirname,\s*['"]cache-handler\.js['"]\)/);
  });
  it('disables Next’s default in-memory LRU so our handler owns memory', () => {
    assert.match(src, /cacheMaxMemorySize:\s*0/);
  });
  it('keeps powershell-utils external so Turbopack can build on Windows hosts', () => {
    assert.match(src, /serverExternalPackages:\s*\[[^\]]*'powershell-utils'[^\]]*\]/);
  });
});

describe('electron-builder.yml — installer path choice (3.2)', () => {
  const yml = readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  it('allows choosing the installation directory', () => {
    assert.match(yml, /allowToChangeInstallationDirectory:\s*true/);
  });
  it('keeps oneClick:false (required for the directory page)', () => {
    assert.match(yml, /oneClick:\s*false/);
  });
});

describe('electron/main.ts — single-instance lock (3.1)', () => {
  const src = readFileSync(path.join(root, 'electron/main.ts'), 'utf8');

  it('acquires the single-instance lock', () => {
    assert.match(src, /app\.requestSingleInstanceLock\(\)/);
  });

  it('acquires the lock BEFORE app.whenReady (must run before init)', () => {
    const lockIdx = src.indexOf('requestSingleInstanceLock');
    const readyIdx = src.indexOf('app.whenReady');
    assert.ok(lockIdx !== -1 && readyIdx !== -1, 'both anchors must exist');
    assert.ok(lockIdx < readyIdx, 'the lock must be acquired before app.whenReady()');
  });

  it('surfaces the existing window on a second launch (no new tray/process)', () => {
    assert.match(
      src,
      /second-instance['"]\s*,\s*\(\)\s*=>\s*\{[\s\S]{0,200}showMainWindow\(\)/,
      "the 'second-instance' handler must call showMainWindow(), not spawn another window",
    );
  });

  it('a losing second instance bails out of whenReady init', () => {
    assert.match(
      src,
      /if \(!gotSingleInstanceLock\) return;/,
      'whenReady must early-return for the losing second instance so it does not init tray/server',
    );
  });
});
