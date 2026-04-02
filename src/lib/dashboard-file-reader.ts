/**
 * Shared file reading utilities for dashboard widget data sources.
 * Used by both the dashboard MCP server and the refresh API route.
 */

import fs from 'fs';
import path from 'path';

const MAX_FILE_CONTENT = 50_000; // 50KB total cap for source files

/** Resolve simple glob patterns (supports * and **) by walking the directory */
export function resolveGlobs(workDir: string, patterns: string[]): string[] {
  const results: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      // Literal path
      const fullPath = path.join(workDir, pattern);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        results.push(pattern);
      }
      continue;
    }

    // Simple glob: convert to regex and walk
    // Order matters: escape dots FIRST, then replace glob tokens
    // ** matches zero or more path segments (including none for top-level files)
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*\*\//g, '{{GLOBSTAR}}')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\{\{GLOBSTAR\}\}/g, '(.*\\/)?');
    const regex = new RegExp(`^${regexStr}$`);

    try {
      walkDir(workDir, '', regex, results);
    } catch {
      // Skip inaccessible directories
    }
  }
  return [...new Set(results)].slice(0, 50); // cap at 50 files
}

function walkDir(base: string, rel: string, regex: RegExp, results: string[], depth = 0): void {
  if (depth > 10) return; // prevent deep recursion
  const dir = path.join(base, rel);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkDir(base, entryRel, regex, results, depth + 1);
    } else if (entry.isFile() && regex.test(entryRel)) {
      results.push(entryRel);
    }
  }
}

export function readSourceFiles(workDir: string, relativePaths: string[]): { content: string; latestMtime: number } {
  let totalSize = 0;
  let latestMtime = 0;
  const parts: string[] = [];

  for (const rel of relativePaths) {
    const fullPath = path.join(workDir, rel);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;

      if (totalSize + stat.size > MAX_FILE_CONTENT) {
        parts.push(`\n--- ${rel} (truncated: file too large) ---\n`);
        continue;
      }
      const content = fs.readFileSync(fullPath, 'utf-8');
      parts.push(`\n--- ${rel} ---\n${content}`);
      totalSize += content.length;
    } catch {
      // Skip unreadable files
    }
  }

  return { content: parts.join(''), latestMtime };
}
