import Database from 'better-sqlite3';
import { migrateLegacyAssistantMemoryBindings } from './assistant-memory-migration';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import type {
  ChatSession,
  Message,
  SettingsMap,
  TaskItem,
  TaskStatus,
  ApiProvider,
  CreateProviderRequest,
  UpdateProviderRequest,
  MediaJob,
  MediaJobStatus,
  MediaJobItem,
  MediaJobItemStatus,
  MediaContextEvent,
  BatchConfig,
  CustomCliTool,
  ScheduledTask,
  SubagentRunRecord,
  SubagentRunEventRecord,
  StartSubagentRunInput,
  CheckpointSubagentRunInput,
  RecordSubagentRunEventInput,
  SettleSubagentRunInput,
  RuntimeBindingSource,
  RuntimeBindingState,
} from '@/types';
import type { ChannelType, ChannelBinding } from './bridge/types';
import { getLocalDateString, localDayStartAsUTC } from './utils';
import { inferProtocolFromLegacy } from './provider-catalog';
import {
  decryptProviderSecret,
  encryptProviderSecret,
  getProviderSecretEnvironmentStatus,
  providerSecretStorageKind,
} from './provider-secret-crypto';
import type { TitleOrigin } from './conversation-title';
import { normalizePermissionProfile, type SessionPermissionProfile } from './permission/profile';
import type { DelegatedAgentResult, SubagentStatusError } from './subagent-status';
import {
  isLegacyCatalogModelRow,
  type LocalCatalogIdentityRow,
} from './catalog-model-identity';
import { blockDatabaseBootstrap, verifyDatabaseBeforeBootstrap } from './database-integrity';
import {
  clearFreshDatabaseIntent,
  DatabaseStartupError,
  enforceFreshDatabaseIntent,
  classifyDatabaseStartupCode,
  formatDatabaseStartupDiagnostic,
} from './database-recovery';
import { resolveCodePilotDataDir } from './codepilot-data-dir';
import {
  classifyLegacyRuntimeBinding,
  isInternalRuntimeSwitchMarker,
} from './runtime/thread-execution-binding';
import { isRuntimeId, type RuntimeId } from './runtime/runtime-id';

const dataDir = resolveCodePilotDataDir();
const DB_PATH = path.join(dataDir, 'codepilot.db');

interface DatabaseProcessState {
  db: Database.Database | null;
  schemaRevision?: string;
  runtimeOwnerToken?: string;
  startupError?: DatabaseStartupError;
}

interface RuntimeOwnerRecord {
  pid: number;
  token: string;
  claimedAt: string;
}

const DATABASE_PROCESS_STATES_KEY = Symbol.for('codepilot.database-process-states');
const DATABASE_SHUTDOWN_HANDLER_KEY = Symbol.for('codepilot.database-shutdown-handler');
const RUNTIME_OWNER_PATH = `${DB_PATH}.runtime-owner.json`;
const RUNTIME_OWNER_LOCK_PATH = `${DB_PATH}.runtime-owner.lock`;
// Next.js dev hot reload preserves the process-global database handle while
// replacing this module. Keep a code-owned revision beside that handle so a
// newly loaded migration still runs without requiring the user to restart the
// desktop client. Bump this value whenever initDb/migrateDb gains a migration.
const DATABASE_SCHEMA_REVISION = '2026-09-21-assistant-memory-bindings-v1';
const LEGACY_NOTIFICATION_BACKLOG_MARKER = 'notification_delivery_legacy_backlog_v1';
const LEGACY_NOTIFICATION_BACKLOG_MAX_AGE_MS = 60 * 60 * 1000;

function getDatabaseProcessStates(): Map<string, DatabaseProcessState> {
  const target = globalThis as typeof globalThis & {
    [DATABASE_PROCESS_STATES_KEY]?: Map<string, DatabaseProcessState>;
  };
  if (!target[DATABASE_PROCESS_STATES_KEY]) {
    target[DATABASE_PROCESS_STATES_KEY] = new Map();
  }
  return target[DATABASE_PROCESS_STATES_KEY]!;
}

function getDatabaseProcessState(): DatabaseProcessState {
  const states = getDatabaseProcessStates();
  let state = states.get(DB_PATH);
  if (!state) {
    state = { db: null };
    states.set(DB_PATH, state);
  }
  return state;
}

// File-based lock to prevent concurrent migration from multiple Next.js build workers.
// Workers will retry for up to 10 seconds before giving up.
function withMigrationLock(dbInstance: Database.Database, fn: (db: Database.Database) => void): void {
  const lockPath = DB_PATH + '.migration-lock';
  const maxWait = 10_000;
  const start = Date.now();

  while (true) {
    try {
      // O_EXCL fails if file already exists — atomic lock acquisition
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.closeSync(fd);
      try {
        fn(dbInstance);
      } finally {
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      }
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        if (Date.now() - start > maxWait) {
          // Lock held too long — stale lock, force remove and retry once
          try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
          continue;
        }
        // Wait a bit and retry
        const waitMs = 50 + Math.random() * 100;
        const waitUntil = Date.now() + waitMs;
        while (Date.now() < waitUntil) { /* busy wait — better-sqlite3 is sync */ }
        continue;
      }
      throw err;
    }
  }
}

export function getDb(): Database.Database {
  const state = getDatabaseProcessState();
  if (state.startupError) throw state.startupError;
  let openedDatabase = false;
  if (!state.db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // A user-confirmed fresh start is durable across relaunch. Consume it
    // before looking at old paths so an old/corrupt legacy DB cannot be copied
    // back and recreate a blocked → fresh → copy → blocked loop.
    let freshStartIntent = false;
    try {
      freshStartIntent = enforceFreshDatabaseIntent(DB_PATH);
    } catch (error) {
      if (error instanceof DatabaseStartupError) throw error;
      throw new DatabaseStartupError(classifyDatabaseStartupCode(error), 'not_attempted');
    }

    // Migrate from old locations if the new DB doesn't exist yet.
    //
    // CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS (set by the unit-test
    // db-isolation setup, never in prod) skips this copy entirely. This is an
    // independent worker-wide backstop for tests that deliberately re-point
    // the data directory after setup: an empty test root must remain a fresh
    // install, not trigger a copy from the user's real legacy database.
    if (!fs.existsSync(DB_PATH)
      && !freshStartIntent
      && process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS !== '1') {
      const home = os.homedir();
      const oldPaths = [
        // Old Electron userData paths (app.getPath('userData'))
        path.join(home, 'Library', 'Application Support', 'CodePilot', 'codepilot.db'),
        path.join(home, 'Library', 'Application Support', 'codepilot', 'codepilot.db'),
        path.join(home, 'Library', 'Application Support', 'Claude GUI', 'codepilot.db'),
        // Old dev-mode fallback
        path.join(process.cwd(), 'data', 'codepilot.db'),
        // Legacy name
        path.join(home, 'Library', 'Application Support', 'CodePilot', 'claude-gui.db'),
        path.join(home, 'Library', 'Application Support', 'codepilot', 'claude-gui.db'),
      ];
      for (const oldPath of oldPaths) {
        if (fs.existsSync(oldPath)) {
          try {
            fs.copyFileSync(oldPath, DB_PATH);
            // Also copy WAL/SHM if they exist
            if (fs.existsSync(oldPath + '-wal')) fs.copyFileSync(oldPath + '-wal', DB_PATH + '-wal');
            if (fs.existsSync(oldPath + '-shm')) fs.copyFileSync(oldPath + '-shm', DB_PATH + '-shm');
            console.log(`[db] Migrated database from ${oldPath}`);
            break;
          } catch (err) {
            console.warn(`[db] Failed to migrate from ${oldPath}:`, err);
          }
        }
      }
    }

    try {
      if (fs.existsSync(DB_PATH)) verifyDatabaseBeforeBootstrap(DB_PATH);
      state.db = new Database(DB_PATH);
      state.db.pragma('journal_mode = WAL');
      state.db.pragma('busy_timeout = 5000');
      state.db.pragma('foreign_keys = ON');
      openedDatabase = true;
      if (freshStartIntent) clearFreshDatabaseIntent(DB_PATH);
    } catch (error) {
      try { state.db?.close(); } catch { /* failed bootstrap */ }
      state.db = null;
      const startupError = error instanceof DatabaseStartupError
        ? error
        : blockDatabaseBootstrap(DB_PATH, error);
      // A bounded transient lock is retryable inside this utility process;
      // every other startup block remains stable until process restart.
      if (startupError.code !== 'database_busy') state.startupError = startupError;
      throw startupError;
    }
  }

  // A live dev process can keep an older global database handle across HMR.
  // Re-run the idempotent structural bootstrap when the loaded code revision
  // changes; runtime recovery remains tied to opening/owning the process and
  // must not run merely because a route module was hot-reloaded.
  if (openedDatabase || state.schemaRevision !== DATABASE_SCHEMA_REVISION) {
    try {
      withMigrationLock(state.db, initDb);
      state.schemaRevision = DATABASE_SCHEMA_REVISION;
    } catch (error) {
      console.error(formatDatabaseStartupDiagnostic('migration', error));
      try { state.db.close(); } catch { /* migration failed */ }
      state.db = null;
      state.schemaRevision = undefined;
      const classified = classifyDatabaseStartupCode(error);
      const startupError = new DatabaseStartupError(
        classified === 'database_busy' ? 'database_busy' : 'database_migration_failed',
        'not_attempted',
      );
      if (startupError.code !== 'database_busy') state.startupError = startupError;
      throw startupError;
    }
  }
  if (openedDatabase) {
    try {
      runRuntimeStartupRecoveryOnce(state.db);
    } catch (error) {
      console.error(formatDatabaseStartupDiagnostic('runtime_recovery', error));
      try { state.db.close(); } catch { /* runtime recovery failed */ }
      state.db = null;
      state.schemaRevision = undefined;
      const classified = classifyDatabaseStartupCode(error);
      const startupError = new DatabaseStartupError(
        classified === 'database_busy' ? 'database_busy' : 'database_runtime_recovery_failed',
        'not_attempted',
      );
      if (startupError.code !== 'database_busy') state.startupError = startupError;
      throw startupError;
    }
  }
  return state.db;
}

function initDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      sdk_session_id TEXT NOT NULL DEFAULT '',
      runtime_pin TEXT NOT NULL DEFAULT '',
      runtime_binding_state TEXT NOT NULL DEFAULT 'unbound',
      runtime_bound_at TEXT,
      runtime_binding_source TEXT,
      route_revision INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      token_usage TEXT,
      stream_status TEXT NOT NULL DEFAULT 'completed',
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT PRIMARY KEY,
      logical_run_id TEXT NOT NULL DEFAULT '',
      attempt_number INTEGER NOT NULL DEFAULT 1 CHECK(attempt_number > 0),
      parent_session_id TEXT NOT NULL,
      runtime TEXT NOT NULL CHECK(runtime IN ('codepilot_runtime', 'claude_code', 'codex_runtime')),
      tool_name TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT 'Sub-agent',
      provider_id TEXT NOT NULL DEFAULT '',
      requested_model TEXT NOT NULL DEFAULT '',
      effective_provider_id TEXT NOT NULL DEFAULT '',
      effective_model TEXT NOT NULL DEFAULT '',
      workflow_id TEXT NOT NULL DEFAULT '',
      task_key TEXT NOT NULL DEFAULT '',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      dispatch_state TEXT NOT NULL DEFAULT 'executing'
        CHECK(dispatch_state IN ('queued', 'executing', 'settling', 'terminal')),
      prompt TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running'
        CHECK(status IN ('running', 'completed', 'partial', 'failed', 'cancelled', 'timed_out')),
      phase TEXT NOT NULL DEFAULT 'running'
        CHECK(phase IN ('running', 'settling', 'terminal')),
      terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0, 1)),
      result_text TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '',
      current_activity TEXT NOT NULL DEFAULT '',
      last_activity_at TEXT NOT NULL DEFAULT '',
      error_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (parent_session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS subagent_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      logical_run_id TEXT NOT NULL DEFAULT '',
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
      event_type TEXT NOT NULL
        CHECK(event_type IN (
          'started', 'activity', 'tool_started', 'tool_completed',
          'permission_requested', 'permission_resolved', 'partial_result',
          'settling', 'terminal', 'route_warning'
        )),
      activity TEXT NOT NULL DEFAULT '',
      tool_name TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_session_handoffs (
      id TEXT PRIMARY KEY,
      source_session_id TEXT,
      target_session_id TEXT NOT NULL UNIQUE,
      source_boundary_rowid INTEGER NOT NULL CHECK(source_boundary_rowid >= 0),
      source_runtime_id TEXT NOT NULL,
      target_runtime_id TEXT NOT NULL,
      payload_version INTEGER NOT NULL DEFAULT 1,
      payload_json TEXT NOT NULL DEFAULT '{}',
      payload_source TEXT NOT NULL DEFAULT 'recent_transcript'
        CHECK(payload_source IN ('recent_transcript', 'generated_summary', 'user_edited')),
      idempotency_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (source_session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL,
      FOREIGN KEY (target_session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_session_compaction_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'automatic', 'reactive')),
      source_boundary_rowid INTEGER NOT NULL CHECK(source_boundary_rowid >= 0),
      messages_compressed INTEGER NOT NULL CHECK(messages_compressed >= 0),
      estimated_tokens_saved INTEGER NOT NULL CHECK(estimated_tokens_saved >= 0),
      auxiliary_provider_id TEXT,
      auxiliary_model_id TEXT,
      auxiliary_route_source TEXT,
      recreated_underlying_session INTEGER NOT NULL DEFAULT 0 CHECK(recreated_underlying_session IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'anthropic',
      preset_key TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      api_key_ciphertext TEXT NOT NULL DEFAULT '',
      api_key_storage TEXT NOT NULL DEFAULT 'legacy_plaintext',
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      extra_env TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_generations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'image',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '1:1',
      image_size TEXT NOT NULL DEFAULT '1K',
      local_path TEXT NOT NULL DEFAULT '',
      thumbnail_path TEXT NOT NULL DEFAULT '',
      session_id TEXT,
      message_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      favorited INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS media_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','planning','planned','running','paused','completed','cancelled','failed')),
      doc_paths TEXT NOT NULL DEFAULT '[]',
      style_prompt TEXT NOT NULL DEFAULT '',
      batch_config TEXT NOT NULL DEFAULT '{}',
      total_items INTEGER NOT NULL DEFAULT 0,
      completed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS media_job_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      idx INTEGER NOT NULL DEFAULT 0,
      prompt TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '1:1',
      image_size TEXT NOT NULL DEFAULT '1K',
      model TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      source_refs TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','completed','failed','cancelled')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      result_media_generation_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (result_media_generation_id) REFERENCES media_generations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS media_context_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      sync_mode TEXT NOT NULL DEFAULT 'manual'
        CHECK(sync_mode IN ('manual','auto_batch')),
      synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON chat_sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_created
      ON subagent_runs(parent_session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_terminal
      ON subagent_runs(parent_session_id, terminal, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_subagent_run_events_run_sequence
      ON subagent_run_events(run_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_session_handoffs_source_idempotency
      ON chat_session_handoffs(source_session_id, idempotency_key)
      WHERE idempotency_key != '';
    CREATE INDEX IF NOT EXISTS idx_chat_session_compaction_events_session_created
      ON chat_session_compaction_events(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_media_created_at ON media_generations(created_at);
    CREATE INDEX IF NOT EXISTS idx_media_session_id ON media_generations(session_id);
    CREATE INDEX IF NOT EXISTS idx_media_status ON media_generations(status);
    CREATE INDEX IF NOT EXISTS idx_media_jobs_session_id ON media_jobs(session_id);
    CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_media_job_items_job_id ON media_job_items(job_id);
    CREATE INDEX IF NOT EXISTS idx_media_job_items_status ON media_job_items(status);
    CREATE INDEX IF NOT EXISTS idx_media_context_events_job_id ON media_context_events(job_id);

    -- Bridge: IM channel bindings
    CREATE TABLE IF NOT EXISTS channel_bindings (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      codepilot_session_id TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'code' CHECK(mode IN ('code', 'plan', 'ask')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (codepilot_session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
      UNIQUE(channel_type, chat_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_session ON channel_bindings(codepilot_session_id);
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_lookup ON channel_bindings(channel_type, chat_id);

    -- Bridge: polling offset watermarks per adapter
    CREATE TABLE IF NOT EXISTS channel_offsets (
      channel_type TEXT PRIMARY KEY,
      offset_value TEXT NOT NULL DEFAULT '0',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Bridge: idempotent message dedup
    CREATE TABLE IF NOT EXISTS channel_dedupe (
      dedup_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_dedupe_expires ON channel_dedupe(expires_at);

    -- Bridge: outbound message references (for editing/deleting sent messages)
    CREATE TABLE IF NOT EXISTS channel_outbound_refs (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      codepilot_session_id TEXT NOT NULL,
      platform_message_id TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'response',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_refs_session ON channel_outbound_refs(codepilot_session_id);

    -- Bridge: audit log
    CREATE TABLE IF NOT EXISTS channel_audit_logs (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      message_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_chat ON channel_audit_logs(channel_type, chat_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON channel_audit_logs(created_at);

    -- Bridge: permission request → IM message links
    CREATE TABLE IF NOT EXISTS channel_permission_links (
      id TEXT PRIMARY KEY,
      permission_request_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      tool_name TEXT NOT NULL DEFAULT '',
      suggestions TEXT NOT NULL DEFAULT '',
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_perm_links_request ON channel_permission_links(permission_request_id);
  `);

  // Harness Home Program B. One idempotent additive schema function serves
  // both clean bootstrap and on-touch upgrade so the two shapes cannot drift.
  migrateAssetLibrarySchema(db);

  // Run migrations for existing databases
  migrateDb(db);
  migrateLegacyAssistantMemoryBindings(db);
}

/** Safely add a column — ignores "duplicate column name" errors from concurrent workers. */
function safeAddColumn(db: Database.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('duplicate column name')) return;
    throw err;
  }
}

function migrateRuntimeBindingRows(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, runtime_pin, sdk_session_id, codex_thread_id,
           runtime_binding_state, runtime_binding_source
    FROM chat_sessions
    WHERE runtime_binding_state = 'unbound'
      AND runtime_binding_source IS NULL
  `).all() as Array<{
    id: string;
    runtime_pin: string;
    sdk_session_id: string;
    codex_thread_id: string;
    runtime_binding_state: RuntimeBindingState;
    runtime_binding_source: RuntimeBindingSource | null;
  }>;
  if (rows.length === 0) return;

  const messageStmt = db.prepare(`
    SELECT content
    FROM messages
    WHERE session_id = ?
      AND role IN ('user', 'assistant')
    ORDER BY rowid ASC
  `);
  const updateStmt = db.prepare(`
    UPDATE chat_sessions
    SET runtime_binding_state = ?,
        runtime_pin = ?,
        runtime_binding_source = ?,
        runtime_bound_at = NULL,
        route_revision = 0
    WHERE id = ?
      AND runtime_binding_state = 'unbound'
      AND runtime_binding_source IS NULL
  `);

  const migrate = db.transaction(() => {
    for (const row of rows) {
      const messages = messageStmt.all(row.id) as Array<{ content: string }>;
      const hasRealExecutionMessage = messages.some(message => {
        const content = typeof message.content === 'string' ? message.content.trim() : '';
        return content.length > 0 && !isInternalRuntimeSwitchMarker(content);
      });
      const decision = classifyLegacyRuntimeBinding({
        runtimePin: row.runtime_pin,
        sdkSessionId: row.sdk_session_id,
        codexThreadId: row.codex_thread_id,
        hasRealExecutionMessage,
      });
      if (decision.state === 'unbound') continue;
      updateStmt.run(
        decision.state,
        decision.runtimeId ?? '',
        decision.source ?? null,
        row.id,
      );
    }
  });
  migrate();
}

function migrateDb(db: Database.Database): void {
  migrateAssetLibrarySchema(db);
  const columns = db.prepare("PRAGMA table_info(chat_sessions)").all() as { name: string }[];
  const colNames = columns.map(c => c.name);

  if (!colNames.includes('model')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('system_prompt')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('sdk_session_id')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN sdk_session_id TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('project_name')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN project_name TEXT NOT NULL DEFAULT ''");
    // Backfill project_name from working_directory for existing rows
    db.exec(`
      UPDATE chat_sessions
      SET project_name = CASE
        WHEN working_directory != '' THEN REPLACE(REPLACE(working_directory, RTRIM(working_directory, REPLACE(working_directory, '/', '')), ''), '/', '')
        ELSE ''
      END
      WHERE project_name = ''
    `);
  }
  if (!colNames.includes('status')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!colNames.includes('mode')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'code'");
  }
  if (!colNames.includes('provider_name')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN provider_name TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('provider_id')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''");
  }
  // Phase 2 Step 2 (2026-05-06): per-session execution-engine pin so
  // chats stop drifting when the user changes the global agent_runtime
  // setting. Empty string = "follow global"; 'claude_code' /
  // 'codepilot_runtime' = "this session is pinned to that runtime".
  // The send route / streamClaude / picker hook will be migrated to
  // read this in subsequent Phase 2 steps; this column is the data-
  // layer prerequisite. See docs/exec-plans/active/refactor-closeout.md
  // Phase 2 Step 2 + src/__tests__/unit/session-runtime-immunity.test.ts.
  if (!colNames.includes('runtime_pin')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN runtime_pin TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('runtime_binding_state')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN runtime_binding_state TEXT NOT NULL DEFAULT 'unbound'");
  }
  if (!colNames.includes('runtime_bound_at')) {
    safeAddColumn(db, 'ALTER TABLE chat_sessions ADD COLUMN runtime_bound_at TEXT');
  }
  if (!colNames.includes('runtime_binding_source')) {
    safeAddColumn(db, 'ALTER TABLE chat_sessions ADD COLUMN runtime_binding_source TEXT');
  }
  if (!colNames.includes('route_revision')) {
    safeAddColumn(db, 'ALTER TABLE chat_sessions ADD COLUMN route_revision INTEGER NOT NULL DEFAULT 0');
  }
  // Phase 5 Phase 3 (2026-05-13) — Codex Runtime thread/turn ids.
  // Codex's `thread/resume` requires the original `threadId`; we
  // persist it per chat session so reload / cross-session resume
  // works. The runtime-side session ref flows through
  // src/lib/runtime/session-store.ts — UI / API code never reads
  // `codex_thread_id` directly.
  if (!colNames.includes('codex_thread_id')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN codex_thread_id TEXT NOT NULL DEFAULT ''");
  }
  // Phase 5b (2026-05-15) — Codex Runtime threads are provider-bound:
  // `thread/start` injects `model_providers.codepilot_proxy` for the
  // *targeted* CodePilot provider, so the thread can only safely
  // resume under that same provider. If the user switches provider
  // mid-chat, the runtime needs to detect the mismatch and start a
  // fresh thread instead of resuming under wrong credentials. Track
  // the provider id the thread was bound to at start time alongside
  // the thread id itself.
  if (!colNames.includes('codex_thread_provider_id')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN codex_thread_provider_id TEXT NOT NULL DEFAULT ''");
  }
  // Phase 8 Phase 2 (2026-05-27) — fingerprint of the MCP config the codex
  // thread was started with. A resume whose current MCP fingerprint differs
  // starts a fresh thread instead of resuming with a stale tool set.
  if (!colNames.includes('codex_thread_mcp_fingerprint')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN codex_thread_mcp_fingerprint TEXT NOT NULL DEFAULT ''");
  }
  // Runtime ownership migration must run only after both native Runtime refs
  // and every binding column exist. It is conservative and idempotent: rows
  // without proof remain unbound; ambiguous started rows fail closed.
  migrateRuntimeBindingRows(db);
  if (!colNames.includes('sdk_cwd')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN sdk_cwd TEXT NOT NULL DEFAULT ''");
    // Backfill sdk_cwd from working_directory for existing sessions
    db.exec("UPDATE chat_sessions SET sdk_cwd = working_directory WHERE sdk_cwd = '' AND working_directory != ''");
  }
  if (!colNames.includes('runtime_status')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN runtime_status TEXT NOT NULL DEFAULT 'idle'");
  }
  if (!colNames.includes('runtime_updated_at')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN runtime_updated_at TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('runtime_error')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN runtime_error TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('permission_profile')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN permission_profile TEXT NOT NULL DEFAULT 'default'");
  }
  if (!colNames.includes('title_origin')) {
    // Provenance for `title` — decides who is allowed to overwrite it later
    // (see TitleOrigin in lib/conversation-title.ts). Added with DEFAULT ''
    // rather than a real origin so existing rows land in a "not yet
    // classified" state that the backfill below can find and re-decide;
    // ALTER ... DEFAULT 'placeholder' would silently stamp every legacy row
    // as overwritable, which is exactly the wrong direction to fail.
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN title_origin TEXT NOT NULL DEFAULT ''");
  }
  // Backfill, OUTSIDE the ADD COLUMN guard on purpose: ALTER and UPDATE are two
  // statements, and a crash between them used to leave every legacy row stuck
  // at '' forever — the next boot saw the column present and skipped the fill.
  // `WHERE title_origin = ''` makes this re-entrant and a no-op once done; no
  // insert path ever writes '', so an empty origin can only mean "unclassified".
  // Conservative on purpose:
  //   'New Chat' / '' → 'placeholder': never had a real title, so the next
  //     real user message should fill in a fallback (the whole point).
  //   anything else   → 'manual': the row predates provenance, so we CANNOT
  //     tell a user's hand-typed rename from an old auto-truncation. Both
  //     look like plain text. Guessing 'fallback' would let Phase 2's
  //     generator silently rename a session the user deliberately named —
  //     breaking "manual is never overwritten", the one promise this whole
  //     feature rests on. 'manual' is the safe wrong answer: worst case a
  //     legacy session keeps its current (already user-visible, already
  //     accepted) title forever instead of gaining a semantic one.
  db.prepare(
    `UPDATE chat_sessions
        SET title_origin = CASE WHEN title = '' OR title = 'New Chat' THEN 'placeholder' ELSE 'manual' END
      WHERE title_origin = ''`
  ).run();
  if (!colNames.includes('context_summary')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN context_summary TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('context_summary_updated_at')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN context_summary_updated_at TEXT NOT NULL DEFAULT ''");
  }
  // Coverage boundary (legacy, timestamp-based): created_at string of the
  // last covered message. Superseded by context_summary_boundary_rowid
  // because second-precision wall-clock timestamps can't distinguish a
  // last-compressed message from a first-kept message written in the same
  // second. Kept as a column for migration / UI-debug compatibility; NO
  // CODE PATH should read or write it for filtering decisions.
  if (!colNames.includes('context_summary_boundary_at')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN context_summary_boundary_at TEXT NOT NULL DEFAULT ''");
  }
  // Coverage boundary (authoritative): SQLite rowid of the last message
  // actually covered by the current summary. rowid is monotonic per insert,
  // so it can disambiguate same-second writes the timestamp column cannot.
  // 0 = "no boundary" (legacy rows, reactive-compact paths with no DB rowid
  // metadata, sessions whose summary predates this column). Filter passes
  // history through unchanged when boundaryRowid is 0.
  if (!colNames.includes('context_summary_boundary_rowid')) {
    safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN context_summary_boundary_rowid INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_runtime_status ON chat_sessions(runtime_status)");

  // Migrate is_active provider to default_provider_id setting
  const defaultProviderSetting = db.prepare("SELECT value FROM settings WHERE key = 'default_provider_id'").get() as { value: string } | undefined;
  if (!defaultProviderSetting) {
    const activeProvider = db.prepare('SELECT id FROM api_providers WHERE is_active = 1 LIMIT 1').get() as { id: string } | undefined;
    if (activeProvider) {
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('default_provider_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(activeProvider.id);
    }
  }

  const msgColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const msgColNames = msgColumns.map(c => c.name);

  if (!msgColNames.includes('token_usage')) {
    safeAddColumn(db, "ALTER TABLE messages ADD COLUMN token_usage TEXT");
  }

  if (!msgColNames.includes('is_heartbeat_ack')) {
    safeAddColumn(db, "ALTER TABLE messages ADD COLUMN is_heartbeat_ack INTEGER NOT NULL DEFAULT 0");
  }

  // Durable assistant-stream checkpoint lifecycle. Existing rows are complete
  // transcripts, so the conservative migration default is `completed`.
  // In-flight collector rows explicitly opt into `streaming`; startup recovery
  // below converts only those rows to `interrupted`.
  if (!msgColNames.includes('stream_status')) {
    safeAddColumn(db, "ALTER TABLE messages ADD COLUMN stream_status TEXT NOT NULL DEFAULT 'completed'");
  }

  migrateSubagentRunSchema(db);

  // Ensure tasks table exists for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
  `);

  // Add source column to tasks table (user vs sdk)
  const taskColumns = db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const taskColNames = taskColumns.map(c => c.name);
  if (!taskColNames.includes('source')) {
    safeAddColumn(db, "ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
  }
  if (!taskColNames.includes('sort_order')) {
    safeAddColumn(db, "ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
  }

  // Ensure api_providers table exists for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'anthropic',
      preset_key TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      api_key_ciphertext TEXT NOT NULL DEFAULT '',
      api_key_storage TEXT NOT NULL DEFAULT 'legacy_plaintext',
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      extra_env TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Add provider fields. preset_key is the stable product identity; URL and
  // protocol are insufficient because multiple Qwen Token Plan products share
  // the same endpoint.
  {
    const providerCols = db.prepare("PRAGMA table_info(api_providers)").all() as { name: string }[];
    const provColNames = providerCols.map(c => c.name);
    if (!provColNames.includes('preset_key')) {
      safeAddColumn(db, "ALTER TABLE api_providers ADD COLUMN preset_key TEXT NOT NULL DEFAULT ''");
    }
    if (!provColNames.includes('protocol')) {
      safeAddColumn(db, "ALTER TABLE api_providers ADD COLUMN protocol TEXT NOT NULL DEFAULT ''");
    }
    if (!provColNames.includes('headers_json')) {
      safeAddColumn(db, "ALTER TABLE api_providers ADD COLUMN headers_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!provColNames.includes('env_overrides_json')) {
      safeAddColumn(db, "ALTER TABLE api_providers ADD COLUMN env_overrides_json TEXT NOT NULL DEFAULT ''");
    }
    if (!provColNames.includes('role_models_json')) {
      safeAddColumn(db, "ALTER TABLE api_providers ADD COLUMN role_models_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!provColNames.includes('options_json')) {
      safeAddColumn(db, "ALTER TABLE api_providers ADD COLUMN options_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!provColNames.includes('api_key_ciphertext')) {
      safeAddColumn(db, "ALTER TABLE api_providers ADD COLUMN api_key_ciphertext TEXT NOT NULL DEFAULT ''");
    }
    if (!provColNames.includes('api_key_storage')) {
      safeAddColumn(db, "ALTER TABLE api_providers ADD COLUMN api_key_storage TEXT NOT NULL DEFAULT 'legacy_plaintext'");
    }
  }

  // Create provider_models table
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      upstream_model_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      variants_json TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL DEFAULT 'manual',
      last_refreshed_at TEXT,
      user_edited INTEGER NOT NULL DEFAULT 0,
      enable_source TEXT NOT NULL DEFAULT 'recommended',
      FOREIGN KEY (provider_id) REFERENCES api_providers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_provider_models_provider_id ON provider_models(provider_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_models_provider_model ON provider_models(provider_id, model_id);
  `);

  // Backfill columns for databases that existed before the source/refresh
  // tracking migration. Keeps untouched user data — pre-existing rows default
  // to source='manual' since we can't retroactively know if they were
  // discovered or hand-entered.
  const provModelCols = db.prepare("PRAGMA table_info(provider_models)").all() as Array<{ name: string }>;
  const provModelColNames = new Set(provModelCols.map(c => c.name));
  if (!provModelColNames.has('source')) {
    db.exec("ALTER TABLE provider_models ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  }
  if (!provModelColNames.has('last_refreshed_at')) {
    db.exec("ALTER TABLE provider_models ADD COLUMN last_refreshed_at TEXT");
  }
  if (!provModelColNames.has('user_edited')) {
    db.exec("ALTER TABLE provider_models ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0");
  }
  if (!provModelColNames.has('enable_source')) {
    // Pre-existing rows: those with user_edited=1 are user choices we
    // must respect — backfill to 'manual_enabled' / 'manual_hidden' so
    // future refreshes don't flip them. Pristine rows backfill to
    // 'recommended' (their enabled state was set by the system).
    db.exec("ALTER TABLE provider_models ADD COLUMN enable_source TEXT NOT NULL DEFAULT 'recommended'");
    db.exec(`UPDATE provider_models SET enable_source = CASE
        WHEN user_edited = 1 AND enabled = 1 THEN 'manual_enabled'
        WHEN user_edited = 1 AND enabled = 0 THEN 'manual_hidden'
        ELSE 'recommended'
      END`);
  }

  // Stable preset identity migration. Only rows whose identity is provable
  // are backfilled. Token Plan personal/team share one URL, so an uncertain
  // legacy row deliberately keeps preset_key='' and is surfaced for user
  // confirmation instead of inheriting catalog array order.
  backfillProviderPresetKeys(db);

  // Ensure media_generations table exists for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_generations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'image',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
      provider TEXT NOT NULL DEFAULT 'gemini',
      model TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '1:1',
      image_size TEXT NOT NULL DEFAULT '1K',
      local_path TEXT NOT NULL DEFAULT '',
      thumbnail_path TEXT NOT NULL DEFAULT '',
      session_id TEXT,
      message_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      favorited INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS media_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_media_created_at ON media_generations(created_at);
    CREATE INDEX IF NOT EXISTS idx_media_session_id ON media_generations(session_id);
    CREATE INDEX IF NOT EXISTS idx_media_status ON media_generations(status);
  `);

  // Ensure media_jobs tables exist for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','planning','planned','running','paused','completed','cancelled','failed')),
      doc_paths TEXT NOT NULL DEFAULT '[]',
      style_prompt TEXT NOT NULL DEFAULT '',
      batch_config TEXT NOT NULL DEFAULT '{}',
      total_items INTEGER NOT NULL DEFAULT 0,
      completed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS media_job_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      idx INTEGER NOT NULL DEFAULT 0,
      prompt TEXT NOT NULL DEFAULT '',
      aspect_ratio TEXT NOT NULL DEFAULT '1:1',
      image_size TEXT NOT NULL DEFAULT '1K',
      model TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      source_refs TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','completed','failed','cancelled')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      result_media_generation_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
      FOREIGN KEY (result_media_generation_id) REFERENCES media_generations(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS media_context_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      sync_mode TEXT NOT NULL DEFAULT 'manual'
        CHECK(sync_mode IN ('manual','auto_batch')),
      synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_jobs_session_id ON media_jobs(session_id);
    CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_media_job_items_job_id ON media_job_items(job_id);
    CREATE INDEX IF NOT EXISTS idx_media_job_items_status ON media_job_items(status);
    CREATE INDEX IF NOT EXISTS idx_media_context_events_job_id ON media_context_events(job_id);
  `);

  // Add favorited column to media_generations if missing
  try {
    safeAddColumn(db, "ALTER TABLE media_generations ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }

  // Create session_runtime_locks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_runtime_locks (
      session_id TEXT PRIMARY KEY,
      lock_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_locks_expires_at ON session_runtime_locks(expires_at);
  `);

  // Create permission_requests table
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_requests (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL DEFAULT '',
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      decision_reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('pending','allow','deny','timeout','aborted')),
      updated_permissions TEXT NOT NULL DEFAULT '[]',
      updated_input TEXT,
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_permission_session_status ON permission_requests(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_permission_expires_at ON permission_requests(expires_at);
  `);

  // Migrate existing settings to a default provider if api_providers is empty
  const providerCount = db.prepare('SELECT COUNT(*) as count FROM api_providers').get() as { count: number };
  if (providerCount.count === 0) {
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_auth_token'").get() as { value: string } | undefined;
    const baseUrlRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_base_url'").get() as { value: string } | undefined;
    if (tokenRow || baseUrlRow) {
      const id = crypto.randomBytes(16).toString('hex');
      const now = new Date().toISOString().replace('T', ' ').split('.')[0];
      const storedSecret = encodeProviderSecret(id, tokenRow?.value || '');
      db.prepare(
        'INSERT INTO api_providers (id, name, provider_type, base_url, api_key, api_key_ciphertext, api_key_storage, is_active, sort_order, extra_env, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, 'Default', 'anthropic', baseUrlRow?.value || '', storedSecret.plaintext, storedSecret.ciphertext, storedSecret.storage, 1, 0, '{}', 'Migrated from settings', now, now);
    }
  }

  migrateProviderSecrets(db);

  // Ensure bridge tables exist for databases created before bridge feature
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_bindings (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      codepilot_session_id TEXT NOT NULL,
      sdk_session_id TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'code' CHECK(mode IN ('code', 'plan', 'ask')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (codepilot_session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
      UNIQUE(channel_type, chat_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_session ON channel_bindings(codepilot_session_id);
    CREATE INDEX IF NOT EXISTS idx_channel_bindings_lookup ON channel_bindings(channel_type, chat_id);

    CREATE TABLE IF NOT EXISTS channel_offsets (
      channel_type TEXT PRIMARY KEY,
      offset_value TEXT NOT NULL DEFAULT '0',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channel_dedupe (
      dedup_key TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_dedupe_expires ON channel_dedupe(expires_at);

    CREATE TABLE IF NOT EXISTS channel_outbound_refs (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      codepilot_session_id TEXT NOT NULL,
      platform_message_id TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'response',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_refs_session ON channel_outbound_refs(codepilot_session_id);

    CREATE TABLE IF NOT EXISTS channel_audit_logs (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      message_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_chat ON channel_audit_logs(channel_type, chat_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON channel_audit_logs(created_at);

    CREATE TABLE IF NOT EXISTS channel_permission_links (
      id TEXT PRIMARY KEY,
      permission_request_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      tool_name TEXT NOT NULL DEFAULT '',
      suggestions TEXT NOT NULL DEFAULT '',
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_perm_links_request ON channel_permission_links(permission_request_id);
  `);

  // Migrate channel_permission_links for databases created before these columns were added
  const permLinkCols = db.prepare("PRAGMA table_info(channel_permission_links)").all() as { name: string }[];
  const permLinkColNames = permLinkCols.map(c => c.name);
  if (permLinkColNames.length > 0 && !permLinkColNames.includes('tool_name')) {
    safeAddColumn(db, "ALTER TABLE channel_permission_links ADD COLUMN tool_name TEXT NOT NULL DEFAULT ''");
  }
  if (permLinkColNames.length > 0 && !permLinkColNames.includes('suggestions')) {
    safeAddColumn(db, "ALTER TABLE channel_permission_links ADD COLUMN suggestions TEXT NOT NULL DEFAULT ''");
  }
  if (permLinkColNames.length > 0 && !permLinkColNames.includes('resolved')) {
    safeAddColumn(db, "ALTER TABLE channel_permission_links ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0");
  }

  // Add provider_id to channel_bindings for per-binding provider override
  const bindingCols = db.prepare("PRAGMA table_info(channel_bindings)").all() as { name: string }[];
  if (bindingCols.length > 0 && !bindingCols.map(c => c.name).includes('provider_id')) {
    safeAddColumn(db, "ALTER TABLE channel_bindings ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''");
  }

  // Channel configs table (structured config for channel plugins)
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_configs (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT 'default',
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(channel_type, account_id)
    );
  `);

  // WeChat: bot accounts for multi-account support
  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_accounts (
      account_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      cdn_base_url TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // WeChat: per-peer context token persistence
  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_context_tokens (
      account_id TEXT NOT NULL,
      peer_user_id TEXT NOT NULL,
      context_token TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(account_id, peer_user_id)
    );
  `);

  // CLI tools: user-added custom tools
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_tools_custom (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      bin_path TEXT NOT NULL,
      bin_name TEXT NOT NULL DEFAULT '',
      version TEXT,
      install_method TEXT NOT NULL DEFAULT 'unknown',
      install_package TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // CLI tools: persisted AI-generated descriptions
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_tool_descriptions (
      tool_id TEXT PRIMARY KEY,
      description_zh TEXT NOT NULL DEFAULT '',
      description_en TEXT NOT NULL DEFAULT '',
      structured_json TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration: add structured_json column if missing
  {
    const descCols = db.prepare("PRAGMA table_info(cli_tool_descriptions)").all() as { name: string }[];
    if (!descCols.some(c => c.name === 'structured_json')) {
      safeAddColumn(db, "ALTER TABLE cli_tool_descriptions ADD COLUMN structured_json TEXT NOT NULL DEFAULT ''");
    }
  }

  // Migration: add install_method column to cli_tools_custom
  {
    const customCols = db.prepare("PRAGMA table_info(cli_tools_custom)").all() as { name: string }[];
    if (!customCols.some(c => c.name === 'install_method')) {
      safeAddColumn(db, "ALTER TABLE cli_tools_custom ADD COLUMN install_method TEXT NOT NULL DEFAULT 'unknown'");
    }
    if (!customCols.some(c => c.name === 'install_package')) {
      safeAddColumn(db, "ALTER TABLE cli_tools_custom ADD COLUMN install_package TEXT NOT NULL DEFAULT ''");
    }
  }

  // Migration: backfill empty protocol for legacy custom providers using
  // URL-based inference.
  //
  // History (2026-06-09): this block previously also ran
  //   DELETE FROM api_providers WHERE protocol = 'openai-compatible'
  // from the era when the app couldn't reach OpenAI-compatible endpoints.
  // That path is now supported (CodePilot + Codex runtimes via the
  // @ai-sdk/openai chat-completions wire), and deleting user-created rows in a
  // migration violates the no-destructive-migration rule. The DELETE is
  // removed so valid openai-compatible providers survive restarts. (Rows the
  // old DELETE already removed are gone — not recoverable — but no newly
  // created provider will be silently wiped.)
  try {
    const providerCols = db.prepare("PRAGMA table_info(api_providers)").all() as { name: string }[];
    if (providerCols.some(c => c.name === 'protocol')) {
      // Backfill empty protocol for legacy custom providers — infer from base_url.
      // These are valid Anthropic-compatible providers (GLM, Kimi, MiniMax, etc.)
      // that were created before the protocol column existed.
      const legacyCustom = db.prepare(
        "SELECT id, base_url FROM api_providers WHERE provider_type = 'custom' AND (protocol = '' OR protocol IS NULL)"
      ).all() as { id: string; base_url: string }[];
      if (legacyCustom.length > 0) {
        // Use the top-level static import; no circular-import risk since
        // provider-catalog doesn't depend on db. The previous dynamic
        // require tripped Turbopack's NFT into tracing the whole project.
        const updateStmt = db.prepare("UPDATE api_providers SET protocol = ? WHERE id = ?");
        for (const row of legacyCustom) {
          const protocol = inferProtocolFromLegacy('custom', row.base_url || '', '');
          updateStmt.run(protocol, row.id);
        }
      }
    }
  } catch { /* table may not exist yet */ }

  // Ensure scheduled_tasks table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron', 'interval', 'once')),
      schedule_value TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'ai_task' CHECK(kind IN ('reminder', 'ai_task')),
      next_run TEXT NOT NULL,
      last_run TEXT,
      last_status TEXT CHECK(last_status IN ('success', 'error', 'skipped', 'running')),
      last_error TEXT,
      last_result TEXT,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'disabled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'urgent')),
      notify_on_complete INTEGER NOT NULL DEFAULT 1,
      session_id TEXT,
      working_directory TEXT,
      permanent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run);
  `);

  // Migration: add permanent column for existing databases
  safeAddColumn(db, "ALTER TABLE scheduled_tasks ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0");

  // Phase 3 Step 3 migration — `kind` column for legacy DBs. New rows
  // MUST set this explicitly (API + tool schemas validate); the default
  // here only covers pre-existing rows from before the split.
  safeAddColumn(db, "ALTER TABLE scheduled_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'ai_task'");

  // Phase 3 Step 4 — `source` column for distinguishing user-created
  // tasks from the system-injected assistant heartbeat task. NO CHECK
  // constraint (SQLite can't ALTER CHECK on existing tables); validated
  // in `createScheduledTask` / `updateScheduledTask`. `assistant_heartbeat`
  // is the only non-default value today, used by ensureHeartbeatTask.
  safeAddColumn(db, "ALTER TABLE scheduled_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");

  // Phase 3 Step 4 follow-up — `origin_session_id` column. Records the
  // chat_sessions.id from which this task was originally created (the
  // user was chatting in project A, the model called
  // codepilot_schedule_task; that user-chat session is the "origin").
  // Distinct from `session_id`, which is the runner's task-bound
  // execution session lazily created on first fire. The runner reads
  // origin_session_id to inherit working_directory / provider_id /
  // model / runtime_pin / permission_profile / sdk_cwd into the new
  // task-bound session, so a project-A task fires in project-A's
  // working dir + provider, not whatever the global default happens
  // to be when the scheduler ticks. Nullable: legacy rows + tasks
  // created from non-chat surfaces (UI-driven Settings → Tasks "Add")
  // simply have no origin and the runner falls back to whatever
  // task.working_directory was POSTed.
  safeAddColumn(db, "ALTER TABLE scheduled_tasks ADD COLUMN origin_session_id TEXT");

  // Phase 3 Step 4 — `chat_sessions.source` column. Default `'user'`
  // so existing rows stay user-visible; new task-bound sessions
  // created by the agent task runner are tagged `'task'` and filtered
  // out of the main ChatListPanel list (only reachable from
  // /settings/tasks or notification click).
  safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");

  // chat_origin_type / chat_origin_path — LEGACY / UNUSED. A short-lived "chat
  // creation origin" modeling attempt (2026-06-03) was reverted per user
  // decision (see tech-debt #38). No code reads or writes these; they are kept
  // (empty, default '') only because destructive migrations are forbidden. They
  // are NOT a product direction — don't build on them without re-scoping.
  safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN chat_origin_type TEXT NOT NULL DEFAULT ''");
  safeAddColumn(db, "ALTER TABLE chat_sessions ADD COLUMN chat_origin_path TEXT NOT NULL DEFAULT ''");

  // Phase 3 Step 4 — `messages.task_run_id` column for the marker
  // render-side join. Soft reference (no FK) so a deleted task run
  // doesn't cascade-delete user-visible messages; render layer
  // gracefully ignores missing runs. NEVER read by prompt builder.
  safeAddColumn(db, "ALTER TABLE messages ADD COLUMN task_run_id TEXT");

  // Migration: set default_panel to 'file_tree' only if not already configured
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES ('default_panel', 'file_tree')"
  ).run();

  // Migration (Phase 2C): backfill `global_default_mode` for existing rows.
  // Rule: if both pinned values are present at migration time → 'pinned'
  // (preserves what these users had before — a committed default), else
  // 'auto'. After this migration runs once, the mode is authoritative;
  // subsequent setProviderOptions writes update it directly.
  const existingMode = db.prepare("SELECT value FROM settings WHERE key = 'global_default_mode'").get() as { value: string } | undefined;
  if (!existingMode) {
    const m = db.prepare("SELECT value FROM settings WHERE key = 'global_default_model'").get() as { value: string } | undefined;
    const p = db.prepare("SELECT value FROM settings WHERE key = 'global_default_model_provider'").get() as { value: string } | undefined;
    const mode = (m?.value && p?.value) ? 'pinned' : 'auto';
    db.prepare("INSERT INTO settings (key, value) VALUES ('global_default_mode', ?)").run(mode);
  }

  // Task execution history. Phase 3 Step 3: a SINGLE row per execution
  // — `runScheduledTaskNow` inserts one with status='running', then
  // `updateTaskRunLog` flips it to 'success' / 'error' in place. Old
  // callers used `insertTaskRunLog` only on terminal states; both
  // patterns coexist (the function returns `runId` so the new path can
  // grab it for later update).
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      duration_ms INTEGER,
      notification_event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs_task_id ON task_run_logs(task_id);
  `);

  // Phase 3 Step 3 migration — add notification_event_id for legacy DBs.
  safeAddColumn(db, "ALTER TABLE task_run_logs ADD COLUMN notification_event_id TEXT");

  // Phase 3 Step 3 — notification events / deliveries split. The events
  // table is the umbrella ("one task fire = one event"); deliveries is
  // per-channel. v4 plan locks the relationship as 1:N. v5 plan adds
  // UNIQUE(event_id, channel) so even a buggy ack route can't write
  // two `delivered` rows for the same channel — DB layer rejects.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_events (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      task_id TEXT,
      session_id TEXT,
      action_type TEXT,
      action_payload TEXT,
      source TEXT NOT NULL DEFAULT 'codepilot',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      priority TEXT NOT NULL CHECK(priority IN ('low', 'normal', 'urgent')),
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notification_events_task_id ON notification_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_notification_events_created_at ON notification_events(created_at);

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'delivered', 'error', 'not_configured', 'skipped')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acked_at TEXT,
      UNIQUE(event_id, channel),
      FOREIGN KEY (event_id) REFERENCES notification_events(event_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_event_id ON notification_deliveries(event_id);
  `);

  safeAddColumn(db, 'ALTER TABLE notification_events ADD COLUMN action_type TEXT');
  safeAddColumn(db, 'ALTER TABLE notification_events ADD COLUMN action_payload TEXT');

  // Durable consumer lease. Status CHECK remains unchanged; claim/retry is
  // represented by additive columns so old rows and old readers stay valid.
  safeAddColumn(db, 'ALTER TABLE notification_deliveries ADD COLUMN claim_owner TEXT');
  safeAddColumn(db, 'ALTER TABLE notification_deliveries ADD COLUMN claimed_at TEXT');
  safeAddColumn(db, 'ALTER TABLE notification_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
  safeAddColumn(db, 'ALTER TABLE notification_deliveries ADD COLUMN last_attempt_at TEXT');
  safeAddColumn(db, 'ALTER TABLE notification_deliveries ADD COLUMN next_attempt_at TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notification_deliveries_claimable
    ON notification_deliveries(channel, status, next_attempt_at, claimed_at);
  `);

  suppressLegacyQueuedNotificationBacklog(db);
  migrateQueuedRendererNotificationsToNative(db);
  consolidateHeartbeatTasksAndEnsureUniqueIndex(db);
}

/**
 * Renderer toast is no longer a product notification channel. Preserve all
 * historical terminal rows, but move still-actionable queued work to the
 * Electron Main-owned native channel. If an event already has a native row,
 * close only the redundant renderer row as skipped to respect the UNIQUE
 * `(event_id, channel)` constraint without deleting audit evidence.
 */
export function migrateQueuedRendererNotificationsToNative(
  db: Database.Database,
  now = new Date(),
): { migrated: number; skippedDuplicates: number } {
  const migrate = db.transaction(() => {
    const ackedAt = now.toISOString();
    const duplicateResult = db.prepare(`
      UPDATE notification_deliveries AS renderer
      SET status = 'skipped',
          error = 'renderer_channel_retired_native_exists',
          acked_at = ?,
          claim_owner = NULL,
          claimed_at = NULL,
          next_attempt_at = NULL
      WHERE renderer.channel = 'renderer-toast'
        AND renderer.status = 'queued'
        AND EXISTS (
          SELECT 1
          FROM notification_deliveries AS native
          WHERE native.event_id = renderer.event_id
            AND native.channel = 'electron-native'
        )
    `).run(ackedAt);

    const migratedResult = db.prepare(`
      UPDATE notification_deliveries AS renderer
      SET channel = 'electron-native',
          claim_owner = NULL,
          claimed_at = NULL,
          next_attempt_at = NULL
      WHERE renderer.channel = 'renderer-toast'
        AND renderer.status = 'queued'
        AND NOT EXISTS (
          SELECT 1
          FROM notification_deliveries AS native
          WHERE native.event_id = renderer.event_id
            AND native.channel = 'electron-native'
        )
    `).run();

    return {
      migrated: migratedResult.changes,
      skippedDuplicates: duplicateResult.changes,
    };
  });
  return migrate();
}

/**
 * The pre-durable renderer queue left delivery rows in `queued` after its
 * in-memory payload had vanished. Replaying those rows when the durable
 * consumer first appears produces a burst of months-old notifications.
 *
 * Preserve the event/delivery audit trail, but close stale legacy work as
 * `skipped`. The one-time marker makes the migration idempotent, while the
 * age boundary protects notifications created by the current app run during
 * a dev HMR race.
 */
export function suppressLegacyQueuedNotificationBacklog(
  db: Database.Database,
  now = new Date(),
): number {
  const migrate = db.transaction(() => {
    const alreadyMigrated = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(
      LEGACY_NOTIFICATION_BACKLOG_MARKER,
    );
    if (alreadyMigrated) return 0;

    const cutoff = new Date(now.getTime() - LEGACY_NOTIFICATION_BACKLOG_MAX_AGE_MS).toISOString();
    const ackedAt = now.toISOString();
    const result = db.prepare(`
      UPDATE notification_deliveries
      SET status = 'skipped',
          error = 'legacy_backlog_suppressed',
          acked_at = ?,
          claim_owner = NULL,
          claimed_at = NULL,
          next_attempt_at = NULL
      WHERE status = 'queued'
        AND channel IN ('renderer-toast', 'electron-native')
        AND datetime(created_at) <= datetime(?)
    `).run(ackedAt, cutoff);

    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      LEGACY_NOTIFICATION_BACKLOG_MARKER,
      JSON.stringify({ migratedAt: ackedAt, cutoff, skipped: result.changes }),
    );
    return result.changes;
  });
  return migrate();
}

/**
 * Normalize historical system heartbeat rows before enforcing the one-row
 * invariant. Run/event history is re-linked to the keeper; user-created tasks
 * and notification event identities are never rewritten or deleted.
 */
export function consolidateHeartbeatTasksAndEnsureUniqueIndex(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const rows = db.prepare(`
      SELECT id
      FROM scheduled_tasks
      WHERE source = 'assistant_heartbeat'
      ORDER BY
        CASE status WHEN 'active' THEN 0 ELSE 1 END,
        datetime(updated_at) DESC,
        id ASC
    `).all() as Array<{ id: string }>;

    if (rows.length > 1) {
      const keeperId = rows[0].id;
      const duplicateIds = rows.slice(1).map((row) => row.id);
      const placeholders = duplicateIds.map(() => '?').join(', ');
      db.prepare(
        `UPDATE task_run_logs SET task_id = ? WHERE task_id IN (${placeholders})`,
      ).run(keeperId, ...duplicateIds);
      db.prepare(
        `UPDATE notification_events SET task_id = ? WHERE task_id IN (${placeholders})`,
      ).run(keeperId, ...duplicateIds);
      db.prepare(
        `DELETE FROM scheduled_tasks WHERE id IN (${placeholders})`,
      ).run(...duplicateIds);
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_one_assistant_heartbeat
      ON scheduled_tasks(source)
      WHERE source = 'assistant_heartbeat';
    `);
  });
  migrate();
}

const ASSET_RECORD_REQUIRED_COLUMNS = [
  'id',
  'kind',
  'producer_id',
  'stable_path',
  'content_hash',
  'mime_type',
  'curation_state',
  'rating',
  'tags',
  'materialization_key',
  'lifecycle_state',
  'integrity_state',
  'source_media_generation_id',
  'created_at',
  'updated_at',
] as const;

/**
 * Additive, data-preserving Asset Library schema.
 *
 * Existing `media_generations` remains untouched and readable by v0.62.
 * `asset_records` is a typed index/provenance layer over those bytes plus
 * future materializers. Backfill is performed separately and idempotently so
 * schema initialization never hashes a large user library on the hot path.
 */
export function migrateAssetLibrarySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS asset_records (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      producer_id TEXT NOT NULL,
      stable_path TEXT NOT NULL,
      content_hash TEXT NOT NULL DEFAULT '',
      mime_type TEXT NOT NULL DEFAULT '',
      byte_size INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      preview_path TEXT NOT NULL DEFAULT '',
      harness_id TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      session_id TEXT,
      message_id TEXT,
      runtime_id TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL DEFAULT '',
      model_id TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      method_ref TEXT NOT NULL DEFAULT '',
      trust_tier TEXT NOT NULL DEFAULT 'local_generated',
      source_scope TEXT NOT NULL DEFAULT '',
      license TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      curation_state TEXT NOT NULL DEFAULT 'unreviewed'
        CHECK(curation_state IN ('unreviewed','selected','rejected')),
      rating INTEGER CHECK(rating IS NULL OR (rating >= 1 AND rating <= 5)),
      tags TEXT NOT NULL DEFAULT '[]',
      lifecycle_state TEXT NOT NULL DEFAULT 'active'
        CHECK(lifecycle_state IN ('active','trashed')),
      integrity_state TEXT NOT NULL DEFAULT 'valid'
        CHECK(integrity_state IN ('valid','missing','modified')),
      integrity_reason TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      materialization_key TEXT NOT NULL DEFAULT '',
      source_media_generation_id TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT,
      FOREIGN KEY (source_media_generation_id)
        REFERENCES media_generations(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS asset_lineage (
      parent_asset_id TEXT NOT NULL,
      child_asset_id TEXT NOT NULL,
      relation TEXT NOT NULL
        CHECK(relation IN ('derived_from','input_reference','variant_of')),
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (parent_asset_id, child_asset_id, relation),
      CHECK(parent_asset_id != child_asset_id),
      FOREIGN KEY (parent_asset_id) REFERENCES asset_records(id) ON DELETE RESTRICT,
      FOREIGN KEY (child_asset_id) REFERENCES asset_records(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS asset_references (
      id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      consumer_type TEXT NOT NULL,
      consumer_id TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT,
      UNIQUE(asset_id, consumer_type, consumer_id),
      FOREIGN KEY (asset_id) REFERENCES asset_records(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS asset_backfill_state (
      source_table TEXT PRIMARY KEY,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      created_count INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      last_run_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS asset_backfill_failures (
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      failure_revision TEXT NOT NULL,
      error TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      first_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (source_table, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_asset_kind_created
      ON asset_records(kind, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_asset_lifecycle_created
      ON asset_records(lifecycle_state, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_asset_content_hash
      ON asset_records(content_hash);
    CREATE INDEX IF NOT EXISTS idx_asset_session
      ON asset_records(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_asset_lineage_parent
      ON asset_lineage(parent_asset_id);
    CREATE INDEX IF NOT EXISTS idx_asset_lineage_child
      ON asset_lineage(child_asset_id);
    CREATE INDEX IF NOT EXISTS idx_asset_references_asset
      ON asset_references(asset_id, released_at);
    CREATE INDEX IF NOT EXISTS idx_asset_backfill_failures_revision
      ON asset_backfill_failures(source_table, failure_revision);
  `);

  const existingAssetColumns = new Set(
    (db.prepare("PRAGMA table_info(asset_records)").all() as { name: string }[])
      .map((column) => column.name),
  );
  if (!existingAssetColumns.has('curation_state')) {
    safeAddColumn(
      db,
      `ALTER TABLE asset_records
       ADD COLUMN curation_state TEXT NOT NULL DEFAULT 'unreviewed'
       CHECK(curation_state IN ('unreviewed','selected','rejected'))`,
    );
  }
  if (!existingAssetColumns.has('rating')) {
    safeAddColumn(
      db,
      `ALTER TABLE asset_records
       ADD COLUMN rating INTEGER
       CHECK(rating IS NULL OR (rating >= 1 AND rating <= 5))`,
    );
  }
  if (!existingAssetColumns.has('tags')) {
    safeAddColumn(
      db,
      `ALTER TABLE asset_records
       ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`,
    );
    const mediaColumns = new Set(
      (db.prepare("PRAGMA table_info(media_generations)").all() as { name: string }[])
        .map((column) => column.name),
    );
    if (mediaColumns.has('tags')) {
      db.prepare(
        `UPDATE asset_records
         SET tags = (
           SELECT mg.tags
           FROM media_generations mg
           WHERE mg.id = asset_records.source_media_generation_id
             AND json_valid(mg.tags)
             AND json_type(mg.tags) = 'array'
         )
         WHERE tags = '[]'
           AND source_media_generation_id IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM media_generations mg
             WHERE mg.id = asset_records.source_media_generation_id
               AND json_valid(mg.tags)
               AND json_type(mg.tags) = 'array'
           )`,
      ).run();
    }
  }
  if (!existingAssetColumns.has('materialization_key')) {
    safeAddColumn(
      db,
      `ALTER TABLE asset_records
       ADD COLUMN materialization_key TEXT NOT NULL DEFAULT ''`,
    );
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_materialization_key
      ON asset_records(materialization_key)
      WHERE materialization_key != ''
  `);
  const backfillColumns = new Set(
    (db.prepare("PRAGMA table_info(asset_backfill_state)").all() as { name: string }[])
      .map((column) => column.name),
  );
  if (!backfillColumns.has('last_error')) {
    safeAddColumn(
      db,
      `ALTER TABLE asset_backfill_state
       ADD COLUMN last_error TEXT NOT NULL DEFAULT ''`,
    );
  }
  const columns = new Set(
    (db.prepare("PRAGMA table_info(asset_records)").all() as { name: string }[])
      .map((column) => column.name),
  );
  const missing = ASSET_RECORD_REQUIRED_COLUMNS.filter(
    (column) => !columns.has(column),
  );
  if (missing.length > 0) {
    throw new Error(
      `Existing asset_records table has an incompatible shape; missing: `
      + missing.join(', '),
    );
  }
}

/**
 * Additive Sub-agent orchestration migration.
 *
 * Historical rows represented one physical attempt and had no logical task
 * identity. Conservatively backfill each existing id as its own logical run,
 * attempt 1; never guess that similarly named agents were retries.
 */
/** Exported for additive migration contract tests. Production uses migrateDb(). */
export function migrateSubagentRunSchema(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(subagent_runs)").all() as { name: string }[];
  if (columns.length === 0) return;
  const names = new Set(columns.map(column => column.name));

  db.transaction(() => {
    if (!names.has('logical_run_id')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN logical_run_id TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has('attempt_number')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1 CHECK(attempt_number > 0)");
    }
    if (!names.has('effective_provider_id')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN effective_provider_id TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has('phase')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'running' CHECK(phase IN ('running', 'settling', 'terminal'))");
    }
    if (!names.has('result_json')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN result_json TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has('current_activity')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN current_activity TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has('last_activity_at')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN last_activity_at TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has('workflow_id')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN workflow_id TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has('task_key')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN task_key TEXT NOT NULL DEFAULT ''");
    }
    if (!names.has('dependencies_json')) {
      safeAddColumn(db, "ALTER TABLE subagent_runs ADD COLUMN dependencies_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!names.has('dispatch_state')) {
      safeAddColumn(
        db,
        "ALTER TABLE subagent_runs ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'executing' CHECK(dispatch_state IN ('queued', 'executing', 'settling', 'terminal'))",
      );
    }

    db.exec(`
      UPDATE subagent_runs
      SET logical_run_id = id
      WHERE logical_run_id = '';

      UPDATE subagent_runs
      SET phase = CASE WHEN terminal = 1 THEN 'terminal' ELSE 'running' END
      WHERE phase = ''
         OR (terminal = 1 AND phase != 'terminal');

      UPDATE subagent_runs
      SET last_activity_at = updated_at
      WHERE last_activity_at = '';

      UPDATE subagent_runs
      SET dispatch_state = CASE
        WHEN terminal = 1 THEN 'terminal'
        WHEN phase = 'settling' THEN 'settling'
        ELSE 'executing'
      END
      WHERE dispatch_state = ''
         OR terminal = 1
         OR phase = 'settling';

      CREATE TABLE IF NOT EXISTS subagent_run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        logical_run_id TEXT NOT NULL DEFAULT '',
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
        event_type TEXT NOT NULL
          CHECK(event_type IN (
            'started', 'activity', 'tool_started', 'tool_completed',
            'permission_requested', 'permission_resolved', 'partial_result',
            'settling', 'terminal', 'route_warning'
          )),
        activity TEXT NOT NULL DEFAULT '',
        tool_name TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_runs_logical_attempt
        ON subagent_runs(parent_session_id, logical_run_id, attempt_number);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent_logical
        ON subagent_runs(parent_session_id, logical_run_id, attempt_number DESC);
      CREATE INDEX IF NOT EXISTS idx_subagent_runs_workflow_task
        ON subagent_runs(parent_session_id, workflow_id, task_key, attempt_number DESC)
        WHERE workflow_id != '' AND task_key != '';
      CREATE INDEX IF NOT EXISTS idx_subagent_run_events_run_sequence
        ON subagent_run_events(run_id, sequence);
    `);

    const eventColumns = db.prepare("PRAGMA table_info(subagent_run_events)")
      .all() as { name: string }[];
    if (!eventColumns.some(column => column.name === 'cursor')) {
      safeAddColumn(
        db,
        'ALTER TABLE subagent_run_events ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0)',
      );
    }
    db.exec(`
      UPDATE subagent_run_events
      SET cursor = rowid
      WHERE cursor = 0;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subagent_run_events_cursor
        ON subagent_run_events(cursor);
      CREATE INDEX IF NOT EXISTS idx_subagent_run_events_logical_cursor
        ON subagent_run_events(logical_run_id, cursor);
      CREATE INDEX IF NOT EXISTS idx_subagent_run_events_run_cursor
        ON subagent_run_events(run_id, cursor);
    `);
  })();
}

const BAILIAN_CODING_PLAN_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
const QWEN_TOKEN_PLAN_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic';
const LEGACY_QWEN_TEAM_MODELS = new Set(['qwen3.6-plus', 'glm-5', 'MiniMax-M2.5']);

/** Exported for migration contract tests. Production callers should use getDb(). */
export function backfillProviderPresetKeys(dbInstance: Database.Database): void {
  const columns = dbInstance.prepare("PRAGMA table_info(api_providers)").all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'preset_key')) return;

  const migrate = dbInstance.transaction(() => {
    dbInstance.prepare(`
      UPDATE api_providers
      SET preset_key = 'bailian'
      WHERE preset_key = ''
        AND base_url = ?
        AND (protocol = 'anthropic' OR protocol = '' OR protocol IS NULL)
    `).run(BAILIAN_CODING_PLAN_URL);

    const tokenRows = dbInstance.prepare(`
      SELECT id, role_models_json
      FROM api_providers
      WHERE preset_key = ''
        AND base_url = ?
        AND (protocol = 'anthropic' OR protocol = '' OR protocol IS NULL)
    `).all(QWEN_TOKEN_PLAN_URL) as Array<{ id: string; role_models_json: string }>;

    const modelStmt = dbInstance.prepare(`
      SELECT model_id, source, user_edited
      FROM provider_models
      WHERE provider_id = ?
    `);
    const updateTeam = dbInstance.prepare(`
      UPDATE api_providers
      SET preset_key = 'bailian-token-plan-cn'
      WHERE id = ? AND preset_key = ''
    `);

    for (const row of tokenRows) {
      let roles: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.role_models_json || '{}');
        roles = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        continue;
      }
      const roleFingerprint = ['default', 'sonnet', 'opus', 'haiku']
        .every(role => roles[role] === 'qwen3.6-plus');
      if (!roleFingerprint) continue;

      const modelRows = modelStmt.all(row.id) as Array<{
        model_id: string;
        source: string;
        user_edited: number;
      }>;
      const managedIds = new Set(
        modelRows
          .filter(model => model.source !== 'manual' && model.user_edited === 0)
          .map(model => model.model_id),
      );
      const exactManagedCatalog = managedIds.size === LEGACY_QWEN_TEAM_MODELS.size
        && [...LEGACY_QWEN_TEAM_MODELS].every(id => managedIds.has(id));
      if (exactManagedCatalog) updateTeam.run(row.id);
    }
  });

  migrate();
}

// ==========================================
// Session Operations
// ==========================================

export interface CreateSessionExecutionBinding {
  runtimeId?: RuntimeId;
  state?: 'unbound' | 'bound';
  source?: RuntimeBindingSource;
}

/**
 * Phase 3 Step 4: when `opts.includeSources` is supplied, only sessions
 * whose `source` is in that list are returned. The standard caller
 * (ChatListPanel) passes `['user']` so task-bound sessions don't
 * pollute the user-facing list. Callers that legitimately want task
 * sessions (TasksSection's "open execution session" link, the
 * /api/chat/sessions list with `?source=task` query) pass the
 * appropriate set. Defaults to no filter for backwards compatibility.
 */
export function getAllSessions(opts?: { includeSources?: ReadonlyArray<'user' | 'task'> }): ChatSession[] {
  const db = getDb();
  const filter = opts?.includeSources;
  if (filter && filter.length > 0) {
    const placeholders = filter.map(() => '?').join(',');
    return db
      .prepare(`SELECT * FROM chat_sessions WHERE source IN (${placeholders}) ORDER BY updated_at DESC`)
      .all(...filter) as ChatSession[];
  }
  return db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC').all() as ChatSession[];
}

/**
 * Get sessions that are currently running or waiting for permission.
 */
export function getActiveSessions(): ChatSession[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM chat_sessions WHERE runtime_status IN ('running', 'waiting_permission') ORDER BY runtime_updated_at DESC"
  ).all() as ChatSession[];
}

/**
 * Updater safety fact: an active-looking status is live only while the same
 * session also has a non-expired runtime owner. A process crash can leave an
 * active runtime_status behind; treating that residue as permanent work would
 * make installation impossible until another startup repair writes it.
 */
export function hasActiveSessionWork(now: Date = new Date()): boolean {
  const db = getDb();
  const current = now.toISOString().replace('T', ' ').split('.')[0];
  const row = db.prepare(`
    SELECT 1
    FROM chat_sessions AS sessions
    INNER JOIN session_runtime_locks AS locks ON locks.session_id = sessions.id
    WHERE sessions.runtime_status IN ('running', 'streaming', 'waiting_permission')
      AND locks.expires_at >= ?
    LIMIT 1
  `).get(current);
  return !!row;
}

export function getSession(id: string): ChatSession | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as ChatSession | undefined;
}

export function getSessionSummary(sessionId: string): {
  summary: string;
  /** Wall-clock time the summary row was written (UI/debug only — do NOT use as coverage boundary) */
  updatedAt: string;
  /** SQLite rowid of the last message covered by the summary; 0 = no boundary known */
  boundaryRowid: number;
} {
  const db = getDb();
  const row = db.prepare(
    'SELECT context_summary, context_summary_updated_at, context_summary_boundary_rowid FROM chat_sessions WHERE id = ?'
  ).get(sessionId) as { context_summary: string; context_summary_updated_at: string; context_summary_boundary_rowid: number } | undefined;
  return {
    summary: row?.context_summary || '',
    updatedAt: row?.context_summary_updated_at || '',
    boundaryRowid: row?.context_summary_boundary_rowid ?? 0,
  };
}

/**
 * Write a new context summary together with its coverage boundary.
 *
 * `boundaryRowid` MUST be the SQLite rowid of the last message actually
 * covered by this summary (i.e. the last entry in messagesToCompress for the
 * auto pre-compression path, or the last row of allMsgs for manual /compact).
 * Pass 0 only when the caller has no DB rowid available (reactive compact
 * inside streamClaude receives {role, content} pairs with no DB metadata);
 * 0 causes filterHistoryByCompactBoundary to passthrough — degraded but safe.
 *
 * Do NOT pass `new Date()` or any wall-clock time here: write time and
 * coverage boundary diverge on the auto pre-compression path (see
 * filterHistoryByCompactBoundary doc). And do NOT reuse an earlier timestamp
 * column for filtering — second-precision timestamps can't distinguish a
 * last-compressed message from a first-kept message written in the same
 * second. rowid is the only robust boundary.
 */
export function updateSessionSummary(sessionId: string, summary: string, boundaryRowid: number): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    'UPDATE chat_sessions SET context_summary = ?, context_summary_updated_at = ?, context_summary_boundary_rowid = ? WHERE id = ?'
  ).run(summary, now, boundaryRowid, sessionId);
}

export type SessionCompactionTrigger = 'manual' | 'automatic' | 'reactive';

export interface SessionCompactionEvent {
  id: string;
  session_id: string;
  trigger: SessionCompactionTrigger;
  source_boundary_rowid: number;
  messages_compressed: number;
  estimated_tokens_saved: number;
  auxiliary_provider_id: string | null;
  auxiliary_model_id: string | null;
  auxiliary_route_source: string | null;
  recreated_underlying_session: 0 | 1;
  created_at: string;
}

/** Atomically advance summary coverage and persist the user-visible fact. */
export function commitSessionCompaction(input: {
  sessionId: string;
  summary: string;
  boundaryRowid: number;
  trigger: SessionCompactionTrigger;
  messagesCompressed: number;
  estimatedTokensSaved: number;
  auxiliaryProviderId?: string;
  auxiliaryModelId?: string;
  auxiliaryRouteSource?: string;
  recreatedUnderlyingSession: boolean;
}): SessionCompactionEvent {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const id = crypto.randomBytes(16).toString('hex');
  return db.transaction(() => {
    const updated = db.prepare(`
      UPDATE chat_sessions
      SET context_summary = ?, context_summary_updated_at = ?, context_summary_boundary_rowid = ?
      WHERE id = ?
    `).run(input.summary, now, input.boundaryRowid, input.sessionId);
    if (updated.changes !== 1) throw new Error('SESSION_NOT_FOUND');
    db.prepare(`
      INSERT INTO chat_session_compaction_events (
        id, session_id, trigger, source_boundary_rowid, messages_compressed,
        estimated_tokens_saved, auxiliary_provider_id, auxiliary_model_id,
        auxiliary_route_source, recreated_underlying_session, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId,
      input.trigger,
      input.boundaryRowid,
      input.messagesCompressed,
      input.estimatedTokensSaved,
      input.auxiliaryProviderId || null,
      input.auxiliaryModelId || null,
      input.auxiliaryRouteSource || null,
      input.recreatedUnderlyingSession ? 1 : 0,
      now,
    );
    return getLatestSessionCompactionEvent(input.sessionId)!;
  })();
}

export function getLatestSessionCompactionEvent(sessionId: string): SessionCompactionEvent | undefined {
  return getDb().prepare(`
    SELECT * FROM chat_session_compaction_events
    WHERE session_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(sessionId) as SessionCompactionEvent | undefined;
}

/**
 * Phase 3 Step 4: `source` parameter (optional, defaults to `'user'`)
 * tags task-bound sessions so ChatListPanel can hide them from the
 * main user-facing list. The agent task runner passes `'task'` when
 * creating an execution session for an `ai_task`. Existing call sites
 * don't pass it and get the default `'user'`.
 */
export function createSession(
  title?: string,
  model?: string,
  systemPrompt?: string,
  workingDirectory?: string,
  mode?: string,
  providerId?: string,
  permissionProfile?: SessionPermissionProfile,
  source?: 'user' | 'task',
  /**
   * Provenance of `title`. Defaults to the honest reading of the args: a
   * caller that passed no title gets 'placeholder' (a fallback may fill it
   * in later); a caller that named the session explicitly gets 'manual'
   * (protected). System callers (bridge / task / heartbeat / worktree) and
   * the importer pass 'system' / 'import' explicitly.
   */
  titleOrigin?: TitleOrigin,
  executionBinding?: CreateSessionExecutionBinding,
): ChatSession {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const wd = workingDirectory || '';
  const projectName = path.basename(wd);
  const sourceValue = source === 'task' ? 'task' : 'user';
  const originValue: TitleOrigin = titleOrigin ?? (title ? 'manual' : 'placeholder');
  const bindingState: RuntimeBindingState = executionBinding?.state === 'bound' ? 'bound' : 'unbound';
  const runtimePin = executionBinding?.runtimeId ?? '';
  if (bindingState === 'bound' && (!runtimePin || !executionBinding?.source)) {
    throw new Error('A bound session requires an explicit runtime and binding source.');
  }
  const boundAt = bindingState === 'bound' ? now : null;
  const bindingSource = bindingState === 'bound' ? executionBinding?.source ?? null : null;

  db.prepare(
    `INSERT INTO chat_sessions (
      id, title, created_at, updated_at, model, system_prompt,
      working_directory, sdk_session_id, project_name, status, mode, sdk_cwd,
      provider_id, permission_profile, source, title_origin,
      runtime_pin, runtime_binding_state, runtime_bound_at,
      runtime_binding_source, route_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    title || 'New Chat',
    now,
    now,
    model || '',
    systemPrompt || '',
    wd,
    '',
    projectName,
    'active',
    mode || 'code',
    wd,
    providerId || '',
    normalizePermissionProfile(permissionProfile),
    sourceValue,
    originValue,
    runtimePin,
    bindingState,
    boundAt,
    bindingSource,
    0,
  );

  return getSession(id)!;
}

export interface ChatSessionHandoffRecord {
  id: string;
  source_session_id: string | null;
  target_session_id: string;
  source_boundary_rowid: number;
  source_runtime_id: RuntimeId;
  target_runtime_id: RuntimeId;
  payload_version: number;
  payload_json: string;
  payload_source: 'recent_transcript' | 'generated_summary' | 'user_edited';
  idempotency_key: string;
  created_at: string;
}

function latestEligibleMessageBoundary(db: Database.Database, sessionId: string): number {
  const rows = db.prepare(`
    SELECT rowid AS _rowid, content, is_heartbeat_ack
    FROM messages
    WHERE session_id = ?
    ORDER BY rowid DESC
  `).all(sessionId) as Array<{ _rowid: number; content: string; is_heartbeat_ack?: number }>;
  const eligible = rows.find(row => row.is_heartbeat_ack !== 1
    && !isInternalRuntimeSwitchMarker(row.content));
  return eligible?._rowid ?? 0;
}

export function getSessionHandoffPreview(sessionId: string): {
  sourceSession: ChatSession;
  sourceBoundaryRowid: number;
} | undefined {
  const db = getDb();
  const sourceSession = getSession(sessionId);
  if (!sourceSession) return undefined;
  return {
    sourceSession,
    sourceBoundaryRowid: latestEligibleMessageBoundary(db, sessionId),
  };
}

export function getHandoffForTargetSession(
  targetSessionId: string,
): ChatSessionHandoffRecord | undefined {
  return getDb().prepare('SELECT * FROM chat_session_handoffs WHERE target_session_id = ?')
    .get(targetSessionId) as ChatSessionHandoffRecord | undefined;
}

export type CreateSessionHandoffResult =
  | { ok: true; targetSession: ChatSession; handoff: ChatSessionHandoffRecord; idempotent: boolean }
  | { ok: false; reason: 'source_not_found' | 'source_unbound' | 'source_busy' | 'source_route_advanced' | 'source_transcript_advanced' };

/** Create the bound target chat and relationship in one transaction. */
export function createSessionHandoff(input: {
  sourceSessionId: string;
  expectedSourceRouteRevision: number;
  expectedSourceBoundaryRowid: number;
  targetRoute: SessionRouteIdentity;
  payloadVersion: number;
  payloadJson: string;
  payloadSource: ChatSessionHandoffRecord['payload_source'];
  idempotencyKey?: string;
}): CreateSessionHandoffResult {
  const db = getDb();
  const create = db.transaction((): CreateSessionHandoffResult => {
    const idempotencyKey = input.idempotencyKey?.trim().slice(0, 200) || '';
    if (idempotencyKey) {
      const existing = db.prepare(`
        SELECT * FROM chat_session_handoffs
        WHERE source_session_id = ? AND idempotency_key = ?
      `).get(input.sourceSessionId, idempotencyKey) as ChatSessionHandoffRecord | undefined;
      if (existing) {
        const targetSession = getSession(existing.target_session_id);
        if (targetSession) return { ok: true, targetSession, handoff: existing, idempotent: true };
      }
    }

    const source = getSession(input.sourceSessionId);
    if (!source) return { ok: false, reason: 'source_not_found' };
    if (source.runtime_binding_state !== 'bound' || !isRuntimeId(source.runtime_pin)) {
      return { ok: false, reason: 'source_unbound' };
    }
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    db.prepare('DELETE FROM session_runtime_locks WHERE expires_at < ?').run(now);
    const locked = db.prepare('SELECT 1 FROM session_runtime_locks WHERE session_id = ?')
      .get(input.sourceSessionId);
    if (locked || ['running', 'streaming', 'waiting_permission'].includes(source.runtime_status || '')) {
      return { ok: false, reason: 'source_busy' };
    }
    if ((source.route_revision ?? 0) !== input.expectedSourceRouteRevision) {
      return { ok: false, reason: 'source_route_advanced' };
    }
    if (latestEligibleMessageBoundary(db, input.sourceSessionId) !== input.expectedSourceBoundaryRowid) {
      return { ok: false, reason: 'source_transcript_advanced' };
    }

    const targetSession = createSession(
      `Continued: ${source.title}`.slice(0, 200),
      input.targetRoute.modelId,
      undefined,
      source.working_directory,
      source.mode,
      input.targetRoute.providerId,
      normalizePermissionProfile(source.permission_profile),
      'user',
      'system',
      {
        runtimeId: input.targetRoute.runtimeId,
        state: 'bound',
        source: 'handoff_create',
      },
    );
    const handoffId = crypto.randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO chat_session_handoffs (
        id, source_session_id, target_session_id, source_boundary_rowid,
        source_runtime_id, target_runtime_id, payload_version, payload_json,
        payload_source, idempotency_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      handoffId,
      source.id,
      targetSession.id,
      input.expectedSourceBoundaryRowid,
      source.runtime_pin,
      input.targetRoute.runtimeId,
      input.payloadVersion,
      input.payloadJson,
      input.payloadSource,
      idempotencyKey,
      now,
    );
    const handoff = getHandoffForTargetSession(targetSession.id)!;
    return { ok: true, targetSession, handoff, idempotent: false };
  });
  return create();
}

/**
 * Phase 3 Step 4a (review fix) — `opts.includeSources` lets callers
 * filter by `chat_sessions.source`. Without this, a workspace whose
 * working directory happens to coincide with an `ai_task`'s
 * `working_directory` would return that task's hidden execution
 * session (`source='task'`) when looking up the buddy session,
 * causing heartbeat speak-up to write into the wrong place.
 *
 * Backwards compatible: the second arg defaults to `undefined`, in
 * which case the original "no filter" behavior is preserved (existing
 * callers get the same result they always did). Heartbeat / buddy
 * resolution should pass `{ includeSources: ['user'] }` to be
 * explicit about wanting user-visible sessions only.
 */
export function getLatestSessionByWorkingDirectory(
  workingDirectory: string,
  opts?: { includeSources?: ReadonlyArray<'user' | 'task'> },
): ChatSession | undefined {
  const db = getDb();
  const filter = opts?.includeSources;
  if (filter && filter.length > 0) {
    const placeholders = filter.map(() => '?').join(',');
    return db
      .prepare(
        `SELECT * FROM chat_sessions WHERE working_directory = ? AND source IN (${placeholders}) ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(workingDirectory, ...filter) as ChatSession | undefined;
  }
  return db
    .prepare('SELECT * FROM chat_sessions WHERE working_directory = ? ORDER BY updated_at DESC LIMIT 1')
    .get(workingDirectory) as ChatSession | undefined;
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  // Wrap in transaction: clean up tables without CASCADE before deleting session.
  // channel_outbound_refs has codepilot_session_id but no FK CASCADE constraint,
  // causing FK errors when foreign_keys=ON (#Sentry 40x SqliteError).
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM channel_outbound_refs WHERE codepilot_session_id = ?').run(id);
    db.prepare('DELETE FROM settings WHERE key = ?').run(`memory.assistant-binding.${id}`);
    return db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id).changes > 0;
  });
  return txn();
}

export function updateSessionTimestamp(id: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, id);
}

/**
 * Write a session title together with its provenance.
 *
 * `origin` is REQUIRED — a title without a recorded origin is what let the
 * old unconditional blind write clobber a user's manual rename. Every call
 * site now has to say, in the diff, who is writing and by what right.
 *
 * `opts.expectOrigin` makes the write a compare-and-swap: the row is only
 * touched if its CURRENT origin is in that list. This is the atomicity
 * boundary for background generation — `expectOrigin: ['fallback']` cannot
 * overwrite 'manual' / 'system' / 'import', cannot double-apply (the first
 * write moves the row to 'generated'), and cannot resurrect a deleted
 * session (zero rows match). Omit it only for writes that are themselves the
 * user's or the system's explicit intent.
 *
 * @returns true if a row was actually updated.
 */
export function updateSessionTitle(
  id: string,
  title: string,
  origin: TitleOrigin,
  opts?: { expectOrigin?: readonly TitleOrigin[] },
): boolean {
  const db = getDb();
  const expect = opts?.expectOrigin;
  if (expect && expect.length > 0) {
    const slots = expect.map(() => '?').join(', ');
    const res = db
      .prepare(`UPDATE chat_sessions SET title = ?, title_origin = ? WHERE id = ? AND title_origin IN (${slots})`)
      .run(title, origin, id, ...expect);
    return res.changes > 0;
  }
  const res = db
    .prepare('UPDATE chat_sessions SET title = ?, title_origin = ? WHERE id = ?')
    .run(title, origin, id);
  return res.changes > 0;
}

export function updateSdkSessionId(id: string, sdkSessionId: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id);
}

/**
 * Phase 5 Phase 3 (2026-05-13) — Codex Runtime thread id persistence.
 * Mirror of `updateSdkSessionId` for the codex_thread_id column.
 * Called only from `src/lib/runtime/session-store.ts` so adapter-
 * specific persistence stays scoped per the contract.
 *
 * Phase 5b (2026-05-15) — also writes `codex_thread_provider_id` so
 * a later resume can detect provider switches and start fresh rather
 * than running under a stale provider's injected config. Pass the
 * empty string to clear (matches the clear semantics for thread id).
 */
export function updateCodexThreadId(
  id: string,
  codexThreadId: string,
  providerId: string = '',
  mcpFingerprint: string = '',
): void {
  const db = getDb();
  db.prepare(
    'UPDATE chat_sessions SET codex_thread_id = ?, codex_thread_provider_id = ?, codex_thread_mcp_fingerprint = ? WHERE id = ?',
  ).run(codexThreadId, providerId, mcpFingerprint, id);
}

export function updateSessionModel(id: string, model: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?').run(model, id);
}

export function updateSessionProvider(id: string, providerName: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET provider_name = ? WHERE id = ?').run(providerName, id);
}

export function updateSessionProviderId(id: string, providerId: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET provider_id = ? WHERE id = ?').run(providerId, id);
}

export interface SessionRouteIdentity {
  runtimeId: RuntimeId;
  providerId: string;
  modelId: string;
}

export type SessionRouteMutationResult =
  | { ok: true; changed: boolean; session: ChatSession }
  | { ok: false; reason: 'not_found' | 'revision_conflict'; session?: ChatSession };

/**
 * Storage primitive for the single route-mutation API. Policy and live catalog
 * validation happen before this call; the expected revision closes the race
 * between validation and persistence. Route and binding changes increment the
 * dedicated revision exactly once, while no-ops do not touch it.
 */
export function updateSessionRouteCas(input: {
  sessionId: string;
  expectedRouteRevision: number;
  route: SessionRouteIdentity;
  binding?: { state: 'bound'; source: RuntimeBindingSource };
  clearRuntimeRefFor?: RuntimeId;
}): SessionRouteMutationResult {
  const db = getDb();
  const mutate = db.transaction((): SessionRouteMutationResult => {
    const current = getSession(input.sessionId);
    if (!current) return { ok: false, reason: 'not_found' };
    const currentRevision = current.route_revision ?? 0;
    if (currentRevision !== input.expectedRouteRevision) {
      return { ok: false, reason: 'revision_conflict', session: current };
    }

    const bindingChanged = input.binding != null && (
      current.runtime_binding_state !== 'bound'
      || current.runtime_binding_source !== input.binding.source
    );
    const routeChanged = current.runtime_pin !== input.route.runtimeId
      || current.provider_id !== input.route.providerId
      || current.model !== input.route.modelId;
    // A continuation reference belongs to an already-selected route. Clearing
    // one on its own is not a route mutation and must not create a revision.
    if (!bindingChanged && !routeChanged) {
      return { ok: true, changed: false, session: current };
    }

    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    const nextState = input.binding ? 'bound' : (current.runtime_binding_state ?? 'unbound');
    const nextSource = input.binding ? input.binding.source : current.runtime_binding_source ?? null;
    const nextBoundAt = input.binding
      ? (current.runtime_bound_at || now)
      : current.runtime_bound_at ?? null;
    const clearClaude = input.clearRuntimeRefFor === 'claude_code';
    const clearCodex = input.clearRuntimeRefFor === 'codex_runtime';
    const result = db.prepare(`
      UPDATE chat_sessions
      SET runtime_pin = ?, provider_id = ?, model = ?,
          runtime_binding_state = ?, runtime_binding_source = ?, runtime_bound_at = ?,
          route_revision = route_revision + 1,
          sdk_session_id = CASE WHEN ? THEN '' ELSE sdk_session_id END,
          codex_thread_id = CASE WHEN ? THEN '' ELSE codex_thread_id END,
          codex_thread_provider_id = CASE WHEN ? THEN '' ELSE codex_thread_provider_id END,
          codex_thread_mcp_fingerprint = CASE WHEN ? THEN '' ELSE codex_thread_mcp_fingerprint END
      WHERE id = ? AND route_revision = ?
    `).run(
      input.route.runtimeId,
      input.route.providerId,
      input.route.modelId,
      nextState,
      nextSource,
      nextBoundAt,
      clearClaude ? 1 : 0,
      clearCodex ? 1 : 0,
      clearCodex ? 1 : 0,
      clearCodex ? 1 : 0,
      input.sessionId,
      input.expectedRouteRevision,
    );
    if (result.changes !== 1) {
      const latest = getSession(input.sessionId);
      return latest
        ? { ok: false, reason: 'revision_conflict', session: latest }
        : { ok: false, reason: 'not_found' };
    }
    return { ok: true, changed: true, session: getSession(input.sessionId)! };
  });
  return mutate();
}

export type BindSessionForExecutionResult =
  | { ok: true; changed: boolean; session: ChatSession }
  | { ok: false; reason: 'not_found' | 'revision_conflict' | 'recovery_required' | 'route_mismatch'; session?: ChatSession };

/** Bind an ordinary unbound chat before any Runtime/provider side effect. */
export function bindSessionForExecution(input: {
  sessionId: string;
  expectedRouteRevision: number;
  runtimeId: RuntimeId;
  source?: 'first_execution';
}): BindSessionForExecutionResult {
  const current = getSession(input.sessionId);
  if (!current) return { ok: false, reason: 'not_found' };
  if ((current.route_revision ?? 0) !== input.expectedRouteRevision) {
    return { ok: false, reason: 'revision_conflict', session: current };
  }
  if (current.runtime_binding_state === 'legacy_unbound') {
    return { ok: false, reason: 'recovery_required', session: current };
  }
  if (current.runtime_binding_state === 'bound') {
    return current.runtime_pin === input.runtimeId
      ? { ok: true, changed: false, session: current }
      : { ok: false, reason: 'route_mismatch', session: current };
  }
  if (current.runtime_pin !== input.runtimeId) {
    return { ok: false, reason: 'route_mismatch', session: current };
  }
  return updateSessionRouteCas({
    sessionId: input.sessionId,
    expectedRouteRevision: input.expectedRouteRevision,
    route: {
      runtimeId: input.runtimeId,
      providerId: current.provider_id || '',
      modelId: current.model || '',
    },
    binding: { state: 'bound', source: input.source ?? 'first_execution' },
  });
}

/**
 * Phase 2 Step 2: write the per-session execution-engine pin. The
 * caller is responsible for keeping this empty when the user wants
 * "follow global", or one of `'claude_code'` / `'codepilot_runtime'`
 * when they explicitly pin the session. See
 * `resolveRuntimeForSession` in `lib/chat-runtime.ts` for the read
 * side; nothing reads this column today outside that helper, so
 * Phase 2 Step 3+ will progressively migrate consumers (chat route /
 * streamClaude / picker hook).
 */
export function updateSessionRuntime(id: string, runtimePin: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE chat_sessions
    SET runtime_pin = ?,
        route_revision = route_revision + CASE WHEN runtime_pin != ? THEN 1 ELSE 0 END
    WHERE id = ?
  `).run(runtimePin, runtimePin, id);
}

export function getDefaultProviderId(): string | undefined {
  // Primary source: derived from global default model's provider
  const globalProvider = getSetting('global_default_model_provider');
  if (globalProvider) return globalProvider;
  // Legacy fallback: old default_provider_id setting (for migration)
  return getSetting('default_provider_id') || undefined;
}

export function setDefaultProviderId(id: string): void {
  // Phase 2C: this writes the *legacy* `default_provider_id` only. It must
  // NOT touch `global_default_model` / `global_default_model_provider` —
  // those are the user's Pin commitment now (`global_default_mode='pinned'`),
  // and silently rewriting them is the exact silent-substitution the new
  // contract forbids. Auto-heal callers (like /api/providers/models when
  // the pin points at a deleted provider) still need a usable backend
  // hint, which `default_provider_id` provides; the user's pin stays
  // visible to the resolver as `'invalid-default'` so the UI can prompt
  // for explicit recovery.
  setSetting('default_provider_id', id);
}

export function updateSessionWorkingDirectory(id: string, workingDirectory: string): void {
  const db = getDb();
  const projectName = path.basename(workingDirectory);
  // Sync sdk_cwd + clear sdk_session_id — old session context is invalid
  db.prepare('UPDATE chat_sessions SET working_directory = ?, sdk_cwd = ?, project_name = ?, sdk_session_id = ? WHERE id = ?').run(workingDirectory, workingDirectory, projectName, '', id);
}

export function updateSessionMode(id: string, mode: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET mode = ? WHERE id = ?').run(mode, id);
}

/**
 * Persist the consolidated Composer access pair in one SQLite statement. The
 * route validates both fields first; this single write also prevents a storage
 * error from leaving a half-applied `mode` / `permission_profile` transition.
 */
export function updateSessionAccessLevel(
  id: string,
  mode: 'code' | 'plan' | 'ask',
  profile: SessionPermissionProfile,
): void {
  if (!['code', 'plan', 'ask'].includes(mode)) {
    throw new Error(`Invalid session mode: ${mode}`);
  }
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET mode = ?, permission_profile = ? WHERE id = ?')
    .run(mode, normalizePermissionProfile(profile), id);
}

/**
 * Persist a session's permission profile. `normalizePermissionProfile` is the
 * fail-closed floor: a caller that somehow reaches here with an unvalidated
 * value writes 'default', never an elevated profile. API validation still
 * rejects bad input with a 400 — this is the second line, not the first.
 */
export function updateSessionPermissionProfile(id: string, profile: SessionPermissionProfile): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET permission_profile = ? WHERE id = ?')
    .run(normalizePermissionProfile(profile), id);
}

// ==========================================
// Managed Sub-agent Run Operations
// ==========================================

export const SUBAGENT_RUN_CHECKPOINT_MAX_CHARS = 64 * 1024;
const SUBAGENT_LOGICAL_RUN_ID_MAX_CHARS = 160;
const SUBAGENT_WORKFLOW_KEY_MAX_CHARS = 160;

type SubagentLogicalRunConflictCode =
  | 'LOGICAL_RUN_STILL_RUNNING'
  | 'LOGICAL_RUN_ALREADY_COMPLETED'
  | 'DUPLICATE_TASK_KEY';

class SubagentLogicalRunConflictError extends Error {
  readonly name = 'SubagentLogicalRunConflictError';
  readonly retryable = false;

  constructor(
    readonly code: SubagentLogicalRunConflictCode,
    readonly logicalRunId: string,
    readonly latestAttemptId: string,
    readonly latestStatus: SubagentRunRecord['status'],
    readonly latestPhase: SubagentRunRecord['phase'],
  ) {
    super(
      code === 'LOGICAL_RUN_STILL_RUNNING'
        ? `Logical Sub-agent run "${logicalRunId}" already has active attempt "${latestAttemptId}" in phase "${latestPhase}".`
        : code === 'LOGICAL_RUN_ALREADY_COMPLETED'
          ? `Logical Sub-agent run "${logicalRunId}" already completed successfully in attempt "${latestAttemptId}".`
          : `Workflow task "${logicalRunId}" already belongs to attempt "${latestAttemptId}".`,
    );
  }
}

class SubagentDependencySpecError extends Error {
  readonly name = 'SubagentDependencySpecError';
  readonly code = 'INVALID_DEPENDENCY_SPEC';
  readonly retryable = false;

  constructor(readonly detail: string) {
    super(detail);
  }
}

export function describeSubagentRunStartRejection(error: unknown): {
  error: SubagentStatusError;
  message: string;
} | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const dependencyCandidate = error as Partial<SubagentDependencySpecError>;
  if (dependencyCandidate.code === 'INVALID_DEPENDENCY_SPEC') {
    return {
      error: { code: 'INVALID_DEPENDENCY_SPEC', retryable: false },
      message: `INVALID_DEPENDENCY_SPEC: ${dependencyCandidate.detail || dependencyCandidate.message || 'the workflow dependency graph is invalid.'}`,
    };
  }
  const candidate = error as Partial<SubagentLogicalRunConflictError>;
  if (
    candidate.code !== 'LOGICAL_RUN_STILL_RUNNING'
    && candidate.code !== 'LOGICAL_RUN_ALREADY_COMPLETED'
    && candidate.code !== 'DUPLICATE_TASK_KEY'
  ) {
    return undefined;
  }
  const logicalRunId = typeof candidate.logicalRunId === 'string'
    ? candidate.logicalRunId
    : '(unknown)';
  const latestAttemptId = typeof candidate.latestAttemptId === 'string'
    ? candidate.latestAttemptId
    : '(unknown)';
  if (candidate.code === 'LOGICAL_RUN_STILL_RUNNING') {
    const latestPhase = candidate.latestPhase === 'settling' ? 'settling' : 'running';
    return {
      error: { code: candidate.code, retryable: false },
      message: `${candidate.code}: logical_run_id "${logicalRunId}" already has active attempt "${latestAttemptId}" in phase "${latestPhase}". Do not launch a parallel retry or hide the active attempt. Wait for its terminal result and read the authoritative run details; omit logical_run_id only when starting genuinely different work.`,
    };
  }
  if (candidate.code === 'DUPLICATE_TASK_KEY') {
    return {
      error: { code: candidate.code, retryable: false },
      message: `${candidate.code}: workflow task "${logicalRunId}" already belongs to attempt "${latestAttemptId}". Do not create a second physical Sub-agent for the same workflow task. Use a different task_key, or explicitly retry the failed logicalRunId returned by the existing task.`,
    };
  }
  return {
    error: { code: candidate.code, retryable: false },
    message: `${candidate.code}: logical_run_id "${logicalRunId}" already completed successfully in attempt "${latestAttemptId}". Do not replace or hide the delivered result. Read the existing result; omit logical_run_id if the user intends a new logical task.`,
  };
}

function parseSubagentDependencyKeys(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function assertNoSubagentWorkflowCycle(
  db: Database.Database,
  parentSessionId: string,
  workflowId: string,
  taskKey: string,
  dependencyTaskKeys: string[],
): void {
  const rows = db.prepare(`
    SELECT task_key, dependencies_json
    FROM subagent_runs
    WHERE parent_session_id = ?
      AND workflow_id = ?
      AND task_key != ''
    ORDER BY attempt_number DESC, rowid DESC
  `).all(parentSessionId, workflowId) as Array<{
    task_key: string;
    dependencies_json: string;
  }>;
  const graph = new Map<string, string[]>();
  for (const row of rows) {
    if (!graph.has(row.task_key)) {
      graph.set(row.task_key, parseSubagentDependencyKeys(row.dependencies_json));
    }
  }
  graph.set(taskKey, dependencyTaskKeys);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (current: string, path: string[]): string[] | undefined => {
    if (visiting.has(current)) {
      const cycleStart = path.indexOf(current);
      return [...path.slice(Math.max(0, cycleStart)), current];
    }
    if (visited.has(current)) return undefined;
    visiting.add(current);
    for (const dependency of graph.get(current) || []) {
      const cycle = visit(dependency, [...path, current]);
      if (cycle) return cycle;
    }
    visiting.delete(current);
    visited.add(current);
    return undefined;
  };
  const cycle = visit(taskKey, []);
  if (cycle) {
    throw new SubagentDependencySpecError(
      `workflow "${workflowId}" contains a dependency cycle (${cycle.join(' → ')}). No durable attempt was created and no child was started.`,
    );
  }
}

function normalizeSubagentWorkflowKey(
  value: string | undefined,
  field: 'workflow_id' | 'task_key',
): string {
  const candidate = value?.trim() || '';
  if (!candidate) return '';
  if (
    candidate.length > SUBAGENT_WORKFLOW_KEY_MAX_CHARS
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)
  ) {
    throw new Error(
      `Invalid ${field}. Use 1-${SUBAGENT_WORKFLOW_KEY_MAX_CHARS} ASCII letters, digits, dot, underscore, colon, or dash.`,
    );
  }
  return candidate;
}

function normalizeLogicalRunId(value: string | undefined, fallbackAttemptId: string): string {
  const candidate = value?.trim() || fallbackAttemptId;
  if (
    candidate.length === 0
    || candidate.length > SUBAGENT_LOGICAL_RUN_ID_MAX_CHARS
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(candidate)
  ) {
    throw new Error(
      'Invalid logical Sub-agent run id. Use 1-160 ASCII letters, digits, dot, underscore, colon, or dash.',
    );
  }
  return candidate;
}

function subagentTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

function nextSubagentEventSequence(db: Database.Database, runId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
    FROM subagent_run_events
    WHERE run_id = ?
  `).get(runId) as { sequence: number };
  return row.sequence;
}

function nextSubagentEventCursor(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(cursor), 0) + 1 AS cursor
    FROM subagent_run_events
  `).get() as { cursor: number };
  return row.cursor;
}

export const SUBAGENT_RUN_EVENT_LIMIT_PER_ATTEMPT = 200;

function pruneSubagentRunEvents(db: Database.Database, runId: string): void {
  db.prepare(`
    DELETE FROM subagent_run_events
    WHERE run_id = ?
      AND id NOT IN (
        SELECT id
        FROM subagent_run_events
        WHERE run_id = ?
        ORDER BY cursor DESC
        LIMIT ?
      )
  `).run(runId, runId, SUBAGENT_RUN_EVENT_LIMIT_PER_ATTEMPT);
}

function subagentEventId(runId: string, coalesceKey?: string): string {
  if (!coalesceKey) return `subagent-event-${crypto.randomUUID()}`;
  const digest = crypto.createHash('sha256').update(coalesceKey).digest('hex').slice(0, 24);
  return `${runId}:event:${digest}`;
}

function insertSubagentRunEvent(
  db: Database.Database,
  run: Pick<SubagentRunRecord, 'id' | 'logical_run_id'>,
  input: RecordSubagentRunEventInput,
  now = subagentTimestamp(),
): SubagentRunEventRecord {
  const eventId = subagentEventId(run.id, input.coalesceKey);
  const existing = input.coalesceKey
    ? db.prepare('SELECT sequence, created_at FROM subagent_run_events WHERE id = ?')
      .get(eventId) as { sequence: number; created_at: string } | undefined
    : undefined;
  const sequence = existing?.sequence || nextSubagentEventSequence(db, run.id);
  const cursor = nextSubagentEventCursor(db);
  const payloadJson = input.payload ? JSON.stringify(input.payload) : '';
  db.prepare(`
    INSERT INTO subagent_run_events (
      id, run_id, logical_run_id, sequence, cursor, event_type, activity,
      tool_name, payload_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      cursor = excluded.cursor,
      event_type = excluded.event_type,
      activity = excluded.activity,
      tool_name = excluded.tool_name,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    eventId,
    run.id,
    run.logical_run_id,
    sequence,
    cursor,
    input.type,
    input.activity || '',
    input.toolName || '',
    payloadJson,
    existing?.created_at || now,
    now,
  );
  pruneSubagentRunEvents(db, run.id);
  return db.prepare('SELECT * FROM subagent_run_events WHERE id = ?')
    .get(eventId) as SubagentRunEventRecord;
}

function safeFiniteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function buildDelegatedAgentResult(
  run: SubagentRunRecord,
  input: SettleSubagentRunInput,
  resultText: string,
  effectiveProviderId: string,
  effectiveModel: string,
): DelegatedAgentResult {
  const usage = input.usage ? {
    ...(safeFiniteNonNegative(input.usage.requests) !== undefined
      ? { requests: safeFiniteNonNegative(input.usage.requests) }
      : {}),
    ...(safeFiniteNonNegative(input.usage.inputTokens) !== undefined
      ? { inputTokens: safeFiniteNonNegative(input.usage.inputTokens) }
      : {}),
    ...(safeFiniteNonNegative(input.usage.outputTokens) !== undefined
      ? { outputTokens: safeFiniteNonNegative(input.usage.outputTokens) }
      : {}),
    ...(safeFiniteNonNegative(input.usage.toolCalls) !== undefined
      ? { toolCalls: safeFiniteNonNegative(input.usage.toolCalls) }
      : {}),
    ...(safeFiniteNonNegative(input.usage.costUsd) !== undefined
      ? { costUsd: safeFiniteNonNegative(input.usage.costUsd) }
      : {}),
  } : undefined;
  return {
    status: input.status,
    ...(resultText ? { summary: resultText } : {}),
    ...(input.error ? { error: input.error } : {}),
    sources: input.sources || [],
    artifacts: input.artifacts || [],
    warnings: input.warnings || [],
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    provenance: {
      logicalRunId: run.logical_run_id,
      attemptId: run.id,
      attemptNumber: run.attempt_number,
      ...(run.provider_id ? { requestedProviderId: run.provider_id } : {}),
      ...(run.requested_model ? { requestedModel: run.requested_model } : {}),
      ...(effectiveProviderId ? { effectiveProviderId } : {}),
      ...(effectiveModel ? { effectiveModel } : {}),
      factSource: 'sqlite.subagent_runs',
    },
  };
}

/**
 * Create the durable running fact before a managed child is launched.
 *
 * The parent session FK is deliberate: if the parent chat does not exist, the
 * child must not run without an auditable owner. Callers should fail closed.
 */
export function startSubagentRun(input: StartSubagentRunInput): SubagentRunRecord {
  const db = getDb();
  const parent = db.prepare(`
    SELECT runtime_pin, runtime_binding_state, provider_id, model
    FROM chat_sessions
    WHERE id = ?
  `).get(input.parentSessionId) as Pick<
    ChatSession,
    'runtime_pin' | 'runtime_binding_state' | 'provider_id' | 'model'
  > | undefined;
  if (!parent
    || parent.runtime_binding_state !== 'bound'
    || !isRuntimeId(parent.runtime_pin)
    || !parent.provider_id
    || !parent.model) {
    throw new Error('SUBAGENT_PARENT_RUNTIME_UNBOUND: bind or recover the parent chat before starting a managed child.');
  }
  if (parent.runtime_pin !== input.runtime) {
    throw new Error(`SUBAGENT_RUNTIME_OWNERSHIP_CONFLICT: parent owner is ${parent.runtime_pin}, child requested ${input.runtime}.`);
  }
  const logicalRunId = normalizeLogicalRunId(input.logicalRunId, input.id);
  const workflowId = normalizeSubagentWorkflowKey(input.workflowId, 'workflow_id');
  const taskKey = normalizeSubagentWorkflowKey(input.taskKey, 'task_key');
  const dependencyTaskKeys = [...new Set(input.dependencyTaskKeys || [])].map(
    key => normalizeSubagentWorkflowKey(key, 'task_key'),
  );
  if ((workflowId && !taskKey) || (!workflowId && taskKey)) {
    throw new Error('workflow_id and task_key must be provided together.');
  }
  if (dependencyTaskKeys.length > 0 && (!workflowId || !taskKey)) {
    throw new Error('Dependent Sub-agent tasks require workflow_id and task_key.');
  }
  if (taskKey && dependencyTaskKeys.includes(taskKey)) {
    throw new Error('A Sub-agent task cannot depend on itself.');
  }
  const dispatchState = dependencyTaskKeys.length > 0 ? 'queued' : 'executing';
  const initialActivity = dependencyTaskKeys.length > 0
    ? `Waiting for dependencies: ${dependencyTaskKeys.join(', ')}`.slice(0, 500)
    : 'Starting Sub-agent';
  const now = subagentTimestamp();
  db.transaction(() => {
    const latest = input.logicalRunId
      ? db.prepare(`
          SELECT id, status, phase, terminal
          FROM subagent_runs
          WHERE parent_session_id = ? AND logical_run_id = ?
          ORDER BY attempt_number DESC, rowid DESC
          LIMIT 1
        `).get(input.parentSessionId, logicalRunId) as Pick<
          SubagentRunRecord,
          'id' | 'status' | 'phase' | 'terminal'
        > | undefined
      : undefined;
    if (latest?.terminal === 0) {
      throw new SubagentLogicalRunConflictError(
        'LOGICAL_RUN_STILL_RUNNING',
        logicalRunId,
        latest.id,
        latest.status,
        latest.phase,
      );
    }
    if (latest?.status === 'completed') {
      throw new SubagentLogicalRunConflictError(
        'LOGICAL_RUN_ALREADY_COMPLETED',
        logicalRunId,
        latest.id,
        latest.status,
        latest.phase,
      );
    }
    if (workflowId && taskKey) {
      const existingTask = db.prepare(`
        SELECT id, logical_run_id, status, phase
        FROM subagent_runs
        WHERE parent_session_id = ?
          AND workflow_id = ?
          AND task_key = ?
        ORDER BY attempt_number DESC, rowid DESC
        LIMIT 1
      `).get(input.parentSessionId, workflowId, taskKey) as Pick<
        SubagentRunRecord,
        'id' | 'logical_run_id' | 'status' | 'phase'
      > | undefined;
      const isExplicitRetry = Boolean(
        input.logicalRunId
        && existingTask
        && existingTask.logical_run_id === logicalRunId,
      );
      if (existingTask && !isExplicitRetry) {
        throw new SubagentLogicalRunConflictError(
          'DUPLICATE_TASK_KEY',
          `${workflowId}:${taskKey}`,
          existingTask.id,
          existingTask.status,
          existingTask.phase,
        );
      }
      assertNoSubagentWorkflowCycle(
        db,
        input.parentSessionId,
        workflowId,
        taskKey,
        dependencyTaskKeys,
      );
    }
    const previous = db.prepare(`
      SELECT COALESCE(MAX(attempt_number), 0) AS max_attempt
      FROM subagent_runs
      WHERE parent_session_id = ? AND logical_run_id = ?
    `).get(input.parentSessionId, logicalRunId) as { max_attempt: number };
    const attemptNumber = previous.max_attempt + 1;
    db.prepare(`
      INSERT INTO subagent_runs (
        id,
        logical_run_id,
        attempt_number,
        parent_session_id,
        runtime,
        tool_name,
        agent_name,
        provider_id,
        requested_model,
        workflow_id,
        task_key,
        dependencies_json,
        dispatch_state,
        prompt,
        status,
        phase,
        terminal,
        current_activity,
        last_activity_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'running', 0, ?, ?, ?, ?)
    `).run(
      input.id,
      logicalRunId,
      attemptNumber,
      input.parentSessionId,
      input.runtime,
      input.toolName,
      input.agentName,
      input.providerId || '',
      input.requestedModel || '',
      workflowId,
      taskKey,
      JSON.stringify(dependencyTaskKeys),
      dispatchState,
      input.prompt || '',
      initialActivity,
      now,
      now,
      now,
    );
    const run = db.prepare('SELECT * FROM subagent_runs WHERE id = ?')
      .get(input.id) as SubagentRunRecord;
    insertSubagentRunEvent(db, run, {
      type: 'started',
      activity: initialActivity,
      payload: {
        requestedProviderId: input.providerId || undefined,
        requestedModel: input.requestedModel || undefined,
        attemptNumber,
        workflowId: workflowId || undefined,
        taskKey: taskKey || undefined,
        dependencies: dependencyTaskKeys,
        dispatchState,
      },
    }, now);
  })();
  return getSubagentRun(input.id)!;
}

export function getSubagentRun(id: string): SubagentRunRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM subagent_runs WHERE id = ?')
    .get(id) as SubagentRunRecord | undefined;
}

export function getLatestSubagentRunByWorkflowTask(
  parentSessionId: string,
  workflowId: string,
  taskKey: string,
): SubagentRunRecord | undefined {
  return getDb().prepare(`
    SELECT *
    FROM subagent_runs
    WHERE parent_session_id = ?
      AND workflow_id = ?
      AND task_key = ?
    ORDER BY attempt_number DESC, rowid DESC
    LIMIT 1
  `).get(parentSessionId, workflowId, taskKey) as SubagentRunRecord | undefined;
}

export function markSubagentRunExecuting(
  id: string,
  activity = 'Starting Sub-agent',
): SubagentRunRecord | undefined {
  const db = getDb();
  const now = subagentTimestamp();
  const boundedActivity = activity.slice(0, 500);
  db.transaction(() => {
    const run = db.prepare('SELECT * FROM subagent_runs WHERE id = ?')
      .get(id) as SubagentRunRecord | undefined;
    if (!run || run.terminal === 1) return;
    db.prepare(`
      UPDATE subagent_runs
      SET dispatch_state = 'executing',
          current_activity = ?,
          last_activity_at = ?,
          updated_at = ?
      WHERE id = ? AND terminal = 0
    `).run(boundedActivity, now, now, id);
    insertSubagentRunEvent(db, run, {
      type: 'activity',
      activity: boundedActivity,
      payload: { dispatchState: 'executing' },
      coalesceKey: 'dispatch-state',
    }, now);
  })();
  return getSubagentRun(id);
}

export function listSubagentRuns(
  parentSessionId: string,
  options?: { limit?: number },
): SubagentRunRecord[] {
  const requestedLimit = options?.limit ?? 10;
  const limit = Math.max(1, Math.min(20, Math.trunc(requestedLimit) || 10));
  return getDb()
    .prepare(`
      SELECT *
      FROM subagent_runs
      WHERE parent_session_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `)
    .all(parentSessionId, limit) as SubagentRunRecord[];
}

/** Latest physical attempt for each logical task, for parent/UI summaries. */
export function listLatestSubagentRuns(
  parentSessionId: string,
  options?: { limit?: number },
): SubagentRunRecord[] {
  const requestedLimit = options?.limit ?? 10;
  const limit = Math.max(1, Math.min(20, Math.trunc(requestedLimit) || 10));
  return getDb().prepare(`
    SELECT run.*
    FROM subagent_runs AS run
    INNER JOIN (
      SELECT logical_run_id, MAX(attempt_number) AS latest_attempt
      FROM subagent_runs
      WHERE parent_session_id = ?
      GROUP BY logical_run_id
    ) AS latest
      ON latest.logical_run_id = run.logical_run_id
     AND latest.latest_attempt = run.attempt_number
    WHERE run.parent_session_id = ?
    ORDER BY run.updated_at DESC, run.rowid DESC
    LIMIT ?
  `).all(parentSessionId, parentSessionId, limit) as SubagentRunRecord[];
}

export function listSubagentRunAttempts(
  parentSessionId: string,
  logicalRunId: string,
): SubagentRunRecord[] {
  return getDb().prepare(`
    SELECT *
    FROM subagent_runs
    WHERE parent_session_id = ? AND logical_run_id = ?
    ORDER BY attempt_number ASC, rowid ASC
  `).all(parentSessionId, logicalRunId) as SubagentRunRecord[];
}

export function listSubagentRunEvents(
  parentSessionId: string,
  logicalRunId: string,
  options?: { limit?: number; afterCursor?: number },
): SubagentRunEventRecord[] {
  const requestedLimit = options?.limit ?? SUBAGENT_RUN_EVENT_LIMIT_PER_ATTEMPT;
  const limit = Math.max(
    1,
    Math.min(SUBAGENT_RUN_EVENT_LIMIT_PER_ATTEMPT, Math.trunc(requestedLimit) || 100),
  );
  const afterCursor = Math.max(0, Math.trunc(options?.afterCursor || 0));
  const db = getDb();
  if (afterCursor > 0) {
    return db.prepare(`
      SELECT event.*
      FROM subagent_run_events AS event
      INNER JOIN subagent_runs AS run ON run.id = event.run_id
      WHERE run.parent_session_id = ?
        AND event.logical_run_id = ?
        AND event.cursor > ?
      ORDER BY event.cursor ASC
      LIMIT ?
    `).all(parentSessionId, logicalRunId, afterCursor, limit) as SubagentRunEventRecord[];
  }
  const rows = db.prepare(`
    SELECT event.*
    FROM subagent_run_events AS event
    INNER JOIN subagent_runs AS run ON run.id = event.run_id
    WHERE run.parent_session_id = ? AND event.logical_run_id = ?
    ORDER BY event.cursor DESC
    LIMIT ?
  `).all(parentSessionId, logicalRunId, limit) as SubagentRunEventRecord[];
  return rows.reverse();
}

export function recordSubagentRunEvent(
  id: string,
  input: RecordSubagentRunEventInput,
): SubagentRunEventRecord | undefined {
  const db = getDb();
  const now = subagentTimestamp();
  let event: SubagentRunEventRecord | undefined;
  db.transaction(() => {
    const run = db.prepare('SELECT * FROM subagent_runs WHERE id = ?')
      .get(id) as SubagentRunRecord | undefined;
    if (!run || run.terminal === 1) return;
    const activity = input.activity?.slice(0, 500) || '';
    db.prepare(`
      UPDATE subagent_runs
      SET current_activity = CASE WHEN ? = '' THEN current_activity ELSE ? END,
          last_activity_at = ?,
          updated_at = ?
      WHERE id = ? AND terminal = 0
    `).run(activity, activity, now, now, id);
    event = insertSubagentRunEvent(db, run, {
      ...input,
      activity,
    }, now);
  })();
  return event;
}

export function markSubagentRunSettling(
  id: string,
  activity = 'Finalizing Sub-agent result',
): SubagentRunRecord | undefined {
  const db = getDb();
  const now = subagentTimestamp();
  db.transaction(() => {
    const run = db.prepare('SELECT * FROM subagent_runs WHERE id = ?')
      .get(id) as SubagentRunRecord | undefined;
    if (!run || run.terminal === 1) return;
    db.prepare(`
      UPDATE subagent_runs
      SET phase = 'settling',
          dispatch_state = 'settling',
          current_activity = ?,
          last_activity_at = ?,
          updated_at = ?
      WHERE id = ? AND terminal = 0
    `).run(activity.slice(0, 500), now, now, id);
    insertSubagentRunEvent(db, run, {
      type: 'settling',
      activity: activity.slice(0, 500),
      coalesceKey: 'settling',
    }, now);
  })();
  return getSubagentRun(id);
}

/**
 * Persist bounded in-flight child output/model facts without manufacturing a
 * terminal state. A late checkpoint after the first terminal update is a no-op.
 */
export function checkpointSubagentRun(
  id: string,
  input: CheckpointSubagentRunInput,
): SubagentRunRecord | undefined {
  const db = getDb();
  const now = subagentTimestamp();
  const hasResultText = input.resultText !== undefined;
  const hasEffectiveProviderId = (
    input.effectiveProviderId !== undefined
    && input.effectiveProviderId !== ''
  );
  const hasEffectiveModel = input.effectiveModel !== undefined && input.effectiveModel !== '';
  const activity = input.currentActivity?.slice(0, 500) || '';
  const resultText = hasResultText
    ? (input.resultText || '').slice(-SUBAGENT_RUN_CHECKPOINT_MAX_CHARS)
    : '';
  db.prepare(`
    UPDATE subagent_runs
    SET
      result_text = CASE WHEN ? = 1 THEN ? ELSE result_text END,
      effective_provider_id = CASE WHEN ? = 1 THEN ? ELSE effective_provider_id END,
      effective_model = CASE WHEN ? = 1 THEN ? ELSE effective_model END,
      current_activity = CASE WHEN ? = '' THEN current_activity ELSE ? END,
      last_activity_at = ?,
      updated_at = ?
    WHERE id = ? AND terminal = 0
  `).run(
    hasResultText ? 1 : 0,
    resultText,
    hasEffectiveProviderId ? 1 : 0,
    input.effectiveProviderId || '',
    hasEffectiveModel ? 1 : 0,
    input.effectiveModel || '',
    activity,
    activity,
    now,
    now,
    id,
  );
  if (hasResultText) {
    recordSubagentRunEvent(id, {
      type: 'partial_result',
      activity: activity || 'Generating Sub-agent result',
      payload: { chars: resultText.length },
      coalesceKey: 'partial-result',
    });
  }
  return getSubagentRun(id);
}

/**
 * Move a running run to one immutable terminal state.
 *
 * The `terminal = 0` predicate prevents late/duplicate events from rewriting a
 * completed run. The existing row is returned even when this call lost that
 * race, so callers can continue using the first terminal fact.
 */
export function settleSubagentRun(
  id: string,
  input: SettleSubagentRunInput,
): SubagentRunRecord | undefined {
  const db = getDb();
  const now = subagentTimestamp();
  const errorJson = input.error ? JSON.stringify(input.error) : '';
  db.transaction(() => {
    const run = db.prepare('SELECT * FROM subagent_runs WHERE id = ?')
      .get(id) as SubagentRunRecord | undefined;
    if (!run || run.terminal === 1) return;
    const resultText = input.resultText === undefined ? run.result_text : input.resultText;
    const effectiveProviderId = input.effectiveProviderId || run.effective_provider_id;
    const effectiveModel = input.effectiveModel || run.effective_model;
    const structured = buildDelegatedAgentResult(
      run,
      input,
      resultText,
      effectiveProviderId,
      effectiveModel,
    );
    db.prepare(`
      UPDATE subagent_runs
      SET
        status = ?,
        phase = 'terminal',
        dispatch_state = 'terminal',
        terminal = 1,
        result_text = ?,
        result_json = ?,
        effective_provider_id = ?,
        effective_model = ?,
        current_activity = ?,
        last_activity_at = ?,
        error_json = ?,
        updated_at = ?,
        completed_at = ?
      WHERE id = ? AND terminal = 0
    `).run(
      input.status,
      resultText,
      JSON.stringify(structured),
      effectiveProviderId,
      effectiveModel,
      `Sub-agent ${input.status}`,
      now,
      errorJson,
      now,
      now,
      id,
    );
    insertSubagentRunEvent(db, run, {
      type: 'terminal',
      activity: `Sub-agent ${input.status}`,
      payload: {
        status: input.status,
        error: input.error,
      },
      coalesceKey: 'terminal',
    }, now);
  })();
  return getSubagentRun(id);
}

/**
 * Converge every foreground child owned by a stopped parent session.
 *
 * Runtime adapters still receive their AbortSignal so subprocesses/turns can
 * stop naturally. This database barrier is independent of whether a parent
 * SDK waits for an in-flight tool handler to return: once Stop is accepted,
 * no child capsule may remain queued/running indefinitely.
 */
export function cancelSubagentRunsForParentSession(
  parentSessionId: string,
  message = 'Parent turn stopped before the Sub-agent reached a terminal result.',
): string[] {
  const db = getDb();
  const cancelledIds: string[] = [];
  const now = subagentTimestamp();
  db.transaction(() => {
    const runs = db.prepare(`
      SELECT *
      FROM subagent_runs
      WHERE parent_session_id = ? AND terminal = 0
      ORDER BY created_at ASC, rowid ASC
    `).all(parentSessionId) as SubagentRunRecord[];
    for (const run of runs) {
      const resultText = run.result_text || message;
      const structured = buildDelegatedAgentResult(
        run,
        {
          status: 'cancelled',
          resultText,
        },
        resultText,
        run.effective_provider_id,
        run.effective_model,
      );
      const updated = db.prepare(`
        UPDATE subagent_runs
        SET status = 'cancelled',
            phase = 'terminal',
            dispatch_state = 'terminal',
            terminal = 1,
            result_text = ?,
            result_json = ?,
            current_activity = 'Sub-agent cancelled',
            last_activity_at = ?,
            error_json = '',
            updated_at = ?,
            completed_at = ?
        WHERE id = ? AND terminal = 0
      `).run(
        resultText,
        JSON.stringify(structured),
        now,
        now,
        now,
        run.id,
      );
      if (updated.changes !== 1) continue;
      cancelledIds.push(run.id);
      insertSubagentRunEvent(db, run, {
        type: 'terminal',
        activity: 'Sub-agent cancelled',
        payload: {
          status: 'cancelled',
          source: 'parent_stop',
        },
        coalesceKey: 'terminal',
      }, now);
    }
  })();
  return cancelledIds;
}

// ==========================================
// Message Operations
// ==========================================

export function getMessages(
  sessionId: string,
  options?: { limit?: number; beforeRowId?: number; excludeHeartbeatAck?: boolean },
): { messages: Message[]; hasMore: boolean } {
  const db = getDb();
  const limit = options?.limit ?? 100;
  const beforeRowId = options?.beforeRowId;
  const ackFilter = options?.excludeHeartbeatAck ? ' AND is_heartbeat_ack = 0' : '';

  let rows: Message[];
  if (beforeRowId) {
    // Fetch `limit + 1` rows before the cursor to detect if there are more
    rows = db.prepare(
      `SELECT *, rowid as _rowid FROM messages WHERE session_id = ? AND rowid < ?${ackFilter} ORDER BY rowid DESC LIMIT ?`
    ).all(sessionId, beforeRowId, limit + 1) as Message[];
  } else {
    // Fetch the most recent `limit + 1` messages
    rows = db.prepare(
      `SELECT *, rowid as _rowid FROM messages WHERE session_id = ?${ackFilter} ORDER BY rowid DESC LIMIT ?`
    ).all(sessionId, limit + 1) as Message[];
  }

  const hasMore = rows.length > limit;
  if (hasMore) {
    rows = rows.slice(0, limit);
  }

  // Reverse to chronological order (ASC)
  rows.reverse();
  return { messages: rows, hasMore };
}

/**
 * Phase 3 Step 4: addMessage accepts optional `metadata` for callers
 * that need to associate a message with a `task_run_logs` row (the
 * agent task runner does this for both the user prompt and the
 * assistant result). The metadata is stored on the row, NEVER appended
 * to `content`, so prompt builders constructing LLM context only see
 * the actual conversation text. Backwards compatible — existing
 * call sites still pass `tokenUsage` as the 4th positional arg.
 */
export function addMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  tokenUsage?: string | null,
  metadata?: {
    task_run_id?: string | null;
    stream_status?: 'streaming' | 'completed' | 'interrupted' | 'error';
  },
): Message {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const taskRunId = metadata?.task_run_id ?? null;
  const streamStatus = metadata?.stream_status ?? 'completed';
  const insertMessage = db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at, token_usage, task_run_id, stream_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const updateSession = db.prepare(
    'UPDATE chat_sessions SET updated_at = ? WHERE id = ?',
  );
  const readMessage = db.prepare(
    'SELECT *, rowid as _rowid FROM messages WHERE id = ?',
  );

  return db.transaction((): Message => {
    insertMessage.run(id, sessionId, role, content, now, tokenUsage || null, taskRunId, streamStatus);
    updateSession.run(now, sessionId);
    const saved = readMessage.get(id) as Message | undefined;
    if (!saved) throw new Error('CODEPILOT_MESSAGE_PERSISTENCE_FAILED');
    return saved;
  })();
}

export function updateMessageContent(messageId: string, content: string): number {
  const db = getDb();
  const result = db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
  return result.changes;
}

/**
 * Update the single durable row owned by an assistant stream collector.
 * Checkpoints and terminal writes share the same message id, preventing a
 * refresh-recovered partial row from becoming a duplicate final response.
 */
export function updateMessageStreamCheckpoint(
  messageId: string,
  content: string,
  status: 'streaming' | 'completed' | 'interrupted' | 'error',
  tokenUsage?: string | null,
): number {
  const db = getDb();
  const result = db.prepare(
    'UPDATE messages SET content = ?, stream_status = ?, token_usage = ? WHERE id = ? AND role = ?'
  ).run(content, status, tokenUsage || null, messageId, 'assistant');
  return result.changes;
}

/**
 * Settle a collector-owned row without allowing a stale stream to append newer
 * content after its session lock was superseded.
 */
export function updateMessageStreamStatus(
  messageId: string,
  status: 'completed' | 'interrupted' | 'error',
): number {
  const db = getDb();
  return db.prepare(
    "UPDATE messages SET stream_status = ? WHERE id = ? AND role = 'assistant' AND stream_status = 'streaming'"
  ).run(status, messageId).changes;
}

/**
 * Startup recovery for a process that died between assistant checkpoints.
 * Exported so the exact production recovery operation can be exercised against
 * an isolated test database without restarting the test worker.
 */
export function recoverInterruptedMessageStreams(dbInstance: Database.Database = getDb()): number {
  return dbInstance.prepare(
    "UPDATE messages SET stream_status = 'interrupted' WHERE role = 'assistant' AND stream_status = 'streaming'"
  ).run().changes;
}

/**
 * Recover runtime-owned state after the previous CodePilot server process died.
 *
 * This must never run as part of schema initialization: Next.js may evaluate
 * separate route bundles with separate module instances while another request
 * is still streaming. Re-running this sweep from `initDb()` used to abort live
 * permissions, interrupt checkpoints, and delete their session locks.
 */
export function recoverRuntimeStateAfterProcessRestart(
  dbInstance: Database.Database = getDb(),
): void {
  dbInstance.transaction(() => {
    dbInstance.exec(`
      UPDATE media_jobs
      SET status = 'paused', updated_at = datetime('now')
      WHERE status = 'running'
    `);
    dbInstance.exec(`
      UPDATE media_job_items
      SET status = 'pending', updated_at = datetime('now')
      WHERE status = 'processing'
    `);
    dbInstance.exec(`
      UPDATE chat_sessions
      SET runtime_status = 'idle',
          runtime_error = 'Process restarted',
          runtime_updated_at = datetime('now')
      WHERE runtime_status IN ('running', 'streaming', 'waiting_permission')
    `);
    recoverInterruptedMessageStreams(dbInstance);
    dbInstance.exec('DELETE FROM session_runtime_locks');
    dbInstance.exec(`
      UPDATE permission_requests
      SET status = 'aborted',
          resolved_at = datetime('now'),
          message = 'Process restarted'
      WHERE status = 'pending'
    `);
    const interruptedRuns = dbInstance.prepare(
      'SELECT * FROM subagent_runs WHERE terminal = 0',
    ).all() as SubagentRunRecord[];
    const recoveryError: SubagentStatusError = {
      code: 'RUNTIME_ERROR',
      retryable: true,
    };
    const recoveryMessage = 'Process restarted before the Sub-agent reached a durable terminal state.';
    const now = subagentTimestamp();
    for (const run of interruptedRuns) {
      const structured = buildDelegatedAgentResult(
        run,
        {
          status: 'failed',
          resultText: run.result_text,
          error: recoveryError,
        },
        run.result_text,
        run.effective_provider_id,
        run.effective_model,
      );
      dbInstance.prepare(`
        UPDATE subagent_runs
        SET status = 'failed',
            phase = 'terminal',
            dispatch_state = 'terminal',
            terminal = 1,
            result_json = ?,
            current_activity = 'Sub-agent failed',
            last_activity_at = ?,
            error_json = ?,
            updated_at = ?,
            completed_at = ?
        WHERE id = ? AND terminal = 0
      `).run(
        JSON.stringify(structured),
        now,
        JSON.stringify({ ...recoveryError, message: recoveryMessage }),
        now,
        now,
        run.id,
      );
      insertSubagentRunEvent(dbInstance, run, {
        type: 'terminal',
        activity: 'Sub-agent failed',
        payload: {
          status: 'failed',
          error: { ...recoveryError, message: recoveryMessage },
          recoveredAfterRestart: true,
        },
        coalesceKey: 'terminal',
      }, now);
    }
  })();
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readRuntimeOwner(): RuntimeOwnerRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_OWNER_PATH, 'utf8')) as Partial<RuntimeOwnerRecord>;
    if (
      typeof parsed.pid === 'number'
      && typeof parsed.token === 'string'
      && typeof parsed.claimedAt === 'string'
    ) {
      return parsed as RuntimeOwnerRecord;
    }
  } catch {
    // Missing/corrupt owner is treated as stale and replaced under the lock.
  }
  return undefined;
}

function writeRuntimeOwner(owner: RuntimeOwnerRecord): void {
  // The runtime-owner lock is held by the caller, so a direct replacement is
  // cross-platform safe (Windows rename cannot atomically replace an existing
  // file). A torn write can only happen if this process dies; the next process
  // treats the corrupt record as stale and performs recovery.
  fs.writeFileSync(RUNTIME_OWNER_PATH, JSON.stringify(owner), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function withRuntimeOwnerLock<T>(fn: () => T): T {
  const maxWait = 10_000;
  const startedAt = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(
        RUNTIME_OWNER_LOCK_PATH,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      fs.closeSync(fd);
      try {
        return fn();
      } finally {
        try { fs.unlinkSync(RUNTIME_OWNER_LOCK_PATH); } catch { /* ignore */ }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - startedAt > maxWait) {
        try { fs.unlinkSync(RUNTIME_OWNER_LOCK_PATH); } catch { /* ignore */ }
        continue;
      }
      const waitUntil = Date.now() + 50 + Math.random() * 100;
      while (Date.now() < waitUntil) { /* sync DB initialization */ }
    }
  }
}

function shouldSkipAutomaticRuntimeRecovery(): boolean {
  if (process.env.CODEPILOT_DISABLE_DB_MIGRATION_IN_TESTS === '1') return true;
  if (process.env.NEXT_PHASE === 'phase-production-build') return true;
  return process.env.npm_lifecycle_event === 'build'
    || process.env.npm_lifecycle_event === 'electron:build';
}

/**
 * Claim the DB runtime owner once per live CodePilot server process.
 *
 * Multiple Next route/module instances share the claim through the owner file.
 * A live PID always wins fail-closed: another module must not "recover" state
 * that process may still own. A dead/missing PID is the only automatic signal
 * that permits the destructive recovery sweep.
 */
export function runRuntimeStartupRecoveryOnce(
  dbInstance: Database.Database = getDb(),
): boolean {
  if (shouldSkipAutomaticRuntimeRecovery()) return false;
  const state = getDatabaseProcessState();
  if (state.runtimeOwnerToken) return false;

  return withRuntimeOwnerLock(() => {
    const existing = readRuntimeOwner();
    if (existing && isProcessAlive(existing.pid)) {
      if (existing.pid === process.pid) {
        state.runtimeOwnerToken = existing.token;
      }
      return false;
    }

    const owner: RuntimeOwnerRecord = {
      pid: process.pid,
      token: crypto.randomBytes(16).toString('hex'),
      claimedAt: new Date().toISOString(),
    };
    writeRuntimeOwner(owner);
    state.runtimeOwnerToken = owner.token;
    recoverRuntimeStateAfterProcessRestart(dbInstance);
    return true;
  });
}

export function updateMessageHeartbeatAck(messageId: string, isAck: boolean): void {
  const db = getDb();
  db.prepare('UPDATE messages SET is_heartbeat_ack = ? WHERE id = ?').run(isAck ? 1 : 0, messageId);
}

/**
 * Find the most recent assistant message in a session that contains an image-gen-request,
 * update its content, and return the real message ID. Used as fallback when the frontend
 * only has a temporary message ID.
 *
 * Prefers exact match on rawRequestBlock (the full ```image-gen-request...``` fence).
 * Falls back to prompt hint prefix match if rawRequestBlock is unavailable or doesn't match.
 */
export function updateMessageBySessionAndHint(
  sessionId: string,
  content: string,
  rawRequestBlock?: string,
  promptHint?: string,
): { changes: number; messageId?: string } {
  const db = getDb();

  // Strategy 1: Exact match on the raw ```image-gen-request...``` block content.
  // This is unambiguous even when multiple requests share the same prompt.
  if (rawRequestBlock) {
    const escaped = rawRequestBlock.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const row = db.prepare(
      "SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' AND content LIKE ? ESCAPE '\\' AND content NOT LIKE '%image-gen-result%' ORDER BY created_at DESC LIMIT 1"
    ).get(sessionId, `%${escaped}%`) as { id: string } | undefined;
    if (row) {
      const result = db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, row.id);
      return { changes: result.changes, messageId: row.id };
    }
  }

  // Strategy 2: Fallback to prompt hint prefix match (legacy path).
  if (promptHint) {
    const row = db.prepare(
      "SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' AND content LIKE '%image-gen-request%' AND content NOT LIKE '%image-gen-result%' AND content LIKE ? ORDER BY created_at DESC LIMIT 1"
    ).get(sessionId, `%${promptHint.slice(0, 60)}%`) as { id: string } | undefined;
    if (row) {
      const result = db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, row.id);
      return { changes: result.changes, messageId: row.id };
    }
  }

  return { changes: 0 };
}

export function clearSessionMessages(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  // Reset SDK session ID so next message starts fresh
  db.prepare('UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?').run('', sessionId);
}

// ==========================================
// Session History Search (codepilot_session_search tool)
// ==========================================

export interface SessionSearchResult {
  messageId: string;
  sessionId: string;
  sessionTitle: string;
  role: 'user' | 'assistant';
  createdAt: string;
  /** Snippet extracted from content with query context (up to ~200 chars). */
  snippet: string;
  /** Derived message type for search UI icons/filtering. */
  contentType: 'user' | 'assistant' | 'tool';
}

/**
 * Full-text search across message history.
 *
 * Uses SQL LIKE for portability (no FTS5 dependency). Matches are case-insensitive
 * via LIKE's default behavior with ASCII text. For CJK queries the match is exact
 * byte-sequence substring — good enough for v1.
 *
 * Results are ordered by created_at DESC (most recent first) and joined with
 * chat_sessions to include session titles. Heartbeat ACK messages are excluded
 * from results when the schema has that column.
 *
 * @param query Search term. Wildcards `_` and `%` are treated as literals.
 * @param options.sessionId Optional filter to a specific session.
 * @param options.limit Max results (default 5).
 */
export function searchMessages(
  query: string,
  options: { sessionId?: string; limit?: number } = {},
): SessionSearchResult[] {
  const db = getDb();
  const limit = Math.max(1, Math.min(options.limit ?? 5, 100));

  if (!query || query.trim() === '') return [];

  // Escape LIKE wildcards in the user query so they're treated as literals.
  const escapedQuery = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const pattern = `%${escapedQuery}%`;

  // Detect optional heartbeat ack column (newer schemas have it)
  let hasAckColumn = false;
  try {
    const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    hasAckColumn = cols.some(c => c.name === 'is_heartbeat_ack');
  } catch { /* ignore — assume no ack column */ }

  const ackFilter = hasAckColumn ? ' AND (m.is_heartbeat_ack = 0 OR m.is_heartbeat_ack IS NULL)' : '';

  let sql = `
    SELECT
      m.id AS messageId,
      m.session_id AS sessionId,
      COALESCE(s.title, '(untitled)') AS sessionTitle,
      m.role AS role,
      m.created_at AS createdAt,
      m.content AS content
    FROM messages m
    LEFT JOIN chat_sessions s ON s.id = m.session_id
    WHERE m.content LIKE ? ESCAPE '\\'${ackFilter}
  `;
  const params: unknown[] = [pattern];

  if (options.sessionId) {
    sql += ' AND m.session_id = ?';
    params.push(options.sessionId);
  }

  sql += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    messageId: string;
    sessionId: string;
    sessionTitle: string;
    role: 'user' | 'assistant';
    createdAt: string;
    content: string;
  }>;

  // Build snippet around the first match position in each row.
  const lowerQuery = query.toLowerCase();
  return rows.map(row => ({
    messageId: row.messageId,
    sessionId: row.sessionId,
    sessionTitle: row.sessionTitle,
    role: row.role,
    createdAt: row.createdAt,
    snippet: buildSnippet(row.content, lowerQuery),
    contentType: deriveContentType(row.role, row.content),
  }));
}

function deriveContentType(role: 'user' | 'assistant', content: string): 'user' | 'assistant' | 'tool' {
  if (role === 'user') return 'user';
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      if (parsed.some((b: unknown) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_use')) {
        return 'tool';
      }
    }
  } catch {
    // fallback to plain text assistant
  }
  return 'assistant';
}

/** Extract a ~140-char snippet with the match near the front so it survives single-line truncation in UI lists. */
function buildSnippet(content: string, lowerQuery: string): string {
  if (!content) return '';
  const lowerContent = content.toLowerCase();
  const idx = lowerContent.indexOf(lowerQuery);
  if (idx === -1) {
    // Fall back to the first 200 chars — happens when content is a JSON blob
    // and the query matches bytes inside quoted strings.
    return content.length > 200 ? content.slice(0, 200) + '…' : content;
  }
  const LEADING = 28;
  const TAIL = 100;
  const start = Math.max(0, idx - LEADING);
  const end = Math.min(content.length, idx + lowerQuery.length + TAIL);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end) + suffix;
}

// ==========================================
// Settings Operations
// ==========================================

export function getSetting(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

/**
 * Commit a setting only while it is still absent or blank.
 *
 * Default-assistant bootstrap uses this as its commit point. Filesystem
 * initialization may race with an explicit Settings save, but the user's
 * explicit non-blank value always wins because this decision is made by one
 * SQLite statement instead of a read-then-write pair in application code.
 */
export function compareAndSetSettingIfBlank(key: string, value: string): boolean {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE trim(settings.value) = ''
  `).run(key, value);
  return result.changes === 1;
}

export function getAllSettings(): SettingsMap {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: SettingsMap = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

// ==========================================
// Session Status Operations
// ==========================================

export function updateSessionStatus(id: string, status: 'active' | 'archived'): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET status = ? WHERE id = ?').run(status, id);
}

// ==========================================
// Task Operations
// ==========================================

export function getTasksBySession(sessionId: string): TaskItem[] {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY sort_order ASC, created_at ASC').all(sessionId) as TaskItem[];
}

export function getTask(id: string): TaskItem | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskItem | undefined;
}

export function createTask(sessionId: string, title: string, description?: string): TaskItem {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    'INSERT INTO tasks (id, session_id, title, status, description, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, sessionId, title, 'pending', description || null, 'user', now, now);

  return getTask(id)!;
}

export function updateTask(id: string, updates: { title?: string; status?: TaskStatus; description?: string }): TaskItem | undefined {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const existing = getTask(id);
  if (!existing) return undefined;

  const title = updates.title ?? existing.title;
  const status = updates.status ?? existing.status;
  const description = updates.description !== undefined ? updates.description : existing.description;

  db.prepare(
    'UPDATE tasks SET title = ?, status = ?, description = ?, updated_at = ? WHERE id = ?'
  ).run(title, status, description, now, id);

  return getTask(id);
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Sync SDK tasks (from TodoWrite tool) into the tasks table.
 * Replace-all strategy: delete all source='sdk' tasks for this session,
 * then insert the new list. User-created tasks (source='user') are untouched.
 */
export function syncSdkTasks(
  sessionId: string,
  todos: Array<{ id: string; content: string; status: string; activeForm?: string }>
): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // Map SDK status to local TaskStatus
  const mapStatus = (s: string): TaskStatus => {
    switch (s) {
      case 'completed': return 'completed';
      case 'in_progress': return 'in_progress';
      case 'pending': return 'pending';
      default: return 'pending';
    }
  };

  console.log('[db] syncSdkTasks:', sessionId, 'todos count:', todos.length);

  const txn = db.transaction(() => {
    // Delete all SDK-sourced tasks for this session
    db.prepare("DELETE FROM tasks WHERE session_id = ? AND source = 'sdk'").run(sessionId);

    // Insert new SDK tasks with stable sort_order
    const insert = db.prepare(
      'INSERT INTO tasks (id, session_id, title, status, description, source, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < todos.length; i++) {
      const todo = todos[i];
      const taskId = `sdk-${sessionId}-${todo.id}`;
      insert.run(taskId, sessionId, todo.content, mapStatus(todo.status), todo.activeForm || null, 'sdk', i, now, now);
    }
  });
  txn();
}

// ==========================================
// API Provider Operations
// ==========================================

interface ApiProviderStorageRow extends ApiProvider {
  api_key_ciphertext: string;
  api_key_storage: string;
}

interface StoredProviderSecret {
  plaintext: string;
  ciphertext: string;
  storage: string;
}

const providerSecretErrors = new Map<string, string>();

function providerSecretErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'provider_secret_unknown_error';
  if (error.message.startsWith('provider_secret_')) return error.message;
  return 'provider_secret_decrypt_failed';
}

/**
 * Return only the low-cardinality failure code for a provider secret that was
 * materialized unsuccessfully. Callers use this to distinguish an unreadable
 * encrypted credential from a provider that was intentionally saved empty;
 * ciphertext and key material never leave this module.
 */
export function getProviderSecretErrorCode(providerId: string): string | null {
  return providerSecretErrors.get(providerId) ?? null;
}

function encodeProviderSecret(providerId: string, plaintext: string): StoredProviderSecret {
  if (!plaintext) return { plaintext: '', ciphertext: '', storage: 'none' };
  const environment = getProviderSecretEnvironmentStatus();
  if (!environment.available) {
    return { plaintext, ciphertext: '', storage: 'legacy_plaintext' };
  }

  const ciphertext = encryptProviderSecret(providerId, plaintext);
  if (decryptProviderSecret(providerId, ciphertext) !== plaintext) {
    throw new Error('provider_secret_roundtrip_failed');
  }
  return {
    plaintext: '',
    ciphertext,
    storage: providerSecretStorageKind(),
  };
}

function materializeProvider(row: ApiProviderStorageRow | undefined): ApiProvider | undefined {
  if (!row) return undefined;
  const { api_key_ciphertext: ciphertext, ...provider } = row;
  // A non-empty plaintext column means migration did not complete or an older
  // build wrote a newer key after rollback. In that mixed state the plaintext
  // is the current user value; trusting the ciphertext can resurrect a stale
  // key or make the provider unusable after moving the database to a machine
  // with a different data-encryption key.
  // A plaintext value can remain because a legacy-secret migration failed.
  // Keep that migration diagnostic until an explicit user key write succeeds;
  // merely reading the recoverable plaintext must not erase it.
  if (provider.api_key) return provider;
  if (!ciphertext) {
    providerSecretErrors.delete(row.id);
    return provider;
  }
  try {
    provider.api_key = decryptProviderSecret(row.id, ciphertext);
    providerSecretErrors.delete(row.id);
  } catch (error) {
    // Fail closed: a corrupt or inaccessible encrypted secret must never fall
    // back to a stale plaintext column or leak ciphertext through the API.
    provider.api_key = '';
    providerSecretErrors.set(row.id, providerSecretErrorCode(error));
  }
  return provider;
}

/**
 * Encrypt legacy plaintext provider keys in one transaction. Plaintext is
 * cleared only after an authenticated decrypt round-trip succeeds.
 */
export function migrateProviderSecrets(db: Database.Database): number {
  if (!getProviderSecretEnvironmentStatus().available) return 0;
  const rows = db.prepare(
    "SELECT id, api_key, api_key_ciphertext FROM api_providers WHERE api_key != ''",
  ).all() as Array<{ id: string; api_key: string; api_key_ciphertext: string }>;
  if (rows.length === 0) return 0;

  const update = db.prepare(
    "UPDATE api_providers SET api_key = '', api_key_ciphertext = ?, api_key_storage = ?, updated_at = datetime('now') WHERE id = ?",
  );
  let migrated = 0;
  const transaction = db.transaction(() => {
    for (const row of rows) {
      try {
        // Plaintext is authoritative whenever it exists. Always create a fresh
        // envelope instead of trusting a ciphertext that may belong to an
        // older key or another machine.
        const ciphertext = encryptProviderSecret(row.id, row.api_key);
        if (decryptProviderSecret(row.id, ciphertext) !== row.api_key) {
          throw new Error('provider_secret_migration_verification_failed');
        }
        update.run(ciphertext, providerSecretStorageKind(), row.id);
        providerSecretErrors.delete(row.id);
        migrated += 1;
      } catch (error) {
        // One damaged row must not abort getDb()/application startup. Keep its
        // plaintext intact so the user can still open Settings and repair it,
        // while diagnostics expose a non-secret error code.
        providerSecretErrors.set(row.id, providerSecretErrorCode(error));
      }
    }
  });
  transaction();
  return migrated;
}

export interface ProviderSecretStorageDiagnostics {
  available: boolean;
  backend: string;
  securityLevel: string;
  encryptedProviders: number;
  legacyPlaintextProviders: number;
  emptyProviders: number;
  lastErrorCode: string | null;
}

export function getProviderSecretStorageDiagnostics(): ProviderSecretStorageDiagnostics {
  const db = getDb();
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN api_key_ciphertext != '' THEN 1 ELSE 0 END) AS encrypted,
      SUM(CASE WHEN api_key != '' THEN 1 ELSE 0 END) AS legacy,
      SUM(CASE WHEN api_key = '' AND api_key_ciphertext = '' THEN 1 ELSE 0 END) AS empty
    FROM api_providers
  `).get() as { encrypted: number | null; legacy: number | null; empty: number | null };
  const environment = getProviderSecretEnvironmentStatus();
  return {
    available: environment.available,
    backend: environment.backend,
    securityLevel: environment.securityLevel,
    encryptedProviders: counts.encrypted ?? 0,
    legacyPlaintextProviders: counts.legacy ?? 0,
    emptyProviders: counts.empty ?? 0,
    lastErrorCode: providerSecretErrors.values().next().value ?? null,
  };
}

export function getAllProviders(): ApiProvider[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_providers ORDER BY sort_order ASC, created_at ASC').all() as ApiProviderStorageRow[];
  return rows.map(row => materializeProvider(row)!);
}

export function getProvider(id: string): ApiProvider | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(id) as ApiProviderStorageRow | undefined;
  return materializeProvider(row);
}

export function getActiveProvider(): ApiProvider | undefined {
  const db = getDb();
  const row = db.prepare('SELECT * FROM api_providers WHERE is_active = 1 LIMIT 1').get() as ApiProviderStorageRow | undefined;
  return materializeProvider(row);
}

export function createProvider(data: CreateProviderRequest): ApiProvider {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // Get max sort_order to append at end
  const maxRow = db.prepare('SELECT MAX(sort_order) as max_order FROM api_providers').get() as { max_order: number | null };
  const sortOrder = (maxRow.max_order ?? -1) + 1;
  const storedSecret = encodeProviderSecret(id, data.api_key || '');

  db.prepare(
    `INSERT INTO api_providers (id, name, provider_type, preset_key, protocol, base_url, api_key, api_key_ciphertext, api_key_storage, is_active, sort_order, extra_env, headers_json, env_overrides_json, role_models_json, options_json, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    data.name,
    data.provider_type || 'anthropic',
    data.preset_key || '',
    data.protocol || '',
    data.base_url || '',
    storedSecret.plaintext,
    storedSecret.ciphertext,
    storedSecret.storage,
    0,
    sortOrder,
    data.extra_env || '{}',
    data.headers_json || '{}',
    data.env_overrides_json || '',
    data.role_models_json || '{}',
    data.options_json || '{}',
    data.notes || '',
    now,
    now,
  );

  return getProvider(id)!;
}

export function updateProvider(id: string, data: UpdateProviderRequest): ApiProvider | undefined {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM api_providers WHERE id = ?').get(id) as ApiProviderStorageRow | undefined;
  if (!existing) return undefined;

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const name = data.name ?? existing.name;
  const providerType = data.provider_type ?? existing.provider_type;
  const presetKey = data.preset_key ?? existing.preset_key;
  const protocol = data.protocol ?? existing.protocol;
  const baseUrl = data.base_url ?? existing.base_url;
  const storedSecret = data.api_key === undefined
    ? {
        plaintext: existing.api_key,
        ciphertext: existing.api_key_ciphertext,
        storage: existing.api_key_storage,
      }
    : encodeProviderSecret(id, data.api_key);
  const extraEnv = data.extra_env ?? existing.extra_env;
  const headersJson = data.headers_json ?? existing.headers_json;
  const envOverridesJson = data.env_overrides_json ?? existing.env_overrides_json;
  const roleModelsJson = data.role_models_json ?? existing.role_models_json;
  const optionsJson = data.options_json ?? existing.options_json;
  const notes = data.notes ?? existing.notes;
  const sortOrder = data.sort_order ?? existing.sort_order;

  db.prepare(
    `UPDATE api_providers SET name = ?, provider_type = ?, preset_key = ?, protocol = ?, base_url = ?, api_key = ?, api_key_ciphertext = ?, api_key_storage = ?,
     extra_env = ?, headers_json = ?, env_overrides_json = ?, role_models_json = ?, options_json = ?,
     notes = ?, sort_order = ?, updated_at = ? WHERE id = ?`
  ).run(name, providerType, presetKey, protocol, baseUrl, storedSecret.plaintext, storedSecret.ciphertext, storedSecret.storage, extraEnv, headersJson, envOverridesJson, roleModelsJson, optionsJson, notes, sortOrder, now, id);

  // A successful explicit key write replaces (or intentionally clears) the
  // envelope that produced any prior decrypt error. Do not let the in-memory
  // diagnostic misclassify a now-empty provider as still unreadable.
  if (data.api_key !== undefined) providerSecretErrors.delete(id);

  return getProvider(id);
}

export function deleteProvider(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM api_providers WHERE id = ?').run(id);
  providerSecretErrors.delete(id);
  return result.changes > 0;
}

// ── Provider Options ────────────────────────────────────────────

/**
 * Get options for a provider. For 'env' provider, reads from settings table.
 * For DB providers, reads from options_json column.
 */
export function getProviderOptions(providerId: string): import('@/types').ProviderOptions {
  if (providerId === '__global__') {
    const defaultModel = getSetting('global_default_model') || undefined;
    const defaultModelProvider = getSetting('global_default_model_provider') || undefined;
    // default_mode is the Phase 2C source of truth for "did the user pin this?".
    // The init migration (see below) backfills it for existing rows so this
    // accessor always sees a coherent value: pre-2C users with a stored model
    // see 'pinned'; everyone else sees 'auto'.
    const rawMode = getSetting('global_default_mode');
    const defaultMode: 'auto' | 'pinned' = rawMode === 'pinned' ? 'pinned' : 'auto';
    return {
      default_mode: defaultMode,
      ...(defaultModel ? { default_model: defaultModel } : {}),
      ...(defaultModelProvider ? { default_model_provider: defaultModelProvider } : {}),
    };
  }
  if (providerId === 'env') {
    const thinkingMode = getSetting('thinking_mode') || 'adaptive';
    const context1m = getSetting('context_1m') === 'true';
    return {
      thinking_mode: thinkingMode as 'adaptive' | 'enabled' | 'disabled',
      context_1m: context1m,
    };
  }
  const provider = getProvider(providerId);
  if (!provider) return {};
  try {
    return JSON.parse(provider.options_json || '{}');
  } catch { return {}; }
}

/**
 * Set options for a provider. For 'env' provider, writes to settings table.
 * For DB providers, writes to options_json column.
 */
export function setProviderOptions(providerId: string, options: import('@/types').ProviderOptions): void {
  if (providerId === '__global__') {
    // Mode is authoritative. Setting mode='auto' must clear pinned values
    // unconditionally — and we must short-circuit before the per-field
    // writes below, because the API route merges incoming options with
    // existing storage. Without the early return, a `{ default_mode: 'auto' }`
    // request gets merged with stored `default_model_provider`, the merged
    // blob then re-writes the provider id we just cleared. Net result: no
    // clear. Same bug used to manifest as "I picked Auto but the resolver
    // still saw a pinned provider".
    if (options.default_mode === 'auto') {
      setSetting('global_default_mode', 'auto');
      setSetting('global_default_model', '');
      setSetting('global_default_model_provider', '');
      if ((options as Record<string, unknown>).legacy_default_provider_id !== undefined) {
        setSetting('default_provider_id', (options as Record<string, unknown>).legacy_default_provider_id as string);
      }
      return;
    }
    if (options.default_mode === 'pinned') setSetting('global_default_mode', 'pinned');
    if (options.default_model !== undefined) setSetting('global_default_model', options.default_model);
    if (options.default_model_provider !== undefined) setSetting('global_default_model_provider', options.default_model_provider);
    // Sync legacy default_provider_id so backend consumers (doctor, repair, etc.) stay consistent
    if ((options as Record<string, unknown>).legacy_default_provider_id !== undefined) {
      setSetting('default_provider_id', (options as Record<string, unknown>).legacy_default_provider_id as string);
    }
    return;
  }
  if (providerId === 'env') {
    if (options.thinking_mode !== undefined) setSetting('thinking_mode', options.thinking_mode);
    if (options.context_1m !== undefined) setSetting('context_1m', options.context_1m ? 'true' : '');
    return;
  }
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare('UPDATE api_providers SET options_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(options), now, providerId);
}

// ── Provider Models ─────────────────────────────────────────────

/** Active models only (enabled = 1) — back-compat for existing consumers. */
export function getModelsForProvider(providerId: string): import('@/types').ProviderModel[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM provider_models WHERE provider_id = ? AND enabled = 1 ORDER BY sort_order ASC, created_at ASC'
  ).all(providerId) as import('@/types').ProviderModel[];
}

/** All models including hidden — used by the Models management page. */
export function getAllModelsForProvider(providerId: string): import('@/types').ProviderModel[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM provider_models WHERE provider_id = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(providerId) as import('@/types').ProviderModel[];
}

/**
 * Align `enabled` per the catalog default list — i.e. "reset every
 * SYSTEM-MANAGED row to the recommended set". Manual choices are never
 * touched; this is the central invariant.
 *
 * A row is SYSTEM-MANAGED iff `user_edited=0` AND
 * `enable_source NOT IN ('manual_enabled','manual_hidden')`. Anything
 * else is USER-MANAGED and counts as `unchanged` (no decision emitted).
 *
 * For system-managed rows:
 *
 *   - Catalog defaults missing from DB → INSERT (source='catalog',
 *     enabled=1, enable_source='recommended')
 *   - In catalog, currently disabled → ENABLE + sync display_name /
 *     upstream / enable_source='recommended' so the badge matches
 *   - In catalog, currently enabled with stale display_name/upstream →
 *     refresh those fields (catalog-side rename propagation)
 *   - Not in catalog, source='catalog' → DELETE (stale catalog seed
 *     from when the provider matched a different preset)
 *   - Not in catalog, source='api'/'manual' → DISABLE +
 *     enable_source='discovered' (we found it but it isn't recommended)
 *
 * Critical: the `enabled` flag and `enable_source` MUST update together.
 * A row with `enabled=0, enable_source='recommended'` is internally
 * inconsistent — the badge would say "system enabled" while it's hidden.
 */
/**
 * The catalog fields these sync helpers propagate into provider_models.
 * Structural (not an import of CatalogModel) so db.ts stays free of a
 * provider-catalog dependency; callers pass catalog entries directly.
 */
type CatalogSyncModel = {
  modelId: string;
  upstreamModelId?: string;
  displayName: string;
  capabilities?: Record<string, unknown> | undefined;
  legacyFingerprints?: import('./catalog-model-identity').CatalogModelLegacyFingerprint[];
};

/**
 * Serialize catalog capabilities for the DB, or null meaning "leave the
 * existing column alone".
 *
 * Phase 1 fix (2026-07-17) — before this, both sync paths hard-wrote '{}',
 * so a materialized GLM/Kimi row shadowed the catalog (models GET and
 * provider-resolver both let a same-id DB row win) and the picker lost
 * supportsEffort / supportedEffortLevels / effortNoteKey: the Auto/High/Max
 * menu silently vanished for exactly the providers Phase 1 added it for.
 *
 * A catalog entry with no capabilities returns null rather than '{}': rows
 * can also carry API-discovered capabilities, and a catalog that is merely
 * silent must not erase them.
 */
function serializeCatalogCapabilities(m: CatalogSyncModel): string | null {
  if (!m.capabilities || Object.keys(m.capabilities).length === 0) return null;
  return JSON.stringify(m.capabilities);
}

export function alignEnabledWithCatalog(
  providerId: string,
  catalogModels: CatalogSyncModel[],
  options: { dryRun?: boolean } = {},
): { enabled: number; disabled: number; unchanged: number; inserted: number; pruned: number } {
  if (catalogModels.length === 0) {
    return { enabled: 0, disabled: 0, unchanged: 0, inserted: 0, pruned: 0 };
  }
  const db = getDb();
  const catalogByModelId = new Map(catalogModels.map(m => [m.modelId, m]));
  const rows = db
    .prepare('SELECT model_id, enabled, display_name, upstream_model_id, capabilities_json, user_edited, source, enable_source FROM provider_models WHERE provider_id = ?')
    .all(providerId) as {
      model_id: string;
      enabled: number;
      display_name: string;
      upstream_model_id: string;
      capabilities_json: string | null;
      user_edited: number;
      source: string;
      enable_source: import('@/types').ModelEnableSource;
    }[];
  const existingIds = new Set(rows.map(r => r.model_id));

  // Phase 1 — compute every decision without writing. Same logic in dry-run
  // and apply paths so the preview shown to the user matches reality.
  //
  // `kind: 'enable'` always carries the next enable_source so we never
  // produce a row whose enabled/enable_source disagree.
  type Decision =
    | { kind: 'insert'; modelId: string; upstreamModelId: string; displayName: string; capabilitiesJson: string | null; sort_order: number }
    | { kind: 'enable'; modelId: string; displayName: string; upstreamModelId: string; capabilitiesJson: string | null }
    | { kind: 'disable'; modelId: string }
    | { kind: 'prune'; modelId: string };
  const decisions: Decision[] = [];
  let enabled = 0, disabled = 0, unchanged = 0, inserted = 0, pruned = 0;

  const maxSort = (db
    .prepare('SELECT MAX(sort_order) AS m FROM provider_models WHERE provider_id = ?')
    .get(providerId) as { m: number | null }).m ?? -1;
  let nextSort = maxSort;
  for (const m of catalogModels) {
    if (!existingIds.has(m.modelId)) {
      nextSort++;
      decisions.push({
        kind: 'insert',
        modelId: m.modelId,
        upstreamModelId: m.upstreamModelId || m.modelId,
        displayName: m.displayName || m.modelId,
        capabilitiesJson: serializeCatalogCapabilities(m),
        sort_order: nextSort,
      });
      inserted++;
    }
  }

  for (const row of rows) {
    // Hard guard: any sign that the user has chosen for this row → leave
    // alone. user_edited is the legacy signal; enable_source manual_*
    // is the canonical Phase B signal. Either is enough to opt out of
    // the system-managed reset.
    const isUserManaged = row.user_edited === 1
      || row.enable_source === 'manual_enabled'
      || row.enable_source === 'manual_hidden';
    if (isUserManaged) {
      unchanged++;
      continue;
    }

    const catEntry = catalogByModelId.get(row.model_id);
    const shouldEnable = !!catEntry;
    const targetDisplay = catEntry?.displayName || row.model_id;
    const targetUpstream = catEntry?.upstreamModelId || row.model_id;
    // null = catalog says nothing about capabilities → keep the column as-is.
    const targetCapabilities = catEntry ? serializeCatalogCapabilities(catEntry) : null;

    if (shouldEnable) {
      const fieldsAlreadyMatch = row.enabled === 1
        && row.enable_source === 'recommended'
        && row.display_name === targetDisplay
        && row.upstream_model_id === targetUpstream
        && (targetCapabilities === null || row.capabilities_json === targetCapabilities);
      if (fieldsAlreadyMatch) {
        unchanged++;
      } else {
        decisions.push({ kind: 'enable', modelId: row.model_id, displayName: targetDisplay, upstreamModelId: targetUpstream, capabilitiesJson: targetCapabilities });
        if (row.enabled === 1) unchanged++;
        else enabled++;
      }
    } else {
      if (row.source === 'catalog') {
        // Stale catalog seed — safe to remove (user_edited=0 already proven
        // by the isUserManaged guard above).
        decisions.push({ kind: 'prune', modelId: row.model_id });
        pruned++;
      } else if (row.enabled === 0 && row.enable_source === 'discovered') {
        unchanged++;
      } else {
        decisions.push({ kind: 'disable', modelId: row.model_id });
        disabled++;
      }
    }
  }

  if (options.dryRun) {
    return { enabled, disabled, unchanged, inserted, pruned };
  }

  // Phase 2 — execute decisions in one transaction. The WHERE clauses
  // re-assert the user-managed guard at write time so a row that flipped
  // to manual_* between phase 1 and phase 2 (race-free in practice
  // because we're in a single sync pass, but cheap belt-and-suspenders)
  // stays untouched.
  // capabilities_json via COALESCE(?, capabilities_json): a null param leaves
  // the stored value untouched (catalog silent → don't erase discovered caps).
  const enableStmt = db.prepare(
    `UPDATE provider_models
     SET enabled = 1, display_name = ?, upstream_model_id = ?,
         capabilities_json = COALESCE(?, capabilities_json), enable_source = 'recommended'
     WHERE provider_id = ? AND model_id = ?
       AND user_edited = 0
       AND enable_source NOT IN ('manual_enabled', 'manual_hidden')`
  );
  const disableStmt = db.prepare(
    `UPDATE provider_models
     SET enabled = 0, enable_source = 'discovered'
     WHERE provider_id = ? AND model_id = ?
       AND user_edited = 0
       AND enable_source NOT IN ('manual_enabled', 'manual_hidden')`
  );
  const deleteStmt = db.prepare(
    `DELETE FROM provider_models
     WHERE provider_id = ? AND model_id = ?
       AND user_edited = 0
       AND enable_source NOT IN ('manual_enabled', 'manual_hidden')`
  );
  const insertStmt = db.prepare(
    `INSERT INTO provider_models (id, provider_id, model_id, upstream_model_id, display_name, capabilities_json, variants_json, sort_order, enabled, created_at, source, last_refreshed_at, user_edited, enable_source)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, 'catalog', NULL, 0, 'recommended')`
  );
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  const txn = db.transaction(() => {
    for (const d of decisions) {
      switch (d.kind) {
        case 'insert':
          insertStmt.run(
            crypto.randomBytes(16).toString('hex'),
            providerId, d.modelId, d.upstreamModelId, d.displayName,
            d.capabilitiesJson ?? '{}', d.sort_order, now,
          );
          break;
        case 'enable':
          enableStmt.run(d.displayName, d.upstreamModelId, d.capabilitiesJson, providerId, d.modelId);
          break;
        case 'disable':
          disableStmt.run(providerId, d.modelId);
          break;
        case 'prune':
          deleteStmt.run(providerId, d.modelId);
          break;
      }
    }
  });
  txn();
  return { enabled, disabled, unchanged, inserted, pruned };
}

/**
 * Seed catalog defaults into provider_models when the row count is 0. Used
 * as a backfill for providers that can't be discovered (Xiaomi MiMo /
 * MiniMax / DeepSeek with `/anthropic` subpath etc.) — the catalog ships
 * curated lists per preset and we surface them as `source='catalog'` rows.
 *
 * Idempotent: only inserts when the table is empty for this provider, so a
 * later refresh / manual edit won't be re-seeded.
 */
export function seedCatalogModelsIfEmpty(
  providerId: string,
  catalogModels: CatalogSyncModel[],
): number {
  if (catalogModels.length === 0) return 0;
  const db = getDb();
  const existing = (db
    .prepare('SELECT COUNT(*) AS c FROM provider_models WHERE provider_id = ?')
    .get(providerId) as { c: number }).c;
  if (existing > 0) return 0;

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const stmt = db.prepare(
    `INSERT INTO provider_models (id, provider_id, model_id, upstream_model_id, display_name, capabilities_json, variants_json, sort_order, enabled, created_at, source, last_refreshed_at, user_edited, enable_source)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, 'catalog', NULL, 0, 'catalog')`
  );
  const txn = db.transaction(() => {
    catalogModels.forEach((m, i) => {
      stmt.run(
        crypto.randomBytes(16).toString('hex'),
        providerId,
        m.modelId,
        m.upstreamModelId || m.modelId,
        m.displayName || m.modelId,
        serializeCatalogCapabilities(m) ?? '{}',
        i,
        now,
      );
    });
  });
  txn();
  return catalogModels.length;
}

/**
 * Merge the current catalog into an existing catalog-only provider without
 * turning a Models-page read into a destructive "align everything" action.
 *
 * Vendor plan catalogs evolve after a provider has already been materialized
 * in SQLite (for example `sonnet / GLM-5.2` became
 * `sonnet / GLM-5.3[1m]`). `seedCatalogModelsIfEmpty()` cannot help those
 * installations because the provider already has rows, while the full
 * `alignEnabledWithCatalog()` operation may disable/prune non-catalog rows and
 * therefore remains preview-first.
 *
 * This narrower upgrade path is safe to run when Settings > Models reads a
 * catalog-only plan provider:
 *   - update metadata/order only for pristine `source='catalog'` rows;
 *   - insert catalog ids that do not exist yet;
 *   - never touch a manual/user-edited/manual-hidden row;
 *   - never disable or delete rows that disappeared from the catalog.
 */
export function mergeCatalogManagedModels(
  providerId: string,
  catalogModels: CatalogSyncModel[],
): { inserted: number; updated: number } {
  if (catalogModels.length === 0) return { inserted: 0, updated: 0 };

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, model_id, upstream_model_id, display_name, capabilities_json,
            sort_order, enabled, source, user_edited, enable_source
     FROM provider_models
     WHERE provider_id = ?`,
  ).all(providerId) as Array<LocalCatalogIdentityRow & {
    id: string;
    sort_order: number;
  }>;
  const rowsById = new Map(rows.map(row => [row.model_id, row]));
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO provider_models (id, provider_id, model_id, upstream_model_id, display_name, capabilities_json, variants_json, sort_order, enabled, created_at, source, last_refreshed_at, user_edited, enable_source)
     SELECT ?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, 'catalog', NULL, 0, 'catalog'
     WHERE NOT EXISTS (
       SELECT 1 FROM provider_models
       WHERE provider_id = ? AND (model_id = ? OR upstream_model_id = ?)
     )`,
  );
  const updateStmt = db.prepare(
    `UPDATE provider_models
     SET upstream_model_id = ?, display_name = ?,
         capabilities_json = COALESCE(?, capabilities_json), sort_order = ?
     WHERE provider_id = ? AND model_id = ?
       AND source = 'catalog' AND user_edited = 0
       AND enable_source NOT IN ('manual_enabled', 'manual_hidden')`,
  );
  const updateLegacyStmt = db.prepare(
    `UPDATE provider_models
     SET upstream_model_id = ?, display_name = ?,
         capabilities_json = COALESCE(?, capabilities_json), sort_order = ?,
         source = 'catalog', enable_source = 'catalog'
     WHERE id = ? AND provider_id = ? AND model_id = ?
       AND upstream_model_id = ? AND display_name = ?
       AND capabilities_json IS ?
       AND user_edited = 0
       AND enable_source NOT IN ('manual_enabled', 'manual_hidden')`,
  );

  const isCatalogManaged = (row: (typeof rows)[number]) => row.source === 'catalog'
    && row.user_edited === 0
    && row.enable_source !== 'manual_enabled'
    && row.enable_source !== 'manual_hidden';
  const isMergeManaged = (row: (typeof rows)[number], model: CatalogSyncModel) =>
    isCatalogManaged(row) || isLegacyCatalogModelRow(row, model);

  // Catalog rows are movable, but every row outside that narrow ownership
  // boundary keeps its exact order. Allocate around those reserved slots so
  // adding a new catalog SKU never ties a user-pinned/manual row.
  const catalogIds = new Set(catalogModels.map(model => model.modelId));
  const catalogById = new Map(catalogModels.map(model => [model.modelId, model]));
  const movableCatalogIds = new Set(
    rows
      .filter(row => {
        const model = catalogById.get(row.model_id);
        return catalogIds.has(row.model_id) && !!model && isMergeManaged(row, model);
      })
      .map(row => row.model_id),
  );
  const reservedSortOrders = new Set(
    rows
      .filter(row => !movableCatalogIds.has(row.model_id))
      .map(row => row.sort_order),
  );
  const claimedModelIds = new Set<string>();
  const claimedUpstreamCounts = new Map<string, number>();
  for (const row of rows) {
    claimedUpstreamCounts.set(
      row.upstream_model_id,
      (claimedUpstreamCounts.get(row.upstream_model_id) ?? 0) + 1,
    );
  }
  const isUpstreamClaimed = (upstreamModelId: string) =>
    (claimedUpstreamCounts.get(upstreamModelId) ?? 0) > 0;
  const releaseUpstream = (upstreamModelId: string) => {
    const next = (claimedUpstreamCounts.get(upstreamModelId) ?? 0) - 1;
    if (next <= 0) claimedUpstreamCounts.delete(upstreamModelId);
    else claimedUpstreamCounts.set(upstreamModelId, next);
  };
  const claimUpstream = (upstreamModelId: string) => {
    claimedUpstreamCounts.set(upstreamModelId, (claimedUpstreamCounts.get(upstreamModelId) ?? 0) + 1);
  };
  const targetSortOrders = new Map<string, number>();
  catalogModels.forEach((model, index) => {
    if (claimedModelIds.has(model.modelId)) return;
    const upstreamModelId = model.upstreamModelId || model.modelId;
    const existing = rowsById.get(model.modelId);
    if (existing && !isMergeManaged(existing, model)) return;
    if (existing && existing.upstream_model_id !== upstreamModelId && isUpstreamClaimed(upstreamModelId)) return;
    if (!existing && isUpstreamClaimed(upstreamModelId)) return;

    if (existing && existing.upstream_model_id !== upstreamModelId) {
      releaseUpstream(existing.upstream_model_id);
    }

    let targetSortOrder = index;
    while (reservedSortOrders.has(targetSortOrder)) targetSortOrder++;
    targetSortOrders.set(model.modelId, targetSortOrder);
    reservedSortOrders.add(targetSortOrder);
    claimedModelIds.add(model.modelId);
    if (!existing || existing.upstream_model_id !== upstreamModelId) claimUpstream(upstreamModelId);
  });

  let inserted = 0;
  let updated = 0;
  const txn = db.transaction(() => {
    catalogModels.forEach((model) => {
      const upstreamModelId = model.upstreamModelId || model.modelId;
      const displayName = model.displayName || model.modelId;
      const capabilitiesJson = serializeCatalogCapabilities(model);
      const existing = rowsById.get(model.modelId);
      const targetSortOrder = targetSortOrders.get(model.modelId);

      // A user-owned row may use the vendor's wire id directly instead of the
      // catalog's stable alias. It already represents this SKU, so inserting a
      // second enabled row would create two picker entries for one upstream.
      if (targetSortOrder === undefined) return;

      if (!existing) {
        const result = insertStmt.run(
          crypto.randomBytes(16).toString('hex'),
          providerId,
          model.modelId,
          upstreamModelId,
          displayName,
          capabilitiesJson ?? '{}',
          targetSortOrder,
          now,
          providerId,
          model.modelId,
          upstreamModelId,
        );
        // INSERT OR IGNORE closes the cross-process window between the
        // snapshot above and this write. Count only the row this transaction
        // actually won; a concurrent winner remains authoritative.
        inserted += result.changes;
        return;
      }

      const fieldsAlreadyMatch = existing.upstream_model_id === upstreamModelId
        && existing.display_name === displayName
        && existing.sort_order === targetSortOrder
        && (capabilitiesJson === null || existing.capabilities_json === capabilitiesJson);
      if (fieldsAlreadyMatch) return;

      if (isLegacyCatalogModelRow(existing, model)) {
        const result = updateLegacyStmt.run(
          upstreamModelId,
          displayName,
          capabilitiesJson,
          targetSortOrder,
          existing.id,
          providerId,
          model.modelId,
          existing.upstream_model_id,
          existing.display_name,
          existing.capabilities_json,
        );
        updated += result.changes;
        return;
      }

      const result = updateStmt.run(
        upstreamModelId,
        displayName,
        capabilitiesJson,
        targetSortOrder,
        providerId,
        model.modelId,
      );
      updated += result.changes;
    });
  });
  txn();

  return { inserted, updated };
}

export function getProviderModel(
  providerId: string,
  modelId: string,
): import('@/types').ProviderModel | undefined {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM provider_models WHERE provider_id = ? AND model_id = ?'
  ).get(providerId, modelId) as import('@/types').ProviderModel | undefined;
}

export function upsertProviderModel(data: {
  provider_id: string;
  model_id: string;
  upstream_model_id?: string;
  display_name?: string;
  capabilities_json?: string;
  variants_json?: string;
  sort_order?: number;
  enabled?: number;
  source?: import('@/types').ProviderModelSource;
  last_refreshed_at?: string | null;
  user_edited?: number;
  enable_source?: import('@/types').ModelEnableSource;
}): void {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  // ON CONFLICT preserves user_edited and enabled by default — those are the
  // user's own state; only the API-derived fields (upstream_model_id,
  // last_refreshed_at, source) update on a re-import. Use the dedicated
  // applyDiscoveryDiff helper for the refresh path so user edits stay safe.
  db.prepare(
    `INSERT INTO provider_models (id, provider_id, model_id, upstream_model_id, display_name, capabilities_json, variants_json, sort_order, enabled, created_at, source, last_refreshed_at, user_edited, enable_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       upstream_model_id = excluded.upstream_model_id,
       display_name = excluded.display_name,
       capabilities_json = excluded.capabilities_json,
       variants_json = excluded.variants_json,
       sort_order = excluded.sort_order,
       enabled = excluded.enabled,
       source = excluded.source,
       last_refreshed_at = excluded.last_refreshed_at,
       user_edited = excluded.user_edited,
       enable_source = excluded.enable_source`
  ).run(
    id,
    data.provider_id,
    data.model_id,
    data.upstream_model_id || '',
    data.display_name || '',
    data.capabilities_json || '{}',
    data.variants_json || '{}',
    data.sort_order ?? 0,
    data.enabled ?? 1,
    now,
    data.source || 'manual',
    data.last_refreshed_at ?? null,
    data.user_edited ?? 0,
    data.enable_source || 'recommended',
  );
}

/** Update fields the user can edit. Sets user_edited=1 so the refresh path
 *  knows to preserve display_name / capabilities / enabled on re-import. */
export function updateProviderModelUserFields(
  providerId: string,
  modelId: string,
  fields: { display_name?: string; capabilities_json?: string; enabled?: number; sort_order?: number },
): boolean {
  const existing = getProviderModel(providerId, modelId);
  if (!existing) return false;
  const db = getDb();
  const next = {
    display_name: fields.display_name ?? existing.display_name,
    capabilities_json: fields.capabilities_json ?? existing.capabilities_json,
    enabled: fields.enabled ?? existing.enabled,
    sort_order: fields.sort_order ?? existing.sort_order,
  };
  // When the user is explicitly toggling the row's enabled state, mark
  // enable_source as the corresponding manual_* state so future
  // refreshes never flip it back to recommended/discovered. Other
  // edits (display_name / capabilities / sort_order) leave
  // enable_source alone — those don't carry "I want this on/off"
  // semantics.
  let nextEnableSource: import('@/types').ModelEnableSource = existing.enable_source;
  if (fields.enabled !== undefined && fields.enabled !== existing.enabled) {
    nextEnableSource = fields.enabled === 1 ? 'manual_enabled' : 'manual_hidden';
  }
  const result = db.prepare(
    `UPDATE provider_models
     SET display_name = ?, capabilities_json = ?, enabled = ?, sort_order = ?, user_edited = 1, enable_source = ?
     WHERE provider_id = ? AND model_id = ?`
  ).run(
    next.display_name,
    next.capabilities_json,
    next.enabled,
    next.sort_order,
    nextEnableSource,
    providerId,
    modelId,
  );
  return result.changes > 0;
}

export function deleteProviderModel(providerId: string, modelId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?').run(providerId, modelId);
  return result.changes > 0;
}

/**
 * Bulk update of `last_refreshed_at` for all rows of one provider, without
 * touching any business field (enabled / source / display_name / etc.).
 * Used by the OpenRouter `/validate-models` route — refresh there is
 * read-only validation against upstream, and only the timestamp moves.
 *
 * Returns the number of rows updated. Use the same wall-clock format as
 * the seed/upsert paths so timestamps sort consistently.
 */
export function touchProviderModelsRefreshed(providerId: string): number {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const result = db
    .prepare('UPDATE provider_models SET last_refreshed_at = ? WHERE provider_id = ?')
    .run(now, providerId);
  return result.changes;
}

/**
 * "Recommended-but-not-user-edited" rows for a provider — used by the
 * OpenRouter "整理早期导入的目录" entry to preview what would be hidden
 * by a one-click cleanup. The WHERE clause guarantees:
 *   - never touches `enable_source IN ('manual_enabled', 'manual_hidden')`
 *   - never touches `user_edited = 1`
 *   - only currently-enabled rows (hiding an already-hidden row is a no-op
 *     but cluttering the preview is misleading)
 *
 * Returned rows are full `ProviderModel` objects so the dialog can show
 * model_id + display_name + source label without a follow-up fetch.
 */
export function getRecommendedNotEditedRows(providerId: string): import('@/types').ProviderModel[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM provider_models
     WHERE provider_id = ?
       AND enable_source = 'recommended'
       AND user_edited = 0
       AND enabled = 1
     ORDER BY sort_order ASC, model_id ASC`
  ).all(providerId) as import('@/types').ProviderModel[];
}

/**
 * Bulk-hide "recommended-not-edited" rows. Same WHERE as
 * `getRecommendedNotEditedRows`, plus sets `enable_source='manual_hidden'`
 * and `user_edited=1` so future OpenRouter validates / hypothetical
 * future refreshes can never flip them back on.
 *
 * Single SQL statement — no per-row loop, safe for the 300+ row case
 * that's the whole reason this entry exists.
 *
 * Returns the count of rows hidden.
 */
export function hideRecommendedNotEditedRows(providerId: string): number {
  const db = getDb();
  const result = db.prepare(
    `UPDATE provider_models
     SET enabled = 0, user_edited = 1, enable_source = 'manual_hidden'
     WHERE provider_id = ?
       AND enable_source = 'recommended'
       AND user_edited = 0
       AND enabled = 1`
  ).run(providerId);
  return result.changes;
}

/**
 * Apply an upstream discovery diff to provider_models with the
 * "auto-discover, conservatively enable" contract: materialize every
 * upstream model so users CAN find them, but only auto-enable the
 * ones a recommendation predicate accepts. Hidden / manually-set rows
 * are never re-flipped.
 *
 * Behaviour per upstream id:
 *   - new (no DB row):
 *       INSERT with source='api', user_edited=0
 *       enabled = isRecommended(modelId) ? 1 : 0
 *       enable_source = isRecommended(modelId) ? 'recommended' : 'discovered'
 *   - existing user_edited=0 + enable_source IN ('recommended','discovered','catalog'):
 *       UPDATE upstream/source/last_refreshed_at + display_name = upstream id
 *       AND re-evaluate enabled / enable_source per the recommendation
 *       (so a model that was system-enabled but is now blacklisted
 *       gets disabled on refresh, and vice versa)
 *   - existing user_edited=1 OR enable_source IN ('manual_enabled','manual_hidden'):
 *       UPDATE upstream_model_id + last_refreshed_at + source ONLY
 *       Never touch enabled / enable_source — that's a user choice
 *   - DB-only (not in upstream): leave alone, caller surfaces as orphan
 *
 * `isRecommended` callback: caller (discover-models route) computes
 * recommendation from preset + provider compat. Allowing the caller to
 * inject the predicate keeps db.ts free of catalog imports + makes
 * unit testing trivial.
 */
export function applyDiscoveryDiff(
  providerId: string,
  upstreamModels: { modelId: string; upstreamModelId: string }[],
  isRecommended: (modelId: string) => boolean,
): {
  inserted: number;
  refreshedPristine: number;
  refreshedPreserved: number;
  recommendedEnabled: number;
  discoveredHidden: number;
} {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  let inserted = 0;
  let refreshedPristine = 0;
  let refreshedPreserved = 0;
  let recommendedEnabled = 0;
  let discoveredHidden = 0;

  const insertStmt = db.prepare(
    `INSERT INTO provider_models (id, provider_id, model_id, upstream_model_id, display_name, capabilities_json, variants_json, sort_order, enabled, created_at, source, last_refreshed_at, user_edited, enable_source)
     VALUES (?, ?, ?, ?, ?, '{}', '{}', ?, ?, ?, 'api', ?, 0, ?)`
  );
  const updatePristineStmt = db.prepare(
    `UPDATE provider_models
     SET upstream_model_id = ?, display_name = ?, source = 'api', last_refreshed_at = ?,
         enabled = ?, enable_source = ?
     WHERE provider_id = ? AND model_id = ?
       AND user_edited = 0
       AND enable_source NOT IN ('manual_enabled', 'manual_hidden')`
  );
  const updatePreservedStmt = db.prepare(
    `UPDATE provider_models
     SET upstream_model_id = ?, source = CASE WHEN source = 'manual' THEN 'manual' ELSE 'api' END, last_refreshed_at = ?
     WHERE provider_id = ? AND model_id = ?
       AND (user_edited = 1 OR enable_source IN ('manual_enabled', 'manual_hidden'))`
  );

  const txn = db.transaction(() => {
    let nextSort = (db
      .prepare('SELECT MAX(sort_order) AS m FROM provider_models WHERE provider_id = ?')
      .get(providerId) as { m: number | null }).m ?? -1;

    for (const { modelId, upstreamModelId } of upstreamModels) {
      const existing = getProviderModel(providerId, modelId);
      const recommended = isRecommended(modelId);
      const enabledOnInsert = recommended ? 1 : 0;
      const enableSourceOnInsert = recommended ? 'recommended' : 'discovered';

      if (!existing) {
        nextSort++;
        insertStmt.run(
          crypto.randomBytes(16).toString('hex'),
          providerId,
          modelId,
          upstreamModelId,
          modelId, // fresh display_name = id (user can rename later)
          nextSort,
          enabledOnInsert,
          now,
          now,
          enableSourceOnInsert,
        );
        inserted++;
        if (recommended) recommendedEnabled++;
        else discoveredHidden++;
      } else if (
        existing.user_edited === 0
        && existing.enable_source !== 'manual_enabled'
        && existing.enable_source !== 'manual_hidden'
      ) {
        // System-managed row — re-evaluate against current recommendation.
        updatePristineStmt.run(
          upstreamModelId, modelId, now,
          enabledOnInsert, enableSourceOnInsert,
          providerId, modelId,
        );
        refreshedPristine++;
      } else {
        // User has touched this row — never flip enabled / enable_source.
        updatePreservedStmt.run(upstreamModelId, now, providerId, modelId);
        refreshedPreserved++;
      }
    }
  });
  txn();

  return { inserted, refreshedPristine, refreshedPreserved, recommendedEnabled, discoveredHidden };
}

export function activateProvider(id: string): boolean {
  const db = getDb();
  const existing = getProvider(id);
  if (!existing) return false;

  const transaction = db.transaction(() => {
    db.prepare('UPDATE api_providers SET is_active = 0').run();
    db.prepare('UPDATE api_providers SET is_active = 1 WHERE id = ?').run(id);
  });
  transaction();
  return true;
}

export function deactivateAllProviders(): void {
  const db = getDb();
  db.prepare('UPDATE api_providers SET is_active = 0').run();
}

// ==========================================
// Token Usage Statistics
// ==========================================

export function getTokenUsageStats(days: number = 30, now?: Date): {
  summary: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number | null;
    total_sessions: number;
    usage_turns: number;
    cost_known_turns: number;
    cost_legacy_turns: number;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    uncached_input_tokens: number | null;
    cache_eligible_turns: number;
    cache_rate_complete: boolean;
  };
  daily: Array<{
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost: number | null;
    cost_legacy: boolean;
    cohort: 'stable_owner' | 'handoff';
  }>;
} {
  const db = getDb();

  // Window boundary: localDayStartAsUTC computes the UTC equivalent of
  // "local midnight N days ago" using Date methods, which are DST-aware.
  const windowStartUTC = localDayStartAsUTC(days - 1, now);

  const rawSummary = db.prepare(`
    SELECT
      SUM(json_extract(m.token_usage, '$.input_tokens')) AS total_input_tokens,
      SUM(json_extract(m.token_usage, '$.output_tokens')) AS total_output_tokens,
      COUNT(DISTINCT m.session_id) AS total_sessions,
      COUNT(*) AS usage_turns,
      SUM(CASE
        WHEN json_extract(m.token_usage, '$.normalized.schemaVersion') = 2
          AND json_extract(m.token_usage, '$.normalized.costSource') IN ('provider_reported', 'versioned_price_snapshot')
          AND json_type(m.token_usage, '$.normalized.costUsd') IN ('integer', 'real')
        THEN json_extract(m.token_usage, '$.normalized.costUsd')
        WHEN json_type(m.token_usage, '$.normalized') IS NULL
          AND json_type(m.token_usage, '$.cost_usd') IN ('integer', 'real')
        THEN json_extract(m.token_usage, '$.cost_usd')
      END) AS known_cost,
      COUNT(CASE
        WHEN json_extract(m.token_usage, '$.normalized.schemaVersion') = 2
          AND json_extract(m.token_usage, '$.normalized.costSource') IN ('provider_reported', 'versioned_price_snapshot')
          AND json_type(m.token_usage, '$.normalized.costUsd') IN ('integer', 'real')
        THEN 1
        WHEN json_type(m.token_usage, '$.normalized') IS NULL
          AND json_type(m.token_usage, '$.cost_usd') IN ('integer', 'real')
        THEN 1
      END) AS cost_known_turns,
      COUNT(CASE
        WHEN json_type(m.token_usage, '$.normalized') IS NULL
          AND json_type(m.token_usage, '$.cost_usd') IN ('integer', 'real')
        THEN 1
      END) AS cost_legacy_turns,
      SUM(CASE WHEN json_extract(m.token_usage, '$.normalized.schemaVersion') = 2
        THEN json_extract(m.token_usage, '$.normalized.cacheReadInputTokens') END) AS cache_read_tokens,
      SUM(CASE WHEN json_extract(m.token_usage, '$.normalized.schemaVersion') = 2
        THEN json_extract(m.token_usage, '$.normalized.cacheWriteInputTokens') END) AS cache_creation_tokens,
      SUM(CASE WHEN json_extract(m.token_usage, '$.normalized.schemaVersion') = 2
        THEN json_extract(m.token_usage, '$.normalized.uncachedInputTokens') END) AS uncached_input_tokens,
      COUNT(CASE WHEN json_extract(m.token_usage, '$.normalized.schemaVersion') = 2
        AND json_type(m.token_usage, '$.normalized.uncachedInputTokens') IN ('integer', 'real')
        AND json_type(m.token_usage, '$.normalized.cacheReadInputTokens') IN ('integer', 'real')
        THEN 1 END) AS cache_eligible_turns
    FROM messages m
    WHERE m.token_usage IS NOT NULL
      AND json_valid(m.token_usage) = 1
      AND json_type(m.token_usage, '$.input_tokens') IN ('integer', 'real')
      AND json_type(m.token_usage, '$.output_tokens') IN ('integer', 'real')
      AND m.created_at >= ?
  `).get(windowStartUTC) as {
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    total_sessions: number;
    usage_turns: number;
    known_cost: number | null;
    cost_known_turns: number;
    cost_legacy_turns: number;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    uncached_input_tokens: number | null;
    cache_eligible_turns: number;
  };
  const summary = {
    total_input_tokens: rawSummary.total_input_tokens ?? 0,
    total_output_tokens: rawSummary.total_output_tokens ?? 0,
    total_cost: rawSummary.usage_turns > 0
      && rawSummary.cost_known_turns === rawSummary.usage_turns
      ? rawSummary.known_cost
      : null,
    total_sessions: rawSummary.total_sessions,
    usage_turns: rawSummary.usage_turns,
    cost_known_turns: rawSummary.cost_known_turns,
    cost_legacy_turns: rawSummary.cost_legacy_turns,
    cache_read_tokens: rawSummary.cache_read_tokens,
    cache_creation_tokens: rawSummary.cache_creation_tokens,
    uncached_input_tokens: rawSummary.uncached_input_tokens,
    cache_eligible_turns: rawSummary.cache_eligible_turns,
    cache_rate_complete: rawSummary.usage_turns > 0
      && rawSummary.cache_eligible_turns === rawSummary.usage_turns,
  };

  // Daily bucketing: fetch raw rows and aggregate by local date in JS.
  // This handles DST correctly because getLocalDateString uses Date's
  // local-time methods, which account for the historical DST offset at
  // each message's timestamp — unlike a single SQL offset modifier.
  const rawRows = db.prepare(`
    SELECT
      m.created_at,
      CASE
        WHEN COALESCE(NULLIF(s.provider_name, ''), '') != ''
        THEN s.provider_name
        ELSE COALESCE(NULLIF(s.model, ''), 'unknown')
      END AS model,
      json_extract(m.token_usage, '$.input_tokens') AS input_tokens,
      json_extract(m.token_usage, '$.output_tokens') AS output_tokens,
      CASE
        WHEN json_extract(m.token_usage, '$.normalized.schemaVersion') = 2
          AND json_extract(m.token_usage, '$.normalized.costSource') IN ('provider_reported', 'versioned_price_snapshot')
          AND json_type(m.token_usage, '$.normalized.costUsd') IN ('integer', 'real')
        THEN json_extract(m.token_usage, '$.normalized.costUsd')
        WHEN json_type(m.token_usage, '$.normalized') IS NULL
          AND json_type(m.token_usage, '$.cost_usd') IN ('integer', 'real')
        THEN json_extract(m.token_usage, '$.cost_usd')
      END AS cost,
      CASE WHEN json_type(m.token_usage, '$.normalized') IS NULL
        AND json_type(m.token_usage, '$.cost_usd') IN ('integer', 'real')
        THEN 1 ELSE 0 END AS cost_legacy,
      CASE WHEN EXISTS (
        SELECT 1 FROM chat_session_handoffs h WHERE h.target_session_id = m.session_id
      ) THEN 'handoff' ELSE 'stable_owner' END AS cohort
    FROM messages m
    LEFT JOIN chat_sessions s ON m.session_id = s.id
    WHERE m.token_usage IS NOT NULL
      AND json_valid(m.token_usage) = 1
      AND json_type(m.token_usage, '$.input_tokens') IN ('integer', 'real')
      AND json_type(m.token_usage, '$.output_tokens') IN ('integer', 'real')
      AND m.created_at >= ?
  `).all(windowStartUTC) as Array<{
    created_at: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost: number | null;
    cost_legacy: number;
    cohort: 'stable_owner' | 'handoff';
  }>;

  // Aggregate by (local_date, model)
  const buckets = new Map<string, {
    input_tokens: number;
    output_tokens: number;
    known_cost: number;
    usage_turns: number;
    cost_known_turns: number;
    cost_legacy: boolean;
    cohort: 'stable_owner' | 'handoff';
  }>();
  for (const row of rawRows) {
    // Parse UTC timestamp → local date via Date methods (DST-aware per row)
    const utcTs = new Date(row.created_at.replace(' ', 'T') + 'Z');
    const localDate = getLocalDateString(utcTs);
    const key = `${localDate}\0${row.model}\0${row.cohort}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.input_tokens += row.input_tokens;
      existing.output_tokens += row.output_tokens;
      existing.usage_turns += 1;
      if (row.cost !== null) {
        existing.known_cost += row.cost;
        existing.cost_known_turns += 1;
      }
      existing.cost_legacy ||= row.cost_legacy === 1;
    } else {
      buckets.set(key, {
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        known_cost: row.cost ?? 0,
        usage_turns: 1,
        cost_known_turns: row.cost === null ? 0 : 1,
        cost_legacy: row.cost_legacy === 1,
        cohort: row.cohort,
      });
    }
  }

  const daily: Array<{
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost: number | null;
    cost_legacy: boolean;
    cohort: 'stable_owner' | 'handoff';
  }> = [];
  for (const [key, val] of buckets) {
    const [date, model] = key.split('\0');
    daily.push({
      date,
      model,
      input_tokens: val.input_tokens,
      output_tokens: val.output_tokens,
      cost: val.cost_known_turns === val.usage_turns ? val.known_cost : null,
      cost_legacy: val.cost_legacy,
      cohort: val.cohort,
    });
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return { summary, daily };
}

// ==========================================
// Media Job Operations
// ==========================================

const DEFAULT_BATCH_CONFIG: BatchConfig = {
  concurrency: 2,
  maxRetries: 2,
  retryDelayMs: 2000,
};

export function createMediaJob(params: {
  sessionId?: string;
  docPaths?: string[];
  stylePrompt?: string;
  batchConfig?: Partial<BatchConfig>;
  totalItems: number;
}): MediaJob {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const config = { ...DEFAULT_BATCH_CONFIG, ...params.batchConfig };

  db.prepare(
    `INSERT INTO media_jobs (id, session_id, status, doc_paths, style_prompt, batch_config, total_items, completed_items, failed_items, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).run(
    id,
    params.sessionId || null,
    'planned',
    JSON.stringify(params.docPaths || []),
    params.stylePrompt || '',
    JSON.stringify(config),
    params.totalItems,
    now,
    now,
  );

  return getMediaJob(id)!;
}

export function getMediaJob(id: string): MediaJob | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM media_jobs WHERE id = ?').get(id) as MediaJob | undefined;
}

export function getMediaJobsBySession(sessionId: string): MediaJob[] {
  const db = getDb();
  return db.prepare('SELECT * FROM media_jobs WHERE session_id = ? ORDER BY created_at DESC').all(sessionId) as MediaJob[];
}

export function getAllMediaJobs(limit = 50, offset = 0): MediaJob[] {
  const db = getDb();
  return db.prepare('SELECT * FROM media_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset) as MediaJob[];
}

export function updateMediaJobStatus(id: string, status: MediaJobStatus): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const completedAt = (status === 'completed' || status === 'cancelled' || status === 'failed') ? now : null;

  db.prepare(
    'UPDATE media_jobs SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?'
  ).run(status, now, completedAt, id);
}

export function updateMediaJobCounters(id: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(`
    UPDATE media_jobs SET
      completed_items = (SELECT COUNT(*) FROM media_job_items WHERE job_id = ? AND status = 'completed'),
      failed_items = (SELECT COUNT(*) FROM media_job_items WHERE job_id = ? AND status = 'failed'),
      updated_at = ?
    WHERE id = ?
  `).run(id, id, now, id);
}

export function deleteMediaJob(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM media_jobs WHERE id = ?').run(id);
  return result.changes > 0;
}

// ==========================================
// Media Job Item Operations
// ==========================================

export function createMediaJobItems(jobId: string, items: Array<{
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  model?: string;
  tags?: string[];
  sourceRefs?: string[];
}>): MediaJobItem[] {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const insertStmt = db.prepare(
    `INSERT INTO media_job_items (id, job_id, idx, prompt, aspect_ratio, image_size, model, tags, source_refs, status, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
  );

  const ids: string[] = [];
  const transaction = db.transaction(() => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const id = crypto.randomBytes(16).toString('hex');
      ids.push(id);
      insertStmt.run(
        id, jobId, i,
        item.prompt,
        item.aspectRatio || '1:1',
        item.imageSize || '1K',
        item.model || '',
        JSON.stringify(item.tags || []),
        JSON.stringify(item.sourceRefs || []),
        now, now,
      );
    }
  });
  transaction();

  return ids.map(id => db.prepare('SELECT * FROM media_job_items WHERE id = ?').get(id) as MediaJobItem);
}

export function getMediaJobItems(jobId: string): MediaJobItem[] {
  const db = getDb();
  return db.prepare('SELECT * FROM media_job_items WHERE job_id = ? ORDER BY idx ASC').all(jobId) as MediaJobItem[];
}

export function getMediaJobItem(id: string): MediaJobItem | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM media_job_items WHERE id = ?').get(id) as MediaJobItem | undefined;
}

export function getPendingJobItems(jobId: string, maxRetries: number): MediaJobItem[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM media_job_items
     WHERE job_id = ? AND (status = 'pending' OR (status = 'failed' AND retry_count < ?))
     ORDER BY idx ASC`
  ).all(jobId, maxRetries) as MediaJobItem[];
}

export function updateMediaJobItem(id: string, updates: {
  status?: MediaJobItemStatus;
  retryCount?: number;
  resultMediaGenerationId?: string | null;
  error?: string | null;
  prompt?: string;
  aspectRatio?: string;
  imageSize?: string;
  tags?: string[];
}): MediaJobItem | undefined {
  const db = getDb();
  const existing = getMediaJobItem(id);
  if (!existing) return undefined;

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(`
    UPDATE media_job_items SET
      status = ?,
      retry_count = ?,
      result_media_generation_id = ?,
      error = ?,
      prompt = ?,
      aspect_ratio = ?,
      image_size = ?,
      tags = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    updates.status ?? existing.status,
    updates.retryCount ?? existing.retry_count,
    updates.resultMediaGenerationId !== undefined ? updates.resultMediaGenerationId : existing.result_media_generation_id,
    updates.error !== undefined ? updates.error : existing.error,
    updates.prompt ?? existing.prompt,
    updates.aspectRatio ?? existing.aspect_ratio,
    updates.imageSize ?? existing.image_size,
    updates.tags ? JSON.stringify(updates.tags) : existing.tags,
    now,
    id,
  );

  return getMediaJobItem(id);
}

export function cancelPendingJobItems(jobId: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    "UPDATE media_job_items SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('pending', 'failed')"
  ).run(now, jobId);
}

// ==========================================
// Media Context Event Operations
// ==========================================

export function createContextEvent(params: {
  sessionId: string;
  jobId: string;
  payload: Record<string, unknown>;
  syncMode?: 'manual' | 'auto_batch';
}): MediaContextEvent {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    `INSERT INTO media_context_events (id, session_id, job_id, payload, sync_mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, params.sessionId, params.jobId, JSON.stringify(params.payload), params.syncMode || 'manual', now);

  return db.prepare('SELECT * FROM media_context_events WHERE id = ?').get(id) as MediaContextEvent;
}

export function markContextEventSynced(id: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare('UPDATE media_context_events SET synced_at = ? WHERE id = ?').run(now, id);
}

// ==========================================
// Session Runtime Lock Operations
// ==========================================

/**
 * Acquire an exclusive lock for a session.
 * Uses SQLite's single-writer guarantee: within a transaction, delete expired
 * locks then INSERT. PK conflict = already locked → return false.
 */
export function acquireSessionLock(
  sessionId: string,
  lockId: string,
  owner: string,
  ttlSec: number = 300,
): boolean {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString().replace('T', ' ').split('.')[0];

  const txn = db.transaction(() => {
    // Delete expired locks first
    db.prepare("DELETE FROM session_runtime_locks WHERE expires_at < ?").run(now);
    // Try to insert — PK conflict means session is already locked
    try {
      db.prepare(
        'INSERT INTO session_runtime_locks (session_id, lock_id, owner, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(sessionId, lockId, owner, expiresAt, now, now);
      return true;
    } catch {
      return false;
    }
  });

  return txn();
}

/**
 * Renew an existing session lock by extending its expiry.
 */
export function renewSessionLock(
  sessionId: string,
  lockId: string,
  ttlSec: number = 300,
): boolean {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const expiresAt = new Date(Date.now() + ttlSec * 1000).toISOString().replace('T', ' ').split('.')[0];

  const result = db.prepare(
    'UPDATE session_runtime_locks SET expires_at = ?, updated_at = ? WHERE session_id = ? AND lock_id = ?'
  ).run(expiresAt, now, sessionId, lockId);

  return result.changes > 0;
}

/**
 * Release a session lock.
 */
export function releaseSessionLock(sessionId: string, lockId: string): boolean {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM session_runtime_locks WHERE session_id = ? AND lock_id = ?'
  ).run(sessionId, lockId);
  return result.changes > 0;
}

/**
 * Read-only ownership check: does `lockId` still own the lock row for
 * `sessionId`? Pure SELECT — no writes, no side effects.
 *
 * Deliberately does NOT check `expires_at`. Ownership (who holds the lock)
 * and liveness (TTL freshness) are separate concerns. A takeover only ever
 * happens inside acquireSessionLock, which deletes the stale row and inserts
 * a new one under a different lockId — so as long as THIS lockId's row still
 * exists, this lockId is still the owner, even if its TTL has lapsed. Callers
 * that also care about liveness must check TTL separately.
 */
export function isLockOwner(sessionId: string, lockId: string): boolean {
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 FROM session_runtime_locks WHERE session_id = ? AND lock_id = ?'
  ).get(sessionId, lockId);
  return !!row;
}

/**
 * Update the runtime status of a session.
 */
export function setSessionRuntimeStatus(
  sessionId: string,
  status: string,
  error?: string,
): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    'UPDATE chat_sessions SET runtime_status = ?, runtime_updated_at = ?, runtime_error = ? WHERE id = ?'
  ).run(status, now, error || '', sessionId);
}

// ==========================================
// Permission Request Operations
// ==========================================

/**
 * Create a pending permission request record in DB.
 */
export function createPermissionRequest(params: {
  id: string;
  sessionId: string;
  sdkSessionId?: string;
  toolName: string;
  toolInput: string;
  decisionReason?: string;
  expiresAt: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO permission_requests (id, session_id, sdk_session_id, tool_name, tool_input, decision_reason, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(
    params.id,
    params.sessionId,
    params.sdkSessionId || '',
    params.toolName,
    params.toolInput,
    params.decisionReason || '',
    params.expiresAt,
  );
}

/**
 * Resolve a pending permission request. Only updates if status is still 'pending'.
 * Returns true if the request was found and resolved, false otherwise.
 */
export function resolvePermissionRequest(
  id: string,
  status: 'allow' | 'deny' | 'timeout' | 'aborted',
  opts?: {
    updatedPermissions?: unknown[];
    updatedInput?: Record<string, unknown>;
    message?: string;
  },
): boolean {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const result = db.prepare(
    `UPDATE permission_requests
     SET status = ?, resolved_at = ?, updated_permissions = ?, updated_input = ?, message = ?
     WHERE id = ? AND status = 'pending'`
  ).run(
    status,
    now,
    JSON.stringify(opts?.updatedPermissions || []),
    opts?.updatedInput ? JSON.stringify(opts.updatedInput) : null,
    opts?.message || '',
    id,
  );
  return result.changes > 0;
}

/**
 * Expire all pending permission requests that have passed their expiry time.
 */
export function expirePermissionRequests(now?: string): number {
  const db = getDb();
  const cutoff = now || new Date().toISOString().replace('T', ' ').split('.')[0];
  const result = db.prepare(
    `UPDATE permission_requests
     SET status = 'timeout', resolved_at = ?, message = 'Expired'
     WHERE status = 'pending' AND expires_at < ?`
  ).run(cutoff, cutoff);
  return result.changes;
}

/**
 * Get a permission request by ID.
 */
export function getPermissionRequest(id: string): {
  id: string;
  session_id: string;
  sdk_session_id: string;
  tool_name: string;
  tool_input: string;
  decision_reason: string;
  status: string;
  updated_permissions: string;
  updated_input: string | null;
  message: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
} | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM permission_requests WHERE id = ?').get(id) as ReturnType<typeof getPermissionRequest>;
}

// ==========================================
// Bridge: Channel Binding Operations
// ==========================================

export function getChannelBinding(channelType: ChannelType, chatId: string): ChannelBinding | undefined {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM channel_bindings WHERE channel_type = ? AND chat_id = ?'
  ).get(channelType, chatId) as {
    id: string; channel_type: string; chat_id: string; codepilot_session_id: string;
    sdk_session_id: string; working_directory: string; model: string; mode: string;
    provider_id: string; active: number; created_at: string; updated_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    channelType: row.channel_type as ChannelType,
    chatId: row.chat_id,
    codepilotSessionId: row.codepilot_session_id,
    sdkSessionId: row.sdk_session_id,
    workingDirectory: row.working_directory,
    model: row.model,
    mode: row.mode as 'code' | 'plan' | 'ask',
    providerId: row.provider_id || undefined,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertChannelBinding(params: {
  channelType: ChannelType;
  chatId: string;
  codepilotSessionId: string;
  sdkSessionId?: string;
  workingDirectory?: string;
  model?: string;
  mode?: 'code' | 'plan' | 'ask';
  providerId?: string;
}): ChannelBinding {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const existing = getChannelBinding(params.channelType, params.chatId);

  if (existing) {
    db.prepare(
      `UPDATE channel_bindings SET codepilot_session_id = ?, sdk_session_id = ?, working_directory = ?, model = ?, mode = ?, provider_id = ?, updated_at = ?
       WHERE channel_type = ? AND chat_id = ?`
    ).run(
      params.codepilotSessionId,
      params.sdkSessionId ?? existing.sdkSessionId,
      params.workingDirectory ?? existing.workingDirectory,
      params.model ?? existing.model,
      params.mode ?? existing.mode,
      params.providerId ?? existing.providerId ?? '',
      now,
      params.channelType,
      params.chatId,
    );
  } else {
    const id = crypto.randomBytes(16).toString('hex');
    db.prepare(
      `INSERT INTO channel_bindings (id, channel_type, chat_id, codepilot_session_id, sdk_session_id, working_directory, model, mode, provider_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      id,
      params.channelType,
      params.chatId,
      params.codepilotSessionId,
      params.sdkSessionId || '',
      params.workingDirectory || '',
      params.model || '',
      params.mode || 'code',
      params.providerId || '',
      now,
      now,
    );
  }

  return getChannelBinding(params.channelType, params.chatId)!;
}

export function listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
  const db = getDb();
  let rows: Array<{
    id: string; channel_type: string; chat_id: string; codepilot_session_id: string;
    sdk_session_id: string; working_directory: string; model: string; mode: string;
    provider_id: string; active: number; created_at: string; updated_at: string;
  }>;

  if (channelType) {
    rows = db.prepare('SELECT * FROM channel_bindings WHERE channel_type = ? ORDER BY updated_at DESC').all(channelType) as typeof rows;
  } else {
    rows = db.prepare('SELECT * FROM channel_bindings ORDER BY updated_at DESC').all() as typeof rows;
  }

  return rows.map(row => ({
    id: row.id,
    channelType: row.channel_type as ChannelType,
    chatId: row.chat_id,
    codepilotSessionId: row.codepilot_session_id,
    sdkSessionId: row.sdk_session_id,
    workingDirectory: row.working_directory,
    model: row.model,
    mode: row.mode as 'code' | 'plan' | 'ask',
    providerId: row.provider_id || undefined,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function updateChannelBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'providerId' | 'active'>>,
): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (updates.sdkSessionId !== undefined) { sets.push('sdk_session_id = ?'); values.push(updates.sdkSessionId); }
  if (updates.workingDirectory !== undefined) { sets.push('working_directory = ?'); values.push(updates.workingDirectory); }
  if (updates.model !== undefined) { sets.push('model = ?'); values.push(updates.model); }
  if (updates.mode !== undefined) { sets.push('mode = ?'); values.push(updates.mode); }
  if (updates.providerId !== undefined) { sets.push('provider_id = ?'); values.push(updates.providerId); }
  if (updates.active !== undefined) { sets.push('active = ?'); values.push(updates.active ? 1 : 0); }

  values.push(id);
  db.prepare(`UPDATE channel_bindings SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

// ==========================================
// Bridge: Channel Offset Operations
// ==========================================

export function getChannelOffset(channelType: ChannelType | string): string {
  const db = getDb();
  const row = db.prepare('SELECT offset_value FROM channel_offsets WHERE channel_type = ?').get(channelType) as { offset_value: string } | undefined;
  return row?.offset_value || '0';
}

export function setChannelOffset(channelType: ChannelType | string, offsetValue: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    `INSERT INTO channel_offsets (channel_type, offset_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(channel_type) DO UPDATE SET offset_value = excluded.offset_value, updated_at = excluded.updated_at`
  ).run(channelType, offsetValue, now);
}

// ==========================================
// Bridge: Dedup Operations
// ==========================================

export function checkDedup(dedupKey: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT 1 FROM channel_dedupe WHERE dedup_key = ?').get(dedupKey);
  return !!row;
}

export function insertDedup(dedupKey: string, ttlMs: number = 24 * 60 * 60 * 1000): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const expiresAt = new Date(Date.now() + ttlMs).toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    `INSERT OR IGNORE INTO channel_dedupe (dedup_key, created_at, expires_at) VALUES (?, ?, ?)`
  ).run(dedupKey, now, expiresAt);
}

export function cleanupExpiredDedup(): number {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const result = db.prepare('DELETE FROM channel_dedupe WHERE expires_at < ?').run(now);
  return result.changes;
}

// ==========================================
// Bridge: Outbound Ref Operations
// ==========================================

export function insertOutboundRef(params: {
  channelType: ChannelType;
  chatId: string;
  codepilotSessionId: string;
  platformMessageId: string;
  purpose?: string;
}): void {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    `INSERT INTO channel_outbound_refs (id, channel_type, chat_id, codepilot_session_id, platform_message_id, purpose, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, params.channelType, params.chatId, params.codepilotSessionId, params.platformMessageId, params.purpose || 'response', now);
}

export function getOutboundRefs(codepilotSessionId: string): Array<{
  id: string;
  channelType: ChannelType;
  chatId: string;
  platformMessageId: string;
  purpose: string;
  createdAt: string;
}> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM channel_outbound_refs WHERE codepilot_session_id = ? ORDER BY created_at DESC'
  ).all(codepilotSessionId) as Array<{
    id: string; channel_type: string; chat_id: string; codepilot_session_id: string;
    platform_message_id: string; purpose: string; created_at: string;
  }>;
  return rows.map(r => ({
    id: r.id,
    channelType: r.channel_type as ChannelType,
    chatId: r.chat_id,
    platformMessageId: r.platform_message_id,
    purpose: r.purpose,
    createdAt: r.created_at,
  }));
}

// ==========================================
// Bridge: Audit Log Operations
// ==========================================

export function insertAuditLog(params: {
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId?: string;
  summary?: string;
}): void {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    `INSERT INTO channel_audit_logs (id, channel_type, chat_id, direction, message_id, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, params.channelType, params.chatId, params.direction, params.messageId || '', params.summary || '', now);
}

export function getAuditLogs(channelType: ChannelType, chatId: string, limit: number = 50): Array<{
  id: string;
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
  createdAt: string;
}> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM channel_audit_logs WHERE channel_type = ? AND chat_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(channelType, chatId, limit) as Array<{
    id: string; channel_type: string; chat_id: string; direction: string;
    message_id: string; summary: string; created_at: string;
  }>;
  return rows.map(r => ({
    id: r.id,
    channelType: r.channel_type as ChannelType,
    chatId: r.chat_id,
    direction: r.direction as 'inbound' | 'outbound',
    messageId: r.message_id,
    summary: r.summary,
    createdAt: r.created_at,
  }));
}

// ==========================================
// Bridge: Permission Link Operations
// ==========================================

export function insertPermissionLink(params: {
  permissionRequestId: string;
  channelType: ChannelType;
  chatId: string;
  messageId: string;
  toolName?: string;
  suggestions?: string;
}): void {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    `INSERT INTO channel_permission_links (id, permission_request_id, channel_type, chat_id, message_id, tool_name, suggestions, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, params.permissionRequestId, params.channelType, params.chatId, params.messageId, params.toolName || '', params.suggestions || '', now);
}

export function getPermissionLink(permissionRequestId: string): {
  id: string;
  permissionRequestId: string;
  channelType: ChannelType;
  chatId: string;
  messageId: string;
  toolName: string;
  suggestions: string;
  resolved: boolean;
  createdAt: string;
} | undefined {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM channel_permission_links WHERE permission_request_id = ?'
  ).get(permissionRequestId) as {
    id: string; permission_request_id: string; channel_type: string;
    chat_id: string; message_id: string; tool_name: string;
    suggestions: string; resolved: number; created_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    permissionRequestId: row.permission_request_id,
    channelType: row.channel_type as ChannelType,
    chatId: row.chat_id,
    messageId: row.message_id,
    toolName: row.tool_name,
    suggestions: row.suggestions,
    resolved: row.resolved === 1,
    createdAt: row.created_at,
  };
}

/**
 * Atomically mark a permission link as resolved.
 * Uses `resolved = 0` in the WHERE clause to prevent double-resolution races.
 * Returns true if the row was actually updated (i.e., it was not already resolved).
 */
export function markPermissionLinkResolved(permissionRequestId: string): boolean {
  const db = getDb();
  const result = db.prepare(
    'UPDATE channel_permission_links SET resolved = 1 WHERE permission_request_id = ? AND resolved = 0'
  ).run(permissionRequestId);
  return result.changes > 0;
}

// ==========================================
// WeChat Account Operations
// ==========================================

export interface WeixinAccountRow {
  account_id: string;
  user_id: string;
  base_url: string;
  cdn_base_url: string;
  token: string;
  name: string;
  enabled: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export function listWeixinAccounts(): WeixinAccountRow[] {
  const db = getDb();
  return db.prepare('SELECT * FROM weixin_accounts ORDER BY created_at DESC').all() as WeixinAccountRow[];
}

export function getWeixinAccount(accountId: string): WeixinAccountRow | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM weixin_accounts WHERE account_id = ?').get(accountId) as WeixinAccountRow | undefined;
}

export function upsertWeixinAccount(params: {
  accountId: string;
  userId?: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  token?: string;
  name?: string;
  enabled?: boolean;
}): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(`
    INSERT INTO weixin_accounts (account_id, user_id, base_url, cdn_base_url, token, name, enabled, last_login_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, weixin_accounts.user_id),
      base_url = COALESCE(excluded.base_url, weixin_accounts.base_url),
      cdn_base_url = COALESCE(excluded.cdn_base_url, weixin_accounts.cdn_base_url),
      token = COALESCE(excluded.token, weixin_accounts.token),
      name = COALESCE(excluded.name, weixin_accounts.name),
      enabled = excluded.enabled,
      last_login_at = excluded.last_login_at,
      updated_at = excluded.updated_at
  `).run(
    params.accountId,
    params.userId || '',
    params.baseUrl || '',
    params.cdnBaseUrl || '',
    params.token || '',
    params.name || '',
    params.enabled !== false ? 1 : 0,
    now,
    now,
    now,
  );
}

export function deleteWeixinAccount(accountId: string): boolean {
  const db = getDb();
  // Also clean up context tokens and offsets
  db.prepare('DELETE FROM weixin_context_tokens WHERE account_id = ?').run(accountId);
  db.prepare('DELETE FROM channel_offsets WHERE channel_type = ?').run(`weixin:${accountId}`);
  const result = db.prepare('DELETE FROM weixin_accounts WHERE account_id = ?').run(accountId);
  return result.changes > 0;
}

export function setWeixinAccountEnabled(accountId: string, enabled: boolean): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(
    'UPDATE weixin_accounts SET enabled = ?, updated_at = ? WHERE account_id = ?'
  ).run(enabled ? 1 : 0, now, accountId);
}

export function getWeixinContextToken(accountId: string, peerUserId: string): string | undefined {
  const db = getDb();
  const row = db.prepare(
    'SELECT context_token FROM weixin_context_tokens WHERE account_id = ? AND peer_user_id = ?'
  ).get(accountId, peerUserId) as { context_token: string } | undefined;
  return row?.context_token;
}

export function upsertWeixinContextToken(accountId: string, peerUserId: string, contextToken: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(`
    INSERT INTO weixin_context_tokens (account_id, peer_user_id, context_token, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, peer_user_id) DO UPDATE SET
      context_token = excluded.context_token,
      updated_at = excluded.updated_at
  `).run(accountId, peerUserId, contextToken, now);
}

export function deleteWeixinContextTokensByAccount(accountId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM weixin_context_tokens WHERE account_id = ?').run(accountId);
}

// ==========================================
// CLI Tools — Custom Tools
// ==========================================

export function getAllCustomCliTools(): CustomCliTool[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM cli_tools_custom WHERE enabled = 1 ORDER BY created_at DESC').all() as Array<{
    id: string; name: string; bin_path: string; bin_name: string; version: string | null;
    install_method: string; install_package: string; enabled: number; created_at: string; updated_at: string;
  }>;
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    binPath: r.bin_path,
    binName: r.bin_name,
    version: r.version,
    installMethod: r.install_method,
    installPackage: r.install_package,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function getCustomCliTool(id: string): CustomCliTool | undefined {
  const db = getDb();
  const r = db.prepare('SELECT * FROM cli_tools_custom WHERE id = ?').get(id) as {
    id: string; name: string; bin_path: string; bin_name: string; version: string | null;
    install_method: string; install_package: string; enabled: number; created_at: string; updated_at: string;
  } | undefined;
  if (!r) return undefined;
  return {
    id: r.id, name: r.name, binPath: r.bin_path, binName: r.bin_name,
    version: r.version, installMethod: r.install_method, installPackage: r.install_package,
    enabled: r.enabled === 1, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createCustomCliTool(params: { name: string; binPath: string; binName: string; version?: string | null; installMethod?: string; installPackage?: string }): CustomCliTool {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // Idempotency: if a tool with the same bin_path already exists, update and return it
  const existing = db.prepare('SELECT id FROM cli_tools_custom WHERE bin_path = ?').get(params.binPath) as { id: string } | undefined;
  if (existing) {
    const method = params.installMethod || 'unknown';
    const pkg = params.installPackage || '';
    db.prepare(`
      UPDATE cli_tools_custom SET name = ?,  version = ?,
        install_method = CASE WHEN ? != 'unknown' THEN ? ELSE install_method END,
        install_package = CASE WHEN ? != '' THEN ? ELSE install_package END,
        updated_at = ? WHERE id = ?
    `).run(params.name, params.version ?? null, method, method, pkg, pkg, now, existing.id);
    return getCustomCliTool(existing.id)!;
  }

  const baseId = `custom-${params.binName}`;

  // Handle id collisions
  let id = baseId;
  let counter = 2;
  while (db.prepare('SELECT id FROM cli_tools_custom WHERE id = ?').get(id)) {
    id = `${baseId}-${counter++}`;
  }

  db.prepare(
    'INSERT INTO cli_tools_custom (id, name, bin_path, bin_name, version, install_method, install_package, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, params.name, params.binPath, params.binName, params.version ?? null, params.installMethod || 'unknown', params.installPackage || '', now, now);

  return getCustomCliTool(id)!;
}

export function deleteCustomCliTool(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM cli_tools_custom WHERE id = ?').run(id);
  return result.changes > 0;
}

// ==========================================
// CLI Tools — Descriptions
// ==========================================

export function getAllCliToolDescriptions(): Record<string, { zh: string; en: string; structured?: unknown }> {
  const db = getDb();
  const rows = db.prepare('SELECT tool_id, description_zh, description_en, structured_json FROM cli_tool_descriptions').all() as Array<{
    tool_id: string; description_zh: string; description_en: string; structured_json: string;
  }>;
  const result: Record<string, { zh: string; en: string; structured?: unknown }> = {};
  for (const r of rows) {
    let structured: unknown = undefined;
    if (r.structured_json) {
      try { structured = JSON.parse(r.structured_json); } catch { /* ignore */ }
    }
    result[r.tool_id] = { zh: r.description_zh, en: r.description_en, ...(structured ? { structured } : {}) };
  }
  return result;
}

export function upsertCliToolDescription(toolId: string, zh: string, en: string, structuredJson?: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare(`
    INSERT INTO cli_tool_descriptions (tool_id, description_zh, description_en, structured_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tool_id) DO UPDATE SET
      description_zh = excluded.description_zh,
      description_en = excluded.description_en,
      structured_json = excluded.structured_json,
      updated_at = excluded.updated_at
  `).run(toolId, zh, en, structuredJson || '', now);
}

export function bulkUpsertCliToolDescriptions(entries: Array<{ toolId: string; zh: string; en: string }>): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const stmt = db.prepare(`
    INSERT INTO cli_tool_descriptions (tool_id, description_zh, description_en, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tool_id) DO UPDATE SET
      description_zh = excluded.description_zh,
      description_en = excluded.description_en,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((items: typeof entries) => {
    for (const e of items) {
      stmt.run(e.toolId, e.zh, e.en, now);
    }
  });
  tx(entries);
}

// ==========================================
// Graceful Shutdown
// ==========================================

/**
 * Close the database connection gracefully.
 * In WAL mode, this ensures the WAL is checkpointed and the
 * -wal/-shm files are cleaned up properly.
 */
// ==========================================
// Scheduled Tasks
// ==========================================

export function createScheduledTask(task: Omit<ScheduledTask, 'id' | 'created_at' | 'updated_at'>): ScheduledTask {
  const db = getDb();
  const id = crypto.randomBytes(8).toString('hex');
  // Phase 3 Step 3: `kind` is required on the type; the API + tool
  // schemas validate it server-side. We do NOT silently default here
  // — letting an undefined slip through would re-introduce the
  // "natural-language reminder accidentally tries to call a model"
  // bug that the split was designed to prevent.
  if (task.kind !== 'reminder' && task.kind !== 'ai_task') {
    throw new Error(`createScheduledTask: kind must be 'reminder' or 'ai_task' (got ${JSON.stringify(task.kind)})`);
  }
  // Phase 3 Step 4: `source` distinguishes user tasks from system
  // heartbeat injection. Default `'user'` for back-compat; explicit
  // `'assistant_heartbeat'` only from `ensureHeartbeatTask`.
  const sourceValue: 'user' | 'assistant_heartbeat' =
    task.source === 'assistant_heartbeat' ? 'assistant_heartbeat' : 'user';
  // v7 fix (defensive) — `notify_on_complete` is INTEGER in SQLite;
  // better-sqlite3 throws on raw booleans. Callers should normalize
  // upstream (the route + AI tools do), but we coerce here as a
  // belt-and-suspenders so a future direct caller can't crash the DB
  // by passing `true`/`false`.
  const rawNotify = task.notify_on_complete as unknown;
  const notifyValue: 0 | 1 =
    rawNotify === false || rawNotify === 0 || rawNotify === '0'
      ? 0
      : 1;
  db.prepare(`INSERT INTO scheduled_tasks (id, name, prompt, schedule_type, schedule_value, kind, source, next_run, status, priority, notify_on_complete, session_id, origin_session_id, working_directory, consecutive_errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
    id, task.name, task.prompt, task.schedule_type, task.schedule_value, task.kind, sourceValue, task.next_run, task.status || 'active', task.priority || 'normal', notifyValue, task.session_id || null, task.origin_session_id || null, task.working_directory || null
  );
  return getScheduledTask(id)!;
}

/**
 * Phase 3 Step 4 — system-injected heartbeat task helpers. Heartbeat
 * is identified by `source = 'assistant_heartbeat'` (kind stays
 * `'ai_task'`). `ensureHeartbeatTask` is idempotent: returns the
 * existing row if one already exists, otherwise creates one with the
 * given interval. `removeHeartbeatTask` is also idempotent (no-op
 * when no row).
 */
export function getHeartbeatTask(): ScheduledTask | undefined {
  const db = getDb();
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE source = 'assistant_heartbeat' LIMIT 1")
    .get() as ScheduledTask | undefined;
}

export function removeHeartbeatTask(): void {
  const db = getDb();
  db.prepare("DELETE FROM scheduled_tasks WHERE source = 'assistant_heartbeat'").run();
}

export function getScheduledTask(id: string): ScheduledTask | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined;
}

export function listScheduledTasks(opts?: { status?: string }): ScheduledTask[] {
  const db = getDb();
  if (opts?.status) {
    return db.prepare('SELECT * FROM scheduled_tasks WHERE status = ? ORDER BY next_run ASC').all(opts.status) as ScheduledTask[];
  }
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[];
}

export function getDueTasks(): ScheduledTask[] {
  const db = getDb();
  // Phase 3 Step 3 fix — wrap `next_run` in datetime() so ISO strings
  // ('2026-05-09T09:05:00.000Z') compare correctly against `datetime('now')`
  // (which returns the space-separated form '2026-05-09 09:06:00').
  // The pre-fix comparison `next_run <= datetime('now')` did a string
  // collation that left "+5 minutes" once-tasks unfired in the same day.
  return db.prepare("SELECT * FROM scheduled_tasks WHERE datetime(next_run) <= datetime('now') AND status = 'active' AND (last_status IS NULL OR last_status != 'running')").all() as ScheduledTask[];
}

export function updateScheduledTask(id: string, updates: Partial<ScheduledTask>): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'id' || key === 'created_at') continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Insert one task_run_logs row. Phase 3 Step 3 changes:
 *   - returns the new row's id so `runScheduledTaskNow` can update it
 *     in place when the run terminates;
 *   - accepts optional `notification_event_id` so a successful fire
 *     links to the notification event it produced;
 *   - `duration_ms` is now optional (running rows don't have one yet).
 *
 * One execution = one row. Use `updateTaskRunLog(runId, …)` to flip
 * 'running' → 'success' / 'error' on the same row instead of inserting
 * a second.
 */
/**
 * Phase 3 Step 4 — application-layer task_run_logs.status whitelist.
 * Includes the 5-state v2 enum AND the legacy `'success'` / `'error'`
 * values for backwards compatibility (existing rows stay untouched;
 * legacy callers writing those values continue to work, while new
 * call sites get TypeScript-enforced into the 5-state subset via
 * `TaskRunStatus`). DB column has no CHECK constraint (SQLite
 * limitation); validation happens here.
 */
const ALLOWED_TASK_RUN_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'succeeded',
  'failed',
  'waiting_for_permission',
  'cancelled',
  'skipped_empty',
  'skipped_reconcile_drift',
  'blocked',
  // Legacy values still accepted on read; insert path also tolerates
  // them so v6 / Phase 3 Step 3 callers don't break before they're
  // migrated to the 5-state enum.
  'success',
  'error',
  'skipped',
]);

function assertValidTaskRunStatus(status: string): void {
  if (!ALLOWED_TASK_RUN_STATUSES.has(status)) {
    throw new Error(
      `[task_run_logs] invalid status '${status}'. Must be one of: ${Array.from(ALLOWED_TASK_RUN_STATUSES).join(', ')}`,
    );
  }
}

export function insertTaskRunLog(log: {
  task_id: string;
  status: string;
  result?: string;
  error?: string;
  duration_ms?: number;
  notification_event_id?: string;
}): { runId: string } {
  assertValidTaskRunStatus(log.status);
  const db = getDb();
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(
    'INSERT INTO task_run_logs (id, task_id, status, result, error, duration_ms, notification_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    log.task_id,
    log.status,
    log.result ?? null,
    log.error ?? null,
    log.duration_ms ?? null,
    log.notification_event_id ?? null,
  );
  return { runId: id };
}

/**
 * Update an existing task_run_logs row in place. v3 plan locks
 * "one execution = one row" — terminal status flip happens here, not
 * via a second insert. Caller passes only the fields that changed.
 */
export function updateTaskRunLog(
  runId: string,
  updates: {
    status?: string;
    result?: string | null;
    error?: string | null;
    duration_ms?: number | null;
    notification_event_id?: string | null;
  },
): void {
  if (updates.status !== undefined) {
    assertValidTaskRunStatus(updates.status);
  }
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.result !== undefined) {
    fields.push('result = ?');
    values.push(updates.result);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }
  if (updates.duration_ms !== undefined) {
    fields.push('duration_ms = ?');
    values.push(updates.duration_ms);
  }
  if (updates.notification_event_id !== undefined) {
    fields.push('notification_event_id = ?');
    values.push(updates.notification_event_id);
  }
  if (fields.length === 0) return;
  values.push(runId);
  db.prepare(`UPDATE task_run_logs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/** Pull the recent execution history for a task — newest first. */
export function listTaskRunLogs(taskId: string, limit = 50): Array<{
  id: string;
  task_id: string;
  status: string;
  result: string | null;
  error: string | null;
  duration_ms: number | null;
  notification_event_id: string | null;
  created_at: string;
}> {
  const db = getDb();
  return db
    .prepare(
      'SELECT id, task_id, status, result, error, duration_ms, notification_event_id, created_at FROM task_run_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(taskId, limit) as Array<{
      id: string;
      task_id: string;
      status: string;
      result: string | null;
      error: string | null;
      duration_ms: number | null;
      notification_event_id: string | null;
      created_at: string;
    }>;
}

/**
 * Phase 3 Step 4 — inline-join helper used by
 * `/api/chat/sessions/[id]/messages` to surface `task_run_logs` rows
 * referenced by `messages.task_run_id` in a single round-trip. Returns
 * a record keyed by run id so the API caller can build a flat
 * `taskRuns` map without N+1 fetches per marker.
 */
export function getTaskRunSummariesByIds(
  runIds: ReadonlyArray<string>,
): Record<string, {
  id: string;
  task_id: string;
  status: string;
  task_name?: string;
  task_kind?: 'reminder' | 'ai_task';
  task_source?: 'user' | 'assistant_heartbeat';
  created_at: string;
}> {
  if (runIds.length === 0) return {};
  const db = getDb();
  const placeholders = runIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT trl.id, trl.task_id, trl.status, trl.created_at,
              st.name AS task_name, st.kind AS task_kind, st.source AS task_source
         FROM task_run_logs trl
         LEFT JOIN scheduled_tasks st ON st.id = trl.task_id
        WHERE trl.id IN (${placeholders})`,
    )
    .all(...runIds) as Array<{
      id: string;
      task_id: string;
      status: string;
      created_at: string;
      task_name: string | null;
      task_kind: string | null;
      task_source: string | null;
    }>;
  const out: Record<string, {
    id: string;
    task_id: string;
    status: string;
    task_name?: string;
    task_kind?: 'reminder' | 'ai_task';
    task_source?: 'user' | 'assistant_heartbeat';
    created_at: string;
  }> = {};
  for (const r of rows) {
    out[r.id] = {
      id: r.id,
      task_id: r.task_id,
      status: r.status,
      task_name: r.task_name ?? undefined,
      task_kind: (r.task_kind === 'reminder' || r.task_kind === 'ai_task') ? r.task_kind : undefined,
      task_source: (r.task_source === 'assistant_heartbeat' || r.task_source === 'user') ? r.task_source : undefined,
      created_at: r.created_at,
    };
  }
  return out;
}

/**
 * Phase 3 Step 4 — fetch a single task_run_logs row by id, used by
 * `/api/tasks/runs/[runId]/cancel` and the WaitingForPermissionPanel
 * to confirm a run is still in `waiting_for_permission` before
 * cancelling. Returns undefined when the row doesn't exist.
 */
export function getTaskRunById(runId: string): {
  id: string;
  task_id: string;
  status: string;
  result: string | null;
  error: string | null;
  duration_ms: number | null;
  notification_event_id: string | null;
  created_at: string;
} | undefined {
  const db = getDb();
  return db
    .prepare(
      'SELECT id, task_id, status, result, error, duration_ms, notification_event_id, created_at FROM task_run_logs WHERE id = ?',
    )
    .get(runId) as {
      id: string;
      task_id: string;
      status: string;
      result: string | null;
      error: string | null;
      duration_ms: number | null;
      notification_event_id: string | null;
      created_at: string;
    } | undefined;
}

// ==========================================
// Phase 3 Step 3 — notification events / deliveries
// ==========================================

/**
 * Insert one notification_events row. v4 plan: 1 row per logical task
 * notification. Caller is `notification-manager.sendNotification()`.
 */
export function insertNotificationEvent(evt: {
  event_id: string;
  task_id?: string | null;
  session_id?: string | null;
  action?: { type: string; payload: string } | null;
  source?: 'codepilot' | 'external';
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'urgent';
}): void {
  const db = getDb();
  const id = crypto.randomBytes(8).toString('hex');
  db.prepare(
    `INSERT INTO notification_events (
       id, event_id, task_id, session_id, action_type, action_payload,
       source, title, body, priority, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
  ).run(
    id,
    evt.event_id,
    evt.task_id ?? null,
    evt.session_id ?? null,
    evt.action?.type ?? null,
    evt.action?.payload ?? null,
    evt.source ?? 'codepilot',
    evt.title,
    evt.body,
    evt.priority,
  );
}

/**
 * v5 fix — UPSERT a delivery row by `(event_id, channel)`. ack route +
 * `sendNotification` channel-enumeration both use this; the DB
 * `UNIQUE(event_id, channel)` constraint plus this helper guarantees
 * at most one row per pair regardless of how many ack hits land.
 *
 * Behavior:
 *   - First call → INSERT; sets `created_at`, leaves `acked_at` null
 *     unless the initial state is terminal (delivered / error /
 *     not_configured / skipped).
 *   - Subsequent calls → UPDATE existing row.
 *   - State transition guard: a row already in a terminal SUCCESS
 *     state ('delivered') will not be flipped to a terminal FAILURE
 *     ('error') by a stale ack and vice versa. `queued → terminal`
 *     and `not_configured → terminal` (config arrived after) are
 *     allowed; everything else is a no-op (returns the existing row).
 *
 * Returns whether the call wrote anything (insert or update). False
 * means the call was rejected by the state-transition guard.
 */
export function upsertNotificationDelivery(args: {
  event_id: string;
  channel: string;
  status: 'queued' | 'delivered' | 'error' | 'not_configured' | 'skipped';
  error?: string | null;
}): boolean {
  const db = getDb();
  const existing = db
    .prepare('SELECT status FROM notification_deliveries WHERE event_id = ? AND channel = ?')
    .get(args.event_id, args.channel) as { status: string } | undefined;
  const TERMINAL = new Set(['delivered', 'error']);
  if (existing) {
    if (existing.status === args.status) {
      return true; // idempotent re-ack on the same terminal status
    }
    if (TERMINAL.has(existing.status) && existing.status !== args.status) {
      return false; // refuse delivered ↔ error or any backwards transition
    }
    const acked = TERMINAL.has(args.status) ? new Date().toISOString() : null;
    db.prepare(
      'UPDATE notification_deliveries SET status = ?, error = ?, acked_at = ? WHERE event_id = ? AND channel = ?',
    ).run(args.status, args.error ?? null, acked, args.event_id, args.channel);
    return true;
  }
  const id = crypto.randomBytes(8).toString('hex');
  const acked = TERMINAL.has(args.status) || args.status === 'not_configured' || args.status === 'skipped'
    ? new Date().toISOString()
    : null;
  db.prepare(
    `INSERT INTO notification_deliveries (id, event_id, channel, status, error, acked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, args.event_id, args.channel, args.status, args.error ?? null, acked);
  return true;
}

export function listNotificationDeliveries(eventId: string): Array<{
  id: string;
  event_id: string;
  channel: string;
  status: string;
  error: string | null;
  created_at: string;
  acked_at: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
}> {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, event_id, channel, status, error, created_at, acked_at,
              attempt_count, last_attempt_at, next_attempt_at
       FROM notification_deliveries WHERE event_id = ? ORDER BY created_at ASC`,
    )
    .all(eventId) as Array<{
      id: string;
      event_id: string;
      channel: string;
      status: string;
      error: string | null;
      created_at: string;
      acked_at: string | null;
      attempt_count: number;
      last_attempt_at: string | null;
      next_attempt_at: string | null;
    }>;
}

export interface ClaimedNotificationDelivery {
  delivery_id: string;
  event_id: string;
  channel: string;
  attempt_count: number;
  title: string;
  body: string;
  priority: 'low' | 'normal' | 'urgent';
  task_id: string | null;
  session_id: string | null;
  action_type: string | null;
  action_payload: string | null;
}

/** Atomically lease the oldest claimable delivery for one channel. */
export function claimNotificationDelivery(args: {
  channel: string;
  owner: string;
  now?: Date;
  staleAfterMs?: number;
}): ClaimedNotificationDelivery | null {
  const db = getDb();
  const now = args.now ?? new Date();
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - (args.staleAfterMs ?? 30_000)).toISOString();
  const claim = db.transaction(() => {
    const candidate = db.prepare(`
      SELECT d.id
      FROM notification_deliveries d
      WHERE d.channel = ?
        AND d.status = 'queued'
        AND (d.next_attempt_at IS NULL OR datetime(d.next_attempt_at) <= datetime(?))
        AND (d.claim_owner IS NULL OR datetime(d.claimed_at) <= datetime(?))
      ORDER BY datetime(d.created_at) ASC, d.id ASC
      LIMIT 1
    `).get(args.channel, nowIso, staleIso) as { id: string } | undefined;
    if (!candidate) return null;

    const updated = db.prepare(`
      UPDATE notification_deliveries
      SET claim_owner = ?, claimed_at = ?, last_attempt_at = ?,
          attempt_count = attempt_count + 1
      WHERE id = ?
        AND status = 'queued'
        AND (claim_owner IS NULL OR datetime(claimed_at) <= datetime(?))
    `).run(args.owner, nowIso, nowIso, candidate.id, staleIso);
    if (updated.changes !== 1) return null;

    return db.prepare(`
      SELECT d.id AS delivery_id, d.event_id, d.channel, d.attempt_count,
             e.title, e.body, e.priority, e.task_id, e.session_id,
             e.action_type, e.action_payload
      FROM notification_deliveries d
      JOIN notification_events e ON e.event_id = d.event_id
      WHERE d.id = ?
    `).get(candidate.id) as ClaimedNotificationDelivery;
  });
  return claim();
}

/** Settle a leased attempt without expanding the frozen status enum. */
export function settleClaimedNotificationDelivery(args: {
  deliveryId: string;
  owner: string;
  outcome: 'delivered' | 'error';
  error?: string | null;
  retryable?: boolean;
  now?: Date;
  maxAttempts?: number;
}): { written: boolean; status: 'queued' | 'delivered' | 'error' | null } {
  const db = getDb();
  const now = args.now ?? new Date();
  const row = db.prepare(`
    SELECT status, attempt_count, claim_owner
    FROM notification_deliveries
    WHERE id = ?
  `).get(args.deliveryId) as {
    status: string;
    attempt_count: number;
    claim_owner: string | null;
  } | undefined;
  if (!row || row.status !== 'queued' || row.claim_owner !== args.owner) {
    return { written: false, status: row?.status as 'queued' | 'delivered' | 'error' | null ?? null };
  }

  if (args.outcome === 'delivered') {
    const result = db.prepare(`
      UPDATE notification_deliveries
      SET status = 'delivered', error = NULL, acked_at = ?,
          claim_owner = NULL, claimed_at = NULL, next_attempt_at = NULL
      WHERE id = ? AND status = 'queued' AND claim_owner = ?
    `).run(now.toISOString(), args.deliveryId, args.owner);
    return { written: result.changes === 1, status: result.changes === 1 ? 'delivered' : null };
  }

  const maxAttempts = Math.max(1, args.maxAttempts ?? 3);
  if (args.retryable && row.attempt_count < maxAttempts) {
    const backoffMs = Math.min(60_000, 2_000 * (2 ** Math.max(0, row.attempt_count - 1)));
    const nextAttempt = new Date(now.getTime() + backoffMs).toISOString();
    const result = db.prepare(`
      UPDATE notification_deliveries
      SET error = ?, claim_owner = NULL, claimed_at = NULL,
          next_attempt_at = ?, acked_at = NULL
      WHERE id = ? AND status = 'queued' AND claim_owner = ?
    `).run(args.error ?? 'native notification failed', nextAttempt, args.deliveryId, args.owner);
    return { written: result.changes === 1, status: result.changes === 1 ? 'queued' : null };
  }

  const result = db.prepare(`
    UPDATE notification_deliveries
    SET status = 'error', error = ?, acked_at = ?,
        claim_owner = NULL, claimed_at = NULL, next_attempt_at = NULL
    WHERE id = ? AND status = 'queued' AND claim_owner = ?
  `).run(args.error ?? 'native notification failed', now.toISOString(), args.deliveryId, args.owner);
  return { written: result.changes === 1, status: result.changes === 1 ? 'error' : null };
}

export function getNotificationEvent(eventId: string): {
  id: string;
  event_id: string;
  task_id: string | null;
  session_id: string | null;
  action_type: string | null;
  action_payload: string | null;
  source: string;
  title: string;
  body: string;
  priority: string;
  status: string;
  created_at: string;
} | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, event_id, task_id, session_id, action_type, action_payload,
              source, title, body, priority, status, created_at
       FROM notification_events WHERE event_id = ?`,
    )
    .get(eventId) as
      | {
          id: string;
          event_id: string;
          task_id: string | null;
          session_id: string | null;
          action_type: string | null;
          action_payload: string | null;
          source: string;
          title: string;
          body: string;
          priority: string;
          status: string;
          created_at: string;
        }
      | undefined;
}

export function deleteScheduledTask(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

export function closeDb(): void {
  const state = getDatabaseProcessState();
  if (state.db) {
    try {
      state.db.close();
      console.log('[db] Database closed gracefully');
    } catch (err) {
      console.warn('[db] Error closing database:', err);
    }
    state.db = null;
  }
}

// Register shutdown handlers to close the database when the process exits.
// This prevents WAL file accumulation and potential data loss.
function registerShutdownHandlers(): void {
  const target = globalThis as typeof globalThis & {
    [DATABASE_SHUTDOWN_HANDLER_KEY]?: boolean;
  };
  if (target[DATABASE_SHUTDOWN_HANDLER_KEY]) return;
  target[DATABASE_SHUTDOWN_HANDLER_KEY] = true;
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[db] Received ${signal}, closing database...`);
    for (const [dbPath, state] of getDatabaseProcessStates()) {
      if (state.db) {
        try { state.db.close(); } catch { /* best effort */ }
        state.db = null;
      }
      if (!state.runtimeOwnerToken) continue;
      const ownerPath = `${dbPath}.runtime-owner.json`;
      try {
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as RuntimeOwnerRecord;
        if (owner.pid === process.pid && owner.token === state.runtimeOwnerToken) {
          fs.unlinkSync(ownerPath);
        }
      } catch {
        // Owner may already be gone (temporary test DB or abrupt cleanup).
      }
    }
  };

  // 'exit' fires synchronously when the process is about to exit
  process.on('exit', () => shutdown('exit'));

  // Handle termination signals (Docker stop, systemd, Ctrl+C, etc.)
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
    process.exit(0);
  });

  // Handle Windows-specific close events
  if (process.platform === 'win32') {
    process.on('SIGHUP', () => {
      shutdown('SIGHUP');
      process.exit(0);
    });
  }
}

registerShutdownHandlers();
