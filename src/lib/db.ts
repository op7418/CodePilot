import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import type { ChatSession, Message, SettingsMap, TaskItem, TaskStatus, ApiProvider, CreateProviderRequest, UpdateProviderRequest, MediaJob, MediaJobStatus, MediaJobItem, MediaJobItemStatus, MediaContextEvent, BatchConfig } from '@/types';
import type { ChannelType, ChannelBinding } from './bridge/types';

const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
const DB_PATH = path.join(dataDir, 'codepilot.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Migrate from old locations if the new DB doesn't exist yet
    if (!fs.existsSync(DB_PATH)) {
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

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initDb(db);
  }
  return db;
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
      sdk_session_id TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      token_usage TEXT,
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
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
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

  // Run migrations for existing databases
  migrateDb(db);
}

function migrateDb(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(chat_sessions)").all() as { name: string }[];
  const colNames = columns.map(c => c.name);

  if (!colNames.includes('model')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('system_prompt')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('sdk_session_id')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN sdk_session_id TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('project_name')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN project_name TEXT NOT NULL DEFAULT ''");
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
    db.exec("ALTER TABLE chat_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!colNames.includes('mode')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'code'");
  }
  if (!colNames.includes('provider_name')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN provider_name TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('provider_id')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('sdk_cwd')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN sdk_cwd TEXT NOT NULL DEFAULT ''");
    // Backfill sdk_cwd from working_directory for existing sessions
    db.exec("UPDATE chat_sessions SET sdk_cwd = working_directory WHERE sdk_cwd = '' AND working_directory != ''");
  }
  if (!colNames.includes('runtime_status')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN runtime_status TEXT NOT NULL DEFAULT 'idle'");
  }
  if (!colNames.includes('runtime_updated_at')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN runtime_updated_at TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('runtime_error')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN runtime_error TEXT NOT NULL DEFAULT ''");
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
    db.exec("ALTER TABLE messages ADD COLUMN token_usage TEXT");
  }

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
    db.exec("ALTER TABLE tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'user'");
  }
  if (!taskColNames.includes('sort_order')) {
    db.exec("ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
  }

  // Ensure api_providers table exists for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'anthropic',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      extra_env TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

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
    db.exec("ALTER TABLE media_generations ADD COLUMN favorited INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists
  }

  // Recover stale jobs: mark 'running' jobs as 'paused' after process restart
  db.exec(`
    UPDATE media_jobs SET status = 'paused', updated_at = datetime('now')
    WHERE status = 'running'
  `);
  db.exec(`
    UPDATE media_job_items SET status = 'pending', updated_at = datetime('now')
    WHERE status = 'processing'
  `);

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

  // Startup recovery: reset stale runtime states from previous process
  db.exec(`
    UPDATE chat_sessions
    SET runtime_status = 'idle',
        runtime_error = 'Process restarted',
        runtime_updated_at = datetime('now')
    WHERE runtime_status IN ('running', 'waiting_permission')
  `);
  db.exec("DELETE FROM session_runtime_locks");
  db.exec(`
    UPDATE permission_requests
    SET status = 'aborted',
        resolved_at = datetime('now'),
        message = 'Process restarted'
    WHERE status = 'pending'
  `);

  // Migrate existing settings to a default provider if api_providers is empty
  const providerCount = db.prepare('SELECT COUNT(*) as count FROM api_providers').get() as { count: number };
  if (providerCount.count === 0) {
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_auth_token'").get() as { value: string } | undefined;
    const baseUrlRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_base_url'").get() as { value: string } | undefined;
    if (tokenRow || baseUrlRow) {
      const id = crypto.randomBytes(16).toString('hex');
      const now = new Date().toISOString().replace('T', ' ').split('.')[0];
      db.prepare(
        'INSERT INTO api_providers (id, name, provider_type, base_url, api_key, is_active, sort_order, extra_env, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, 'Default', 'anthropic', baseUrlRow?.value || '', tokenRow?.value || '', 1, 0, '{}', 'Migrated from settings', now, now);
    }
  }

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
    db.exec("ALTER TABLE channel_permission_links ADD COLUMN tool_name TEXT NOT NULL DEFAULT ''");
  }
  if (permLinkColNames.length > 0 && !permLinkColNames.includes('suggestions')) {
    db.exec("ALTER TABLE channel_permission_links ADD COLUMN suggestions TEXT NOT NULL DEFAULT ''");
  }
  if (permLinkColNames.length > 0 && !permLinkColNames.includes('resolved')) {
    db.exec("ALTER TABLE channel_permission_links ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0");
  }
}

// ==========================================
// Session Operations
// ==========================================

export function getAllSessions(): ChatSession[] {
  const db = getDb();
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

export function getSession(id: string): ChatSession | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as ChatSession | undefined;
}

