/**
 * codepilot-memory MCP — in-process MCP server for memory search/retrieval.
 *
 * Provides 3 tools:
 * - codepilot_memory_search: Search with temporal decay + optional tag/type filters
 * - codepilot_memory_get: Read a specific file (path-safe, truncated)
 * - codepilot_memory_recent: Get recent daily memories without search (for context)
 *
 * Obsidian-aware: parses YAML frontmatter for tags, supports [[wikilinks]].
 * Always-on in assistant mode (not keyword-gated).
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import type { SearchResult } from '@/types';

const HALF_LIFE_DAYS = 30;
const LAMBDA = Math.log(2) / HALF_LIFE_DAYS;
const MAX_SNIPPET_CHARS = 3000;
const RECENT_MEMORY_DAYS = 3;
const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 25000;

export const MEMORY_SEARCH_SYSTEM_PROMPT = `## 记忆检索

**每次对话的第一轮，必须先调用 codepilot_memory_recent 回顾最近记忆。**

在回答任何关于过去工作、决策、日期、人物、偏好或待办的问题前：
1. 用 codepilot_memory_search 搜索相关记忆（支持按 tags 过滤）
2. 如果搜到相关结果，用 codepilot_memory_get 获取详细内容
3. 如果搜索后仍不确定，告知用户你已检查但未找到相关记录

工作区使用 Obsidian 风格组织：
- 文件间用 [[文件名]] 双向链接
- 用 #标签 分类，搜索时可用 tags 参数过滤
- 文件顶部有 YAML frontmatter 元数据

不要凭记忆猜测过去发生的事，始终先搜索再回答。`;

export function createMemorySearchMcpServer(workspacePath: string) {
  return createSdkMcpServer({
    name: 'codepilot-memory',
    version: '1.0.0',
    tools: [
      tool(
        'codepilot_memory_search',
        'Search assistant workspace memory files with keyword matching and temporal decay. Supports filtering by tags (Obsidian-style #tags from YAML frontmatter) and file type.',
        {
          query: z.string().describe('Search keywords'),
          tags: z.array(z.string()).optional().describe('Filter by YAML frontmatter tags (e.g. ["project", "design"])'),
          file_type: z.enum(['all', 'daily', 'longterm', 'notes']).optional().default('all')
            .describe('Filter by type: "daily" = memory/daily/*.md, "longterm" = memory.md, "notes" = other workspace files'),
          limit: z.number().optional().default(5).describe('Max results'),
        },
        async ({ query, tags, file_type, limit }) => {
          try {
            const { searchWorkspace } = await import('./workspace-retrieval');
            let results = searchWorkspace(workspacePath, query, { limit: (limit || 5) * 3 });

            // Filter by file type (case-insensitive for memory.md variants)
            if (file_type && file_type !== 'all') {
              const isMemoryFile = (p: string) => /^memory\.md$/i.test(p);
              results = results.filter(r => {
                if (file_type === 'daily') return r.path.startsWith('memory/daily/');
                if (file_type === 'longterm') return isMemoryFile(r.path);
                if (file_type === 'notes') return !r.path.startsWith('memory/') && !isMemoryFile(r.path);
                return true;
              });
            }

            // Filter by tags (from manifest entry)
            if (tags && tags.length > 0) {
              const tagsLower = tags.map(t => t.toLowerCase().replace(/^#/, ''));
              try {
                const { loadManifest } = await import('./workspace-indexer');
                const manifest = loadManifest(workspacePath);
                results = results.filter(r => {
                  const entry = manifest.find((e: { path: string; tags?: string[] }) => e.path === r.path);
                  if (!entry?.tags?.length) return false;
                  const entryTagsLower = entry.tags.map((t: string) => t.toLowerCase());
                  return tagsLower.some(t => entryTagsLower.includes(t));
                });
              } catch {
                // if manifest unavailable, skip tag filtering
              }
            }

            // Apply temporal decay and take limit
            const decayed = applyTemporalDecay(results).slice(0, limit || 5);

            if (decayed.length === 0) {
              return { content: [{ type: 'text' as const, text: 'No matching memories found.' }] };
            }

            // Optional AI reranking: use small model to select most relevant results
            const reranked = await rerankWithAI(query, decayed, workspacePath);
            const finalResults = reranked || decayed;

            const formattedParts = await Promise.all(finalResults.map(async (r, i) => {
              const tagInfo = await getFileTags(workspacePath, r.path);
              const tagStr = tagInfo.length > 0 ? ` [${tagInfo.map(t => '#' + t).join(' ')}]` : '';
              return `${i + 1}. [${r.path}]${tagStr} (score: ${r.score.toFixed(2)})\n   ${r.heading || ''}\n   ${(r.snippet || '').slice(0, 200)}`;
            }));
            const formatted = formattedParts.join('\n\n');

            return { content: [{ type: 'text' as const, text: formatted }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Search failed: ${err instanceof Error ? err.message : 'unknown error'}` }] };
          }
        },
      ),

      tool(
        'codepilot_memory_get',
        'Read a specific file from the assistant workspace. Use after memory_search finds relevant files. Paths must be relative to the workspace root. Also extracts Obsidian [[wikilinks]] as related files.',
        {
          file_path: z.string().describe('File path relative to workspace root (e.g. "memory.md", "memory/daily/2026-03-30.md")'),
          line_start: z.number().optional().describe('Start line number (1-based)'),
          line_end: z.number().optional().describe('End line number (inclusive)'),
        },
        async ({ file_path, line_start, line_end }) => {
          const resolvedWorkspace = path.resolve(workspacePath);
          const resolved = path.resolve(workspacePath, file_path);
          // Lexical check first: reject obvious ../traversal
          const rel = path.relative(resolvedWorkspace, resolved);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            return { content: [{ type: 'text' as const, text: 'Access denied: path is outside workspace.' }] };
          }

          try {
            if (!fs.existsSync(resolved)) {
              return { content: [{ type: 'text' as const, text: `File not found: ${file_path}` }] };
            }

            // Resolve symlinks and verify the real path is still inside the workspace.
            // This prevents symlink escape (e.g., workspace/link -> /etc/passwd).
            const realPath = fs.realpathSync(resolved);
            const realWorkspace = fs.realpathSync(resolvedWorkspace);
            const realRel = path.relative(realWorkspace, realPath);
            if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
              return { content: [{ type: 'text' as const, text: 'Access denied: path resolves outside workspace (symlink).' }] };
            }

            let content = fs.readFileSync(resolved, 'utf-8');

            // Cap memory.md at 200 lines / 25KB
            if (/^memory\.md$/i.test(path.basename(file_path))) {
              content = capMemoryContent(content);
            }

            // Extract [[wikilinks]] for related file discovery
            const wikilinks = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
              .map(m => m[1].trim())
              .filter((v, i, a) => a.indexOf(v) === i);

            if (line_start || line_end) {
              const lines = content.split('\n');
              const start = Math.max(0, (line_start || 1) - 1);
              const end = Math.min(lines.length, line_end || lines.length);
              content = lines.slice(start, end).join('\n');
            }

            if (content.length > MAX_SNIPPET_CHARS) {
              content = content.slice(0, MAX_SNIPPET_CHARS) + '\n\n[...truncated...]';
            }

            let result = content || '(empty file)';
            if (wikilinks.length > 0) {
              result += `\n\n---\nLinked files: ${wikilinks.map(l => `[[${l}]]`).join(', ')}`;
            }

            return { content: [{ type: 'text' as const, text: result }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Read failed: ${err instanceof Error ? err.message : 'unknown error'}` }] };
          }
        },
      ),

      tool(
        'codepilot_memory_recent',
        'Get recent daily memories (last 3 days) and long-term memory summary. Call this at the START of each conversation to review recent context before engaging.',
        {},
        async () => {
          try {
            const parts: string[] = [];

            // Long-term memory summary (first 500 chars)
            // Support all case variants: memory.md, Memory.md, MEMORY.md
            const memoryVariants = ['memory.md', 'Memory.md', 'MEMORY.md'];
            for (const variant of memoryVariants) {
              const memoryPath = path.join(workspacePath, variant);
              if (fs.existsSync(memoryPath)) {
                const memContent = capMemoryContent(fs.readFileSync(memoryPath, 'utf-8').trim());
                if (memContent) {
                  const summary = memContent.length > 500
                    ? memContent.slice(0, 500) + '...'
                    : memContent;
                  parts.push(`## Long-term Memory\n${summary}`);
                }
                break; // Use first found variant
              }
            }

            // Recent daily memories
            const dailyDir = path.join(workspacePath, 'memory', 'daily');
            if (fs.existsSync(dailyDir)) {
              const files = fs.readdirSync(dailyDir)
                .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
                .sort()
                .reverse()
                .slice(0, RECENT_MEMORY_DAYS);

              for (const file of files) {
                const content = fs.readFileSync(path.join(dailyDir, file), 'utf-8').trim();
                if (content) {
                  const date = file.replace('.md', '');
                  const truncated = content.length > 800
                    ? content.slice(0, 800) + '...'
                    : content;
                  parts.push(`## ${date}\n${truncated}`);
                }
              }
            }

            if (parts.length === 0) {
              return { content: [{ type: 'text' as const, text: 'No recent memories found.' }] };
            }

            return { content: [{ type: 'text' as const, text: parts.join('\n\n') }] };
          } catch (err) {
            return { content: [{ type: 'text' as const, text: `Failed to load recent memories: ${err instanceof Error ? err.message : 'unknown error'}` }] };
          }
        },
      ),
    ],
  });
}

/**
 * Cap memory content at MAX_MEMORY_LINES and MAX_MEMORY_BYTES.
 */
