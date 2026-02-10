import fs from 'fs';
import path from 'path';
import type { FileTreeNode, FilePreview } from '@/types';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '__pycache__',
  '.cache',
  '.turbo',
  'coverage',
  '.output',
  'build',
]);

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  xml: 'xml',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  mdx: 'markdown',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'fish',
  ps1: 'powershell',
  dockerfile: 'dockerfile',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
  prisma: 'prisma',
  env: 'dotenv',
  lua: 'lua',
  r: 'r',
  php: 'php',
  dart: 'dart',
  zig: 'zig',
};

export function getFileLanguage(ext: string): string {
  const normalized = ext.replace(/^\./, '').toLowerCase();
  return LANGUAGE_MAP[normalized] || 'plaintext';
}

export function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep) || resolvedTarget === resolvedBase;
}

/**
 * Check if the given path is a filesystem root (e.g. `/` on Unix, `C:\` on Windows).
 */
export function isRootPath(p: string): boolean {
  const resolved = path.resolve(p);
  return resolved === path.parse(resolved).root;
}

/**
 * Get the depth of a path relative to its filesystem root.
 * Examples:
 *   `/`            → 0
 *   `/etc`         → 1
 *   `/opt/projects`→ 2
 *   `C:\`          → 0
 *   `D:\projects`  → 1
 *   `D:\projects\myapp` → 2
 */
export function getPathDepth(p: string): number {
  const resolved = path.resolve(p);
  const root = path.parse(resolved).root;
  if (resolved === root) return 0;
  // Remove the root prefix and split by separator
  const relative = resolved.slice(root.length);
  return relative.split(path.sep).filter(Boolean).length;
}

/**
 * Minimum required directory depth for baseDir.
 * Depth ≥ 2 prevents shallow system directories like /etc, /tmp, /var
 * from being used as base directories while allowing real project paths
 * like /opt/projects/myapp or D:\projects\myapp.
 */
const MIN_BASE_DIR_DEPTH = 2;

/**
 * Check if a path is too broad to be used as a baseDir.
 * Rejects filesystem roots and shallow paths (depth < 2) that could
 * expose sensitive system directories.
 */
export function isBaseDirUnsafe(p: string): boolean {
  return getPathDepth(p) < MIN_BASE_DIR_DEPTH;
}

export function scanDirectory(dir: string, depth: number = 3): FileTreeNode[] {
  const resolvedDir = path.resolve(dir);

  if (!fs.existsSync(resolvedDir)) {
    return [];
  }

  return scanDirectoryRecursive(resolvedDir, depth);
}

function scanDirectoryRecursive(dir: string, depth: number): FileTreeNode[] {
  if (depth <= 0) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: FileTreeNode[] = [];

  // Sort: directories first, then files, both alphabetically
  const sorted = entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of sorted) {
    // Skip hidden files/dirs (except common config files)
    if (entry.name.startsWith('.') && !entry.name.startsWith('.env')) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;

      const children = scanDirectoryRecursive(fullPath, depth - 1);
      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'directory',
        children,
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).replace(/^\./, '');
      let size: number | undefined;
      try {
        const stat = fs.statSync(fullPath);
        size = stat.size;
      } catch {
        // Skip files we can't stat
      }

      nodes.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size,
        extension: ext || undefined,
      });
    }
  }

  return nodes;
}

export function readFilePreview(filePath: string, maxLines: number = 200): FilePreview {
  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  // Read the file content, limiting to maxLines
  const content = fs.readFileSync(resolvedPath, 'utf-8');
  const lines = content.split('\n');
  const truncated = lines.slice(0, maxLines).join('\n');

  const ext = path.extname(resolvedPath).replace(/^\./, '');
  const language = getFileLanguage(ext);

  return {
    path: resolvedPath,
    content: truncated,
    language,
    line_count: lines.length,
  };
}