export function createSession(
  title?: string,
  model?: string,
  systemPrompt?: string,
  workingDirectory?: string,
  mode?: string,
  providerId?: string,
): ChatSession {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const wd = workingDirectory || '';
  const projectName = path.basename(wd);

  db.prepare(
    'INSERT INTO chat_sessions (id, title, created_at, updated_at, model, system_prompt, working_directory, sdk_session_id, project_name, status, mode, sdk_cwd, provider_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, title || 'New Chat', now, now, model || '', systemPrompt || '', wd, '', projectName, 'active', mode || 'code', wd, providerId || '');

  return getSession(id)!;
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateSessionTimestamp(id: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, id);
}

export function updateSessionTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, id);
}

export function updateSdkSessionId(id: string, sdkSessionId: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id);
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

export function getDefaultProviderId(): string | undefined {
  return getSetting('default_provider_id') || undefined;
}

export function setDefaultProviderId(id: string): void {
  setSetting('default_provider_id', id);
}

export function updateSessionWorkingDirectory(id: string, workingDirectory: string): void {
  const db = getDb();
  const projectName = path.basename(workingDirectory);
  db.prepare('UPDATE chat_sessions SET working_directory = ?, project_name = ? WHERE id = ?').run(workingDirectory, projectName, id);
}

export function updateSessionMode(id: string, mode: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET mode = ? WHERE id = ?').run(mode, id);
}

// ==========================================
// Message Operations
// ==========================================

export function getMessages(
  sessionId: string,
  options?: { limit?: number; beforeRowId?: number },
): { messages: Message[]; hasMore: boolean } {
  const db = getDb();
  const limit = options?.limit ?? 100;
  const beforeRowId = options?.beforeRowId;

  let rows: Message[];
  if (beforeRowId) {
    // Fetch `limit + 1` rows before the cursor to detect if there are more
    rows = db.prepare(
      'SELECT *, rowid as _rowid FROM messages WHERE session_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?'
    ).all(sessionId, beforeRowId, limit + 1) as Message[];
  } else {
    // Fetch the most recent `limit + 1` messages
    rows = db.prepare(
      'SELECT *, rowid as _rowid FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?'
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

export function addMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  tokenUsage?: string | null,
): Message {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at, token_usage) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, sessionId, role, content, now, tokenUsage || null);

  updateSessionTimestamp(sessionId);

  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message;
}

export function updateMessageContent(messageId: string, content: string): number {
  const db = getDb();
  const result = db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);
  return result.changes;
}

/**
 * Find the most recent assistant message in a session that contains a given text snippet,
 * update its content, and return the real message ID. Used as fallback when the frontend
 * only has a temporary message ID.
 */
export function updateMessageBySessionAndHint(
  sessionId: string,
  promptHint: string,
  content: string,
): { changes: number; messageId?: string } {
  const db = getDb();
  // Find the latest assistant message containing the prompt hint within an image-gen-request block
  const row = db.prepare(
    "SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' AND content LIKE '%image-gen-request%' AND content LIKE ? ORDER BY created_at DESC LIMIT 1"
  ).get(sessionId, `%${promptHint.slice(0, 60)}%`) as { id: string } | undefined;

  if (!row) return { changes: 0 };

  const result = db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, row.id);
  return { changes: result.changes, messageId: row.id };
}

export function clearSessionMessages(sessionId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  // Reset SDK session ID so next message starts fresh
  db.prepare('UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?').run('', sessionId);
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

export function getAllProviders(): ApiProvider[] {
  const db = getDb();
  return db.prepare('SELECT * FROM api_providers ORDER BY sort_order ASC, created_at ASC').all() as ApiProvider[];
}

export function getProvider(id: string): ApiProvider | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM api_providers WHERE id = ?').get(id) as ApiProvider | undefined;
}

export function getActiveProvider(): ApiProvider | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM api_providers WHERE is_active = 1 LIMIT 1').get() as ApiProvider | undefined;
}

export function createProvider(data: CreateProviderRequest): ApiProvider {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // Get max sort_order to append at end
  const maxRow = db.prepare('SELECT MAX(sort_order) as max_order FROM api_providers').get() as { max_order: number | null };
  const sortOrder = (maxRow.max_order ?? -1) + 1;

  db.prepare(
    'INSERT INTO api_providers (id, name, provider_type, base_url, api_key, is_active, sort_order, extra_env, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    data.name,
    data.provider_type || 'anthropic',
    data.base_url || '',
    data.api_key || '',
    0,
    sortOrder,
    data.extra_env || '{}',
    data.notes || '',
    now,
    now,
  );

  return getProvider(id)!;
}

export function updateProvider(id: string, data: UpdateProviderRequest): ApiProvider | undefined {
  const db = getDb();
  const existing = getProvider(id);
  if (!existing) return undefined;

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const name = data.name ?? existing.name;
  const providerType = data.provider_type ?? existing.provider_type;
  const baseUrl = data.base_url ?? existing.base_url;
  const apiKey = data.api_key ?? existing.api_key;
  const extraEnv = data.extra_env ?? existing.extra_env;
  const notes = data.notes ?? existing.notes;
  const sortOrder = data.sort_order ?? existing.sort_order;

  db.prepare(
    'UPDATE api_providers SET name = ?, provider_type = ?, base_url = ?, api_key = ?, extra_env = ?, notes = ?, sort_order = ?, updated_at = ? WHERE id = ?'
  ).run(name, providerType, baseUrl, apiKey, extraEnv, notes, sortOrder, now, id);

  return getProvider(id);
}