function capMemoryContent(content: string): string {
  let result = content;
  const lines = result.split('\n');
  if (lines.length > MAX_MEMORY_LINES) {
    result = lines.slice(0, MAX_MEMORY_LINES).join('\n') + '\n\n[...truncated at 200 lines]';
  }
  if (Buffer.byteLength(result) > MAX_MEMORY_BYTES) {
    // Truncate at last newline before byte limit
    while (Buffer.byteLength(result) > MAX_MEMORY_BYTES) {
      const lastNewline = result.lastIndexOf('\n');
      if (lastNewline <= 0) break;
      result = result.slice(0, lastNewline);
    }
    result += '\n\n[...truncated at 25KB]';
  }
  return result;
}

/**
 * Get tags for a file from the workspace index manifest.
 */
async function getFileTags(workspacePath: string, filePath: string): Promise<string[]> {
  try {
    const { loadManifest } = await import('./workspace-indexer');
    const manifest = loadManifest(workspacePath);
    const entry = manifest.find((e: { path: string; tags?: string[] }) => e.path === filePath);
    return entry?.tags || [];
  } catch {
    return [];
  }
}

/**
 * Apply temporal decay to search results.
 * Dated files (memory/daily/YYYY-MM-DD.md) get exponential decay.
 * Evergreen files (MEMORY.md, README.ai.md, undated files) are not decayed.
 */
