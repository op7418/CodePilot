import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { ManifestEntry, ChunkEntry, HotsetFile, AssistantWorkspaceConfig } from '@/types';
import { loadConfig, shouldIgnore } from '@/lib/workspace-config';
import { loadTaxonomy, classifyPath } from '@/lib/workspace-taxonomy';

export const INDEX_DIR = '.assistant/index';

export function computeFileHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

export function chunkMarkdown(
  content: string,
  chunkSize = 1200,
  overlap = 150,
): Array<{ heading: string; text: string; startLine: number; endLine: number }> {
  const lines = content.split('\n');
  const sections: Array<{ heading: string; lines: string[]; startLine: number }> = [];

  let currentHeading = '';
  let currentLines: string[] = [];
  let sectionStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^#{1,6}\s/)) {
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, lines: currentLines, startLine: sectionStart });
      }
      currentHeading = line.replace(/^#{1,6}\s+/, '').trim();
      currentLines = [line];
      sectionStart = i;
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, lines: currentLines, startLine: sectionStart });
  }

  const chunks: Array<{ heading: string; text: string; startLine: number; endLine: number }> = [];

  for (const section of sections) {
    const sectionText = section.lines.join('\n');
    if (sectionText.length <= chunkSize) {
      chunks.push({
        heading: section.heading,
        text: sectionText,
        startLine: section.startLine,
        endLine: section.startLine + section.lines.length - 1,
      });
    } else {
      // Split large sections with overlap
      let charPos = 0;
      let lineIdx = 0;

      while (charPos < sectionText.length) {
        const end = Math.min(charPos + chunkSize, sectionText.length);
        const chunkText = sectionText.slice(charPos, end);

        // Determine line range for this chunk
        const chunkLines = chunkText.split('\n');
        const startLine = section.startLine + lineIdx;
        const endLine = startLine + chunkLines.length - 1;

        chunks.push({
          heading: section.heading,
          text: chunkText,
          startLine,
          endLine,
        });

        if (end >= sectionText.length) break;

        // Advance by chunkSize - overlap
        const advance = chunkSize - overlap;
        const advancedText = sectionText.slice(charPos, charPos + advance);
        const advancedLines = advancedText.split('\n');
        lineIdx += advancedLines.length - 1;
        charPos += advance;
      }
    }
  }

  return chunks;
}