export function deleteProvider(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM api_providers WHERE id = ?').run(id);
  return result.changes > 0;
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

export function getTokenUsageStats(days: number = 30): {
  summary: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number;
    total_sessions: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };
  daily: Array<{
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  }>;
} {
  const db = getDb();

  const summary = db.prepare(`
    SELECT
      COALESCE(SUM(json_extract(m.token_usage, '$.input_tokens')), 0) AS total_input_tokens,
      COALESCE(SUM(json_extract(m.token_usage, '$.output_tokens')), 0) AS total_output_tokens,
      COALESCE(SUM(json_extract(m.token_usage, '$.cost_usd')), 0) AS total_cost,
      COUNT(DISTINCT m.session_id) AS total_sessions,
      COALESCE(SUM(json_extract(m.token_usage, '$.cache_read_input_tokens')), 0) AS cache_read_tokens,
      COALESCE(SUM(json_extract(m.token_usage, '$.cache_creation_input_tokens')), 0) AS cache_creation_tokens
    FROM messages m
    WHERE m.token_usage IS NOT NULL
      AND json_valid(m.token_usage) = 1
      AND m.created_at >= date('now', '-' || (? - 1) || ' days')
  `).get(days) as {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number;
    total_sessions: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  };

  const daily = db.prepare(`
    SELECT
      DATE(m.created_at) AS date,
      CASE
        WHEN COALESCE(NULLIF(s.provider_name, ''), '') != ''
        THEN s.provider_name
        ELSE COALESCE(NULLIF(s.model, ''), 'unknown')
      END AS model,
      COALESCE(SUM(json_extract(m.token_usage, '$.input_tokens')), 0) AS input_tokens,
      COALESCE(SUM(json_extract(m.token_usage, '$.output_tokens')), 0) AS output_tokens,
      COALESCE(SUM(json_extract(m.token_usage, '$.cost_usd')), 0) AS cost
    FROM messages m
    LEFT JOIN chat_sessions s ON m.session_id = s.id
    WHERE m.token_usage IS NOT NULL
      AND json_valid(m.token_usage) = 1
      AND m.created_at >= date('now', '-' || (? - 1) || ' days')
    GROUP BY DATE(m.created_at),
      CASE
        WHEN COALESCE(NULLIF(s.provider_name, ''), '') != ''
        THEN s.provider_name
        ELSE COALESCE(NULLIF(s.model, ''), 'unknown')
      END
    ORDER BY date ASC
  `).all(days) as Array<{
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cost: number;
  }>;

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
    active: number; created_at: string; updated_at: string;
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
}): ChannelBinding {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const existing = getChannelBinding(params.channelType, params.chatId);

  if (existing) {
    db.prepare(
      `UPDATE channel_bindings SET codepilot_session_id = ?, sdk_session_id = ?, working_directory = ?, model = ?, mode = ?, updated_at = ?
       WHERE channel_type = ? AND chat_id = ?`
    ).run(
      params.codepilotSessionId,
      params.sdkSessionId ?? existing.sdkSessionId,
      params.workingDirectory ?? existing.workingDirectory,
      params.model ?? existing.model,
      params.mode ?? existing.mode,
      now,
      params.channelType,
      params.chatId,
    );
  } else {
    const id = crypto.randomBytes(16).toString('hex');
    db.prepare(
      `INSERT INTO channel_bindings (id, channel_type, chat_id, codepilot_session_id, sdk_session_id, working_directory, model, mode, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      id,
      params.channelType,
      params.chatId,
      params.codepilotSessionId,
      params.sdkSessionId || '',
      params.workingDirectory || '',
      params.model || '',
      params.mode || 'code',
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
    active: number; created_at: string; updated_at: string;
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
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function updateChannelBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const sets: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (updates.sdkSessionId !== undefined) { sets.push('sdk_session_id = ?'); values.push(updates.sdkSessionId); }
  if (updates.workingDirectory !== undefined) { sets.push('working_directory = ?'); values.push(updates.workingDirectory); }
  if (updates.model !== undefined) { sets.push('model = ?'); values.push(updates.model); }
  if (updates.mode !== undefined) { sets.push('mode = ?'); values.push(updates.mode); }
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
// Graceful Shutdown
// ==========================================

/**
 * Close the database connection gracefully.
 * In WAL mode, this ensures the WAL is checkpointed and the
 * -wal/-shm files are cleaned up properly.
 */
export function closeDb(): void {
  if (db) {
    try {
      db.close();
      console.log('[db] Database closed gracefully');
    } catch (err) {
      console.warn('[db] Error closing database:', err);
    }
    db = null;
  }
}

// Register shutdown handlers to close the database when the process exits.
// This prevents WAL file accumulation and potential data loss.
function registerShutdownHandlers(): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[db] Received ${signal}, closing database...`);
    closeDb();
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