function applyTemporalDecay(results: SearchResult[]): SearchResult[] {
  const now = Date.now();
  return results.map(r => {
    const dateMatch = r.path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
    if (!dateMatch) return r; // Evergreen file — no decay

    const fileDate = new Date(dateMatch[1]).getTime();
    if (isNaN(fileDate)) return r;

    const ageInDays = (now - fileDate) / (24 * 60 * 60 * 1000);
    if (ageInDays <= 0) return r; // Future or today — no decay

    const decayFactor = Math.exp(-LAMBDA * ageInDays);
    return { ...r, score: r.score * decayFactor };
  }).sort((a, b) => b.score - a.score);
}

/**
 * AI-driven reranking of search results using a small model.
 * Falls back to original results if reranking fails or takes too long (5s timeout).
 */
async function rerankWithAI(
  query: string,
  results: SearchResult[],
  _workspacePath: string,
): Promise<SearchResult[] | null> {
  if (results.length <= 2) return null; // Not worth reranking few results

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const { generateTextFromProvider } = await import('./text-generator');
    const { resolveProvider } = await import('./provider-resolver');
    const resolved = resolveProvider({ useCase: 'small' });

    if (!resolved.hasCredentials) return null;

    const manifest = results.map((r, i) =>
      `${i}: [${r.path}] ${r.heading || ''} — ${(r.snippet || '').slice(0, 100)}`
    ).join('\n');

    const response = await generateTextFromProvider({
      providerId: resolved.provider?.id || '',
      model: resolved.upstreamModel || resolved.model || 'haiku',
      system: 'You select the most relevant search results. Return ONLY a JSON array of indices (e.g. [2, 0, 4]).',
      prompt: `Query: "${query}"\n\nResults:\n${manifest}\n\nSelect the most relevant results, ordered by relevance. Return JSON array of indices.`,
      maxTokens: 50,
      abortSignal: controller.signal,
    });

    // Parse the JSON array
    const match = response.match(/\[[\d,\s]+\]/);
    if (!match) return null;

    const indices: number[] = JSON.parse(match[0]);
    const reranked = indices
      .filter(i => i >= 0 && i < results.length)
      .map(i => results[i])
      .filter(Boolean);

    return reranked.length > 0 ? reranked : null;
  } catch {
    return null; // Fallback to original order
  } finally {
    clearTimeout(timeout);
  }
}
