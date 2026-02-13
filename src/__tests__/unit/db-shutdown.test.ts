/**
 * Unit tests for database graceful shutdown.
 *
 * Run with: npx tsx --test src/__tests__/unit/db-shutdown.test.ts
 *
 * Tests verify that:
 * 1. closeDb() closes the database without errors
 * 2. closeDb() is idempotent (can be called multiple times)
 * 3. getDb() re-opens the database after closeDb()
 * 4. Data persists across close/reopen cycles
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Set a temp data dir before importing db module
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-db-test-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

// Use require to avoid top-level await issues with CJS output
/* eslint-disable @typescript-eslint/no-require-imports */
const { getDb, closeDb, createSession, getSession } = require('../../lib/db') as typeof import('../../lib/db');

describe('closeDb', () => {
  afterEach(() => {
    // Ensure DB is closed after each test
    closeDb();
  });

  it('should close the database without errors', () => {
    // First, ensure DB is open by calling getDb
    const db = getDb();
    assert.ok(db);

    // Close should not throw
    assert.doesNotThrow(() => closeDb());
  });

  it('should be idempotent (safe to call multiple times)', () => {
    getDb(); // open
    closeDb();
    assert.doesNotThrow(() => closeDb()); // second call should be no-op
    assert.doesNotThrow(() => closeDb()); // third call too
  });

  it('should allow re-opening the database after close', () => {
    getDb(); // open
    closeDb(); // close

    // Re-open should work
    const db = getDb();
    assert.ok(db);
  });

  it('should persist data across close/reopen cycles', () => {
    // Create a session
    const session = createSession('Test Session', 'sonnet', '', tmpDir);
    assert.ok(session);
    assert.equal(session.title, 'Test Session');

    const sessionId = session.id;

    // Close and reopen
    closeDb();
    const db = getDb();
    assert.ok(db);

    // Session should still exist
    const retrieved = getSession(sessionId);
    assert.ok(retrieved);
    assert.equal(retrieved!.title, 'Test Session');
  });

  it('should clean up WAL files after close', () => {
    // Force some writes to create WAL
    createSession('WAL Test 1');
    createSession('WAL Test 2');
    createSession('WAL Test 3');

    const dbPath = path.join(tmpDir, 'codepilot.db');
    assert.ok(fs.existsSync(dbPath));

    // Close the database (should checkpoint WAL)
    closeDb();

    // After close, WAL file should either not exist or be empty
    const walPath = dbPath + '-wal';
    const walExists = fs.existsSync(walPath);
    if (walExists) {
      const walSize = fs.statSync(walPath).size;
      assert.equal(walSize, 0, 'WAL file should be empty after graceful close');
    }
  });

  it('cleanup test fixtures', () => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
