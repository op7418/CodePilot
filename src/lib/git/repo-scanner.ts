/**
 * Repository Scanner - scans directories for Git repositories
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';
import type { GitRepository, GitRepoWithStatus } from '@/types/git';
import { getDb } from '@/lib/db';
import { randomUUID } from 'crypto';

// Cache for repositories with status
let reposCache: {
  data: GitRepoWithStatus[];
  timestamp: number;
} | null = null;

const CACHE_TTL = 30 * 1000; // 30 seconds

/** Invalidate the repos cache */
export function invalidateReposCache(): void {
  reposCache = null;
}

/** Scan options */
export interface ScanOptions {
  /** Maximum depth to scan */
  maxDepth?: number;
  /** Directories to skip */
  skipDirs?: string[];
  /** Callback for progress */
  onProgress?: (current: string, found: number) => void;
}

const DEFAULT_SKIP_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.idea',
  '.vscode',
  'Pods',
  'DerivedData',
];

/**
 * Scan a directory for Git repositories
 */
export async function scanDirectory(
  rootPath: string,
  options: ScanOptions = {}
): Promise<string[]> {
  const { maxDepth = 3, skipDirs = DEFAULT_SKIP_DIRS, onProgress } = options;
  const repos: string[] = [];

  async function scan(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    const dirName = path.basename(dir);
    if (skipDirs.includes(dirName)) return;

    try {
      // Check if this directory is a git repo
      const gitDir = path.join(dir, '.git');
      if (fs.existsSync(gitDir)) {
        repos.push(dir);
        onProgress?.(dir, repos.length);
        return; // Don't scan inside a git repo
      }

      // Scan subdirectories
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subPath = path.join(dir, entry.name);
          await scan(subPath, depth + 1);
        }
      }
    } catch (error) {
      // Ignore permission errors etc.
    }
  }

  await scan(rootPath, 0);
  return repos;
}

/**
 * Get repository name from path
 */
export function getRepoName(repoPath: string): string {
  return path.basename(repoPath);
}

/**
 * Add a repository to the database
 */