export function extractMarkdownMeta(content: string): {
  title: string;
  tags: string[];
  headings: string[];
  aliases: string[];
} {
  const lines = content.split('\n');
  let title = '';
  const tags: string[] = [];
  const headings: string[] = [];
  const aliases: string[] = [];

  // Parse YAML frontmatter
  if (lines[0]?.trim() === '---') {
    let fmEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        fmEnd = i;
        break;
      }
    }
    if (fmEnd > 0) {
      const fmLines = lines.slice(1, fmEnd);
      let currentKey = '';
      for (const fmLine of fmLines) {
        const kvMatch = fmLine.match(/^(\w+)\s*:\s*(.*)$/);
        if (kvMatch) {
          currentKey = kvMatch[1];
          const value = kvMatch[2].trim();
          if (currentKey === 'tags') {
            // Inline array: tags: [a, b, c]
            const inlineMatch = value.match(/^\[(.+)\]$/);
            if (inlineMatch) {
              tags.push(...inlineMatch[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')));
              currentKey = '';
            }
            // If value is non-empty but not array syntax, treat as single tag
            else if (value) {
              tags.push(value.replace(/^["']|["']$/g, ''));
              currentKey = '';
            }
          } else if (currentKey === 'aliases') {
            const inlineMatch = value.match(/^\[(.+)\]$/);
            if (inlineMatch) {
              aliases.push(...inlineMatch[1].split(',').map((a) => a.trim().replace(/^["']|["']$/g, '')));
              currentKey = '';
            } else if (value) {
              aliases.push(value.replace(/^["']|["']$/g, ''));
              currentKey = '';
            }
          } else {
            currentKey = '';
          }
        } else if (currentKey) {
          // List item under current key
          const listMatch = fmLine.match(/^\s*-\s+(.+)$/);
          if (listMatch) {
            const item = listMatch[1].trim().replace(/^["']|["']$/g, '');
            if (currentKey === 'tags') tags.push(item);
            else if (currentKey === 'aliases') aliases.push(item);
          } else {
            currentKey = '';
          }
        }
      }
    }
  }

  // Extract headings and title
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      headings.push(headingMatch[2].trim());
      if (!title && headingMatch[1] === '#') {
        title = headingMatch[2].trim();
      }
    }
  }

  // Extract inline #tags from content (not inside code blocks)
  let inCodeBlock = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const tagMatches = line.match(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_-]*)/g);
    if (tagMatches) {
      for (const match of tagMatches) {
        const tag = match.trim().slice(1); // remove #
        // Skip if it looks like a heading (line starts with #)
        if (!line.match(/^#{1,6}\s/) && !tags.includes(tag)) {
          tags.push(tag);
        }
      }
    }
  }

  return { title, tags, headings, aliases };
}

export function needsReindex(dir: string, filePath: string): boolean {
  const manifestPath = path.join(dir, INDEX_DIR, 'manifest.jsonl');
  if (!fs.existsSync(manifestPath)) return true;

  let fileMtime: number;
  try {
    fileMtime = fs.statSync(path.join(dir, filePath)).mtimeMs;
  } catch {
    return true;
  }

  const manifest = loadManifest(dir);
  const entry = manifest.find((e) => e.path === filePath);
  if (!entry) return true;

  return fileMtime > entry.mtime;
}

export function indexFile(
  dir: string,
  filePath: string,
): { manifest: ManifestEntry; chunks: ChunkEntry[] } {
  const fullPath = path.join(dir, filePath);
  const content = fs.readFileSync(fullPath, 'utf-8');
  const stat = fs.statSync(fullPath);
  const hash = computeFileHash(content);
  const meta = extractMarkdownMeta(content);
  const noteId = computeFileHash(filePath);

  const taxonomy = loadTaxonomy(dir);
  const category = classifyPath(filePath, taxonomy);
  const categoryIds = category ? [category.id] : [];

  const config = loadConfig(dir);
  const rawChunks = chunkMarkdown(content, config.index.chunkSize, config.index.chunkOverlap);

  const chunks: ChunkEntry[] = rawChunks.map((c, i) => ({
    chunkId: `${noteId}-${i}`,
    noteId,
    path: filePath,
    heading: c.heading,
    text: c.text,
    startLine: c.startLine,
    endLine: c.endLine,
  }));

  const manifest: ManifestEntry = {
    noteId,
    path: filePath,
    title: meta.title || path.basename(filePath, path.extname(filePath)),
    aliases: meta.aliases,
    tags: meta.tags,
    headings: meta.headings,
    mtime: stat.mtimeMs,
    size: stat.size,
    hash,
    summary: content.slice(0, 200).replace(/\n/g, ' ').trim(),
    categoryIds,
  };

  return { manifest, chunks };
}

function walkDir(
  dir: string,
  baseDir: string,
  config: AssistantWorkspaceConfig,
  depth: number,
): string[] {
  if (depth > config.index.maxDepth) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  const maxBytes = config.index.maxFileSizeKB * 1024;
  const extensions = new Set(config.index.includeExtensions);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    // Managed record history contains revoked/superseded versions and private
    // metadata. Only MemoryService's active projections are query content.
    const lowerPath = relPath.toLowerCase();
    if (lowerPath === 'memory/records.md' || lowerPath.startsWith('memory/.records-')
      || lowerPath === '.assistant' || lowerPath.startsWith('.assistant/')) continue;
    if (shouldIgnore(relPath, config)) continue;

    if (entry.isDirectory()) {
      files.push(...walkDir(fullPath, baseDir, config, depth + 1));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!extensions.has(ext)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > maxBytes) continue;
      } catch {
        continue;
      }

      files.push(relPath);
    }
  }

  return files;
}

export function indexWorkspace(dir: string, options?: { force?: boolean }): { fileCount: number; chunkCount: number } {
  const config = loadConfig(dir);
  const force = options?.force ?? false;

  const indexDir = path.join(dir, INDEX_DIR);
  if (!fs.existsSync(indexDir)) {
    fs.mkdirSync(indexDir, { recursive: true });
  }

  const files = walkDir(dir, dir, config, 0);
  const fileSet = new Set(files);

  // Load existing index for incremental update
  const existingManifest = force ? [] : loadManifest(dir);
  const existingChunks = force ? [] : loadChunks(dir);

  // Build lookup maps from existing index
  const existingByPath = new Map<string, ManifestEntry>();
  for (const entry of existingManifest) {
    existingByPath.set(entry.path, entry);
  }
  const existingChunksByNote = new Map<string, ChunkEntry[]>();
  for (const chunk of existingChunks) {
    const list = existingChunksByNote.get(chunk.noteId) || [];
    list.push(chunk);
    existingChunksByNote.set(chunk.noteId, list);
  }

  const manifests: ManifestEntry[] = [];
  const allChunks: ChunkEntry[] = [];
  let reindexed = 0;

  for (const filePath of files) {
    const existing = existingByPath.get(filePath);

    // Skip files that haven't changed (incremental)
    if (!force && existing) {
      try {
        const stat = fs.statSync(path.join(dir, filePath));
        if (stat.mtimeMs <= existing.mtime) {
          // Reuse existing manifest and chunks
          manifests.push(existing);
          const existingFileChunks = existingChunksByNote.get(existing.noteId) || [];
          allChunks.push(...existingFileChunks);
          continue;
        }
      } catch {
        // File stat failed, re-index it
      }
    }

    try {
      const { manifest, chunks } = indexFile(dir, filePath);
      manifests.push(manifest);
      allChunks.push(...chunks);
      reindexed++;
    } catch {
      // Skip files that fail to index
    }
  }

  // Only write if something changed (or force)
  if (force || reindexed > 0 || manifests.length !== existingManifest.length) {
    const manifestLines = manifests.map((m) => JSON.stringify(m)).join('\n');
    fs.writeFileSync(path.join(indexDir, 'manifest.jsonl'), manifestLines + '\n', 'utf-8');

    const chunkLines = allChunks.map((c) => JSON.stringify(c)).join('\n');
    fs.writeFileSync(path.join(indexDir, 'chunks.jsonl'), chunkLines + '\n', 'utf-8');
  }

  return { fileCount: manifests.length, chunkCount: allChunks.length };
}

export function loadManifest(dir: string): ManifestEntry[] {
  const manifestPath = path.join(dir, INDEX_DIR, 'manifest.jsonl');
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line) as ManifestEntry);
  } catch {
    return [];
  }
}

export function loadChunks(dir: string): ChunkEntry[] {
  const chunksPath = path.join(dir, INDEX_DIR, 'chunks.jsonl');
  try {
    const content = fs.readFileSync(chunksPath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line) as ChunkEntry);
  } catch {
    return [];
  }
}

export function getIndexStats(dir: string): {
  fileCount: number;
  chunkCount: number;
  lastIndexed: number;
  staleCount: number;
} {
  const manifest = loadManifest(dir);
  const chunks = loadChunks(dir);

  let lastIndexed = 0;
  let staleCount = 0;

  for (const entry of manifest) {
    if (entry.mtime > lastIndexed) {
      lastIndexed = entry.mtime;
    }
    try {
      const stat = fs.statSync(path.join(dir, entry.path));
      if (stat.mtimeMs > entry.mtime) {
        staleCount++;
      }
    } catch {
      staleCount++; // File deleted
    }
  }

  return {
    fileCount: manifest.length,
    chunkCount: chunks.length,
    lastIndexed,
    staleCount,
  };
}
