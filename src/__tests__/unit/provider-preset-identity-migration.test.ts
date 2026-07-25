import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { backfillProviderPresetKeys } from '../../lib/db';

const CODING_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
const TOKEN_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic';
const TEAM_ROLES = JSON.stringify({
  default: 'qwen3.6-plus',
  sonnet: 'qwen3.6-plus',
  opus: 'qwen3.6-plus',
  haiku: 'qwen3.6-plus',
});

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE api_providers (
      id TEXT PRIMARY KEY,
      preset_key TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      role_models_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE provider_models (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      user_edited INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sentinel (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sentinel VALUES ('keep', 'untouched');
  `);
  return db;
}

function insertProvider(db: Database.Database, id: string, baseUrl: string, roles = '{}') {
  db.prepare('INSERT INTO api_providers (id, protocol, base_url, role_models_json) VALUES (?, ?, ?, ?)')
    .run(id, 'anthropic', baseUrl, roles);
}

function insertModel(db: Database.Database, providerId: string, modelId: string, source = 'catalog', userEdited = 0) {
  db.prepare('INSERT INTO provider_models (provider_id, model_id, source, user_edited) VALUES (?, ?, ?, ?)')
    .run(providerId, modelId, source, userEdited);
}

function presetKey(db: Database.Database, id: string): string {
  return (db.prepare('SELECT preset_key FROM api_providers WHERE id = ?').get(id) as { preset_key: string }).preset_key;
}

describe('provider preset identity migration', () => {
  it('backfills only provable Coding Plan and exact legacy Team fingerprints', () => {
    const db = makeDb();
    try {
      insertProvider(db, 'coding', CODING_URL);
      insertProvider(db, 'team-exact', TOKEN_URL, TEAM_ROLES);
      insertProvider(db, 'team-subset', TOKEN_URL, TEAM_ROLES);
      insertProvider(db, 'ambiguous', TOKEN_URL, '{}');

      for (const id of ['qwen3.6-plus', 'glm-5', 'MiniMax-M2.5']) insertModel(db, 'team-exact', id);
      insertModel(db, 'team-exact', 'my-manual-model', 'manual', 0);
      insertModel(db, 'team-exact', 'edited-catalog-row', 'catalog', 1);
      insertModel(db, 'team-subset', 'qwen3.6-plus');

      backfillProviderPresetKeys(db);

      assert.equal(presetKey(db, 'coding'), 'bailian');
      assert.equal(presetKey(db, 'team-exact'), 'bailian-token-plan-cn');
      assert.equal(presetKey(db, 'team-subset'), '', 'a model subset must not prove Team identity');
      assert.equal(presetKey(db, 'ambiguous'), '', 'shared URL without a fingerprint stays unassigned');
      assert.deepEqual(db.prepare('SELECT * FROM sentinel').all(), [{ id: 'keep', value: 'untouched' }]);
    } finally {
      db.close();
    }
  });

  it('is idempotent and never overwrites an explicit identity', () => {
    const db = makeDb();
    try {
      insertProvider(db, 'coding', CODING_URL);
      insertProvider(db, 'explicit', CODING_URL);
      db.prepare("UPDATE api_providers SET preset_key = 'user-selected' WHERE id = 'explicit'").run();

      backfillProviderPresetKeys(db);
      const first = db.prepare('SELECT * FROM api_providers ORDER BY id').all();
      backfillProviderPresetKeys(db);
      const second = db.prepare('SELECT * FROM api_providers ORDER BY id').all();

      assert.deepEqual(second, first);
      assert.equal(presetKey(db, 'explicit'), 'user-selected');
    } finally {
      db.close();
    }
  });
});