export async function addRepository(
  repoPath: string,
  scanRoot?: string
): Promise<GitRepository> {
  const db = getDb();

  // Check if already exists
  const existing = db.prepare('SELECT * FROM git_repositories WHERE path = ?').get(repoPath) as GitRepository | undefined;
  if (existing) {
    return existing;
  }

  const id = randomUUID();
  const name = getRepoName(repoPath);

  db.prepare(`
    INSERT INTO git_repositories (id, path, name, scan_root, is_default)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, repoPath, name, scanRoot || null);

  // Invalidate cache when repo is added
  invalidateReposCache();

  return {
    id,
    path: repoPath,
    name,
    scan_root: scanRoot,
    is_default: false,
    created_at: new Date().toISOString(),
  };
}

/**
 * Remove a repository from the database
 */
export async function removeRepository(id: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM git_repositories WHERE id = ?').run(id);
  invalidateReposCache();
}

/**
 * Get all repositories from the database
 */
export async function getRepositories(): Promise<GitRepository[]> {
  const db = getDb();
  const repos = db.prepare('SELECT * FROM git_repositories ORDER BY name').all() as GitRepository[];
  return repos;
}

/**
 * Get repository by ID
 */
export async function getRepositoryById(id: string): Promise<GitRepository | null> {
  const db = getDb();
  const repo = db.prepare('SELECT * FROM git_repositories WHERE id = ?').get(id) as GitRepository | undefined;
  return repo || null;
}

/**
 * Get default repository
 */
export async function getDefaultRepository(): Promise<GitRepository | null> {
  const db = getDb();
  const repo = db.prepare('SELECT * FROM git_repositories WHERE is_default = 1 LIMIT 1').get() as GitRepository | undefined;
  return repo || null;
}

/**
 * Set default repository
 */
export async function setDefaultRepository(id: string): Promise<void> {
  const db = getDb();
  // Unset all defaults first
  db.prepare('UPDATE git_repositories SET is_default = 0').run();
  // Set the new default
  db.prepare('UPDATE git_repositories SET is_default = 1 WHERE id = ?').run(id);
}

/**
 * Update last opened time
 */
export async function updateLastOpened(id: string): Promise<void> {
  const db = getDb();
  db.prepare('UPDATE git_repositories SET last_opened_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id
  );
}

/**
 * Get repositories with their Git status (with caching)
 */
export async function getRepositoriesWithStatus(): Promise<GitRepoWithStatus[]> {
  // Return cached data if still valid
  if (reposCache && Date.now() - reposCache.timestamp < CACHE_TTL) {
    return reposCache.data;
  }

  const repos = await getRepositories();
  const result: GitRepoWithStatus[] = [];

  // First, gather all repo info in parallel (without visibility)
  const repoInfos = await Promise.all(
    repos.map(async (repo) => {
      try {
        const git = simpleGit(repo.path);
        const status = await git.status();
        const remotes = await git.getRemotes(true);

        const originRemote = remotes.find(r => r.name === 'origin');
        const originUrl = originRemote?.refs?.fetch;
        const isGitHubRepo = originUrl ? /github\.com/i.test(originUrl) : false;

        return {
          repo,
          status,
          remotes,
          originUrl,
          isGitHubRepo,
        };
      } catch (error) {
        return {
          repo,
          status: null,
          remotes: [],
          originUrl: null,
          isGitHubRepo: false,
        };
      }
    })
  );

  // Then, fetch visibility for GitHub repos in parallel
  const visibilityPromises = repoInfos.map(async (info) => {
    if (info.isGitHubRepo && info.originUrl) {
      return getRepoVisibility(info.originUrl);
    }
    return undefined;
  });

  const visibilities = await Promise.all(visibilityPromises);

  // Combine results
  for (let i = 0; i < repoInfos.length; i++) {
    const info = repoInfos[i];
    const isPrivate = visibilities[i];

    if (info.status) {
      result.push({
        ...info.repo,
        branch: info.status.current || undefined,
        changes: info.status.files.length,
        ahead: info.status.ahead,
        behind: info.status.behind,
        hasRemote: info.remotes.length > 0,
        isPrivate,
      });
    } else {
      result.push({
        ...info.repo,
        branch: undefined,
        changes: 0,
        hasRemote: false,
      });
    }
  }

  // Cache the result
  reposCache = {
    data: result,
    timestamp: Date.now(),
  };

  return result;
}

/**
 * Get repository visibility from GitHub API
 * Returns true if private, false if public, undefined if unknown
 */
async function getRepoVisibility(remoteUrl: string): Promise<boolean | undefined> {
  try {
    // Parse GitHub owner/repo from URL
    const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) return undefined;

    const owner = match[1];
    const repo = match[2].replace(/\.git$/, '');

    // Try to get GitHub token from settings file
    let githubToken: string | undefined;
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(content);
        githubToken = settings.githubToken;
      }
    } catch {
      // Ignore errors reading settings
    }

    // Also try to get from OAuth credentials in database
    if (!githubToken) {
      try {
        const db = getDb();
        const credential = db.prepare('SELECT access_token FROM github_credentials LIMIT 1').get() as { access_token: string } | undefined;
        githubToken = credential?.access_token;
      } catch {
        // Ignore errors reading from database
      }
    }

    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'CodePilot',
    };

    // Add auth header if we have a token
    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken}`;
    }

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });

    if (!response.ok) {
      return undefined;
    }

    const data = await response.json();
    return data.private;
  } catch {
    return undefined;
  }
}

// ==========================================
// Scan Root Management
// ==========================================

/**
 * Add a scan root directory
 */
export async function addScanRoot(rootPath: string): Promise<void> {
  const db = getDb();
  const id = randomUUID();

  try {
    db.prepare(`
      INSERT INTO git_scan_roots (id, path, enabled)
      VALUES (?, ?, 1)
    `).run(id, rootPath);
  } catch (error) {
    // Ignore if already exists
  }
}

/**
 * Remove a scan root
 */
export async function removeScanRoot(id: string): Promise<void> {
  const db = getDb();
  db.prepare('DELETE FROM git_scan_roots WHERE id = ?').run(id);
}

/**
 * Get all scan roots
 */
export async function getScanRoots(): Promise<{ id: string; path: string; enabled: boolean }[]> {
  const db = getDb();
  return db.prepare('SELECT * FROM git_scan_roots WHERE enabled = 1').all() as { id: string; path: string; enabled: boolean }[];
}

/**
 * Scan all configured roots and add repositories
 */
export async function scanAllRoots(
  onProgress?: (current: string, found: number) => void
): Promise<{ found: number; added: number; skipped: number }> {
  const roots = await getScanRoots();
  let found = 0;
  let added = 0;
  let skipped = 0;

  for (const root of roots) {
    if (!fs.existsSync(root.path)) continue;

    const repos = await scanDirectory(root.path, { onProgress });
    found += repos.length;

    for (const repoPath of repos) {
      try {
        await addRepository(repoPath, root.path);
        added++;
      } catch {
        skipped++;
      }
    }
  }

  return { found, added, skipped };
}
