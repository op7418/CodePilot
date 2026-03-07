/**
 * GitHub OAuth and API Service
 * Uses Device Flow for desktop app authentication
 */

import type { GitHubUser, GitHubRepo, GitHubCredential } from '@/types/github';

// GitHub OAuth settings - stored in user settings, not env vars
let cachedClientId: string | null = null;

/** Get GitHub Client ID from settings */
export async function getGitHubClientId(): Promise<string | null> {
  if (cachedClientId) return cachedClientId;

  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    cachedClientId = data.settings?.githubClientId || null;
    return cachedClientId;
  } catch {
    return null;
  }
}

/** Set GitHub Client ID in settings */
export async function setGitHubClientId(clientId: string): Promise<boolean> {
  try {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: { githubClientId: clientId }
      }),
    });
    if (res.ok) {
      cachedClientId = clientId;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Check if GitHub is configured */
export async function isGitHubConfigured(): Promise<boolean> {
  const clientId = await getGitHubClientId();
  return !!clientId;
}

// Device Flow response types
interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  error?: string;
  error_description?: string;
}

/** Start Device Flow - get device code and user code */
export async function startDeviceFlow(clientId: string): Promise<DeviceCodeResponse | null> {
  try {
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        scope: 'repo read:user user:email',
      }),
    });

    if (!response.ok) {
      console.error('Device flow start failed:', response.status);
      return null;
    }

    return response.json();
  } catch (error) {
    console.error('Failed to start device flow:', error);
    return null;
  }
}

/** Poll for device authorization */
export async function pollForToken(
  clientId: string,
  deviceCode: string
): Promise<TokenResponse | null> {
  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    return response.json();
  } catch (error) {
    console.error('Failed to poll for token:', error);
    return null;
  }
}

/** Get authenticated user info */
export async function getGitHubUser(accessToken: string): Promise<GitHubUser | null> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CodePilot',
      },
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

/** Get user's repositories */
export async function getUserRepos(
  accessToken: string,
  options?: {
    type?: 'all' | 'owner' | 'public' | 'private' | 'member';
    sort?: 'created' | 'updated' | 'pushed' | 'full_name';
    direction?: 'asc' | 'desc';
    per_page?: number;
    page?: number;
  }
): Promise<GitHubRepo[]> {
  try {
    const params = new URLSearchParams({
      type: options?.type || 'owner',
      sort: options?.sort || 'updated',
      direction: options?.direction || 'desc',
      per_page: String(options?.per_page || 100),
      page: String(options?.page || 1),
    });

    const response = await fetch(`https://api.github.com/user/repos?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CodePilot',
      },
    });

    if (!response.ok) {
      return [];
    }

    return response.json();
  } catch {
    return [];
  }
}

/** Search repositories */
export async function searchRepos(
  accessToken: string,
  query: string,
  options?: {
    per_page?: number;
    page?: number;
  }
): Promise<{ total_count: number; items: GitHubRepo[] }> {
  try {
    const params = new URLSearchParams({
      q: query,
      per_page: String(options?.per_page || 30),
      page: String(options?.page || 1),
    });

    const response = await fetch(`https://api.github.com/search/repositories?${params.toString()}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CodePilot',
      },
    });

    if (!response.ok) {
      return { total_count: 0, items: [] };
    }

    return response.json();
  } catch {
    return { total_count: 0, items: [] };
  }
}

// ==========================================
// Database operations (server-side only)
// ==========================================

/** Get database instance */
async function getDb() {
  const { default: Database } = await import('better-sqlite3');
  const path = await import('path');
  const os = await import('os');

  const dbPath = path.join(os.homedir(), '.codepilot', 'codepilot.db');
  return new Database(dbPath);
}

/** Initialize GitHub credentials table */
export async function initGitHubTables(): Promise<void> {
  const db = await getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS github_credentials (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      token_type TEXT DEFAULT 'Bearer',
      scope TEXT DEFAULT '',
      user_login TEXT NOT NULL,
      user_name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.close();
}

/** Save GitHub credential */
export async function saveGitHubCredential(credential: Omit<GitHubCredential, 'id' | 'created_at' | 'updated_at'>): Promise<GitHubCredential> {
  const db = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO github_credentials (id, access_token, token_type, scope, user_login, user_name, avatar_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, credential.access_token, credential.token_type, credential.scope, credential.user_login, credential.user_name, credential.avatar_url, now, now);

  db.close();

  return {
    id,
    ...credential,
    created_at: now,
    updated_at: now,
  };
}

/** Get stored GitHub credential */
export async function getGitHubCredential(): Promise<GitHubCredential | null> {
  const db = await getDb();

  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_credentials (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      token_type TEXT DEFAULT 'Bearer',
      scope TEXT DEFAULT '',
      user_login TEXT NOT NULL,
      user_name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const stmt = db.prepare('SELECT * FROM github_credentials LIMIT 1');
  const row = stmt.get() as GitHubCredential | undefined;

  db.close();

  return row || null;
}

/** Delete GitHub credential (logout) */
export async function deleteGitHubCredential(): Promise<void> {
  const db = await getDb();

  db.exec('DELETE FROM github_credentials');

  db.close();
}

/** Create a new repository on GitHub */
export async function createGitHubRepo(
  accessToken: string,
  options: {
    name: string;
    description?: string;
    private?: boolean;
    auto_init?: boolean;
  }
): Promise<GitHubRepo | null> {
  try {
    const response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'CodePilot',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: options.name,
        description: options.description || '',
        private: options.private ?? false,
        auto_init: options.auto_init ?? false,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Failed to create repo:', error);
      return null;
    }

    return response.json();
  } catch (error) {
    console.error('Failed to create GitHub repo:', error);
    return null;
  }
}
