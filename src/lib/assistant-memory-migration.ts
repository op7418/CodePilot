/** One-time compatibility backfill; called only by database bootstrap, never by reads. */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const ASSISTANT_MEMORY_MIGRATION_KEY = 'memory.assistant-binding-migration.v1';
function canonicalOrOffline(value: string): string | undefined {
  if (!value || !path.isAbsolute(value)) return undefined;
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}
export function migrateLegacyAssistantMemoryBindings(db: Database.Database): void {
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(ASSISTANT_MEMORY_MIGRATION_KEY)) return;
  const migrate = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(ASSISTANT_MEMORY_MIGRATION_KEY)) return;
    const configured = db.prepare("SELECT value FROM settings WHERE key = 'assistant_workspace_path'").get() as { value: string } | undefined;
    const workspace = canonicalOrOffline(configured?.value || '');
    let count = 0;
    if (workspace) {
      // Preserve exactly the old assistant scope for rows present at upgrade.
      // Later ordinary sessions are never inferred from cwd by the reader.
      // SQL excludes task/already-bound rows and groups repeated directories;
      // aliases still get one canonical comparison per distinct path.
      const directories = db.prepare(`SELECT DISTINCT working_directory FROM chat_sessions s
        WHERE COALESCE(source, 'user') != 'task' AND working_directory != ''
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'memory.assistant-binding.' || s.id)`)
        .all() as Array<{ working_directory: string }>;
      const insert = db.prepare(`INSERT OR IGNORE INTO settings (key, value)
        SELECT 'memory.assistant-binding.' || id, ? FROM chat_sessions
        WHERE working_directory = ? AND COALESCE(source, 'user') != 'task'`);
      for (const { working_directory } of directories) {
        if (canonicalOrOffline(working_directory) !== workspace) continue;
        count += insert.run(JSON.stringify({ version: 1, workspace, source: 'legacy_upgrade' }), working_directory).changes;
      }
    }
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(ASSISTANT_MEMORY_MIGRATION_KEY,
      JSON.stringify({ version: 1, migratedSessions: count }));
  });
  migrate();
}
