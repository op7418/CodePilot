import { NextRequest } from 'next/server';
import { getAllSessions, searchMessages } from '@/lib/db';
import { scanDirectory } from '@/lib/files';
import type { ChatSession, FileTreeNode } from '@/types';

const FILE_SCAN_DEPTH = 2;
const MAX_RESULTS_PER_TYPE = 10;

interface SearchResultSession {
  type: 'session';
  id: string;
  title: string;
  projectName: string;
  updatedAt: string;
}

interface SearchResultMessage {
  type: 'message';
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  role: 'user' | 'assistant';
  snippet: string;
  createdAt: string;
}

interface SearchResultFile {
  type: 'file';
  sessionId: string;
  sessionTitle: string;
  path: string;
  name: string;
}

export interface SearchResponse {
  sessions: SearchResultSession[];
  messages: SearchResultMessage[];
  files: SearchResultFile[];
}

function parseQuery(raw: string): { scope: 'all' | 'sessions' | 'messages' | 'files'; query: string } {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith('sessions:')) {
    return { scope: 'sessions', query: trimmed.slice(9).trim() };
  }
  if (trimmed.toLowerCase().startsWith('messages:')) {
    return { scope: 'messages', query: trimmed.slice(9).trim() };
  }
  if (trimmed.toLowerCase().startsWith('files:')) {
    return { scope: 'files', query: trimmed.slice(6).trim() };
  }
  return { scope: 'all', query: trimmed };
}

function filterSessions(sessions: ChatSession[], query: string): SearchResultSession[] {
  const q = query.toLowerCase();
  return sessions
    .filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.project_name.toLowerCase().includes(q),
    )
    .slice(0, MAX_RESULTS_PER_TYPE)
    .map((s) => ({
      type: 'session' as const,
      id: s.id,
      title: s.title,
      projectName: s.project_name,
      updatedAt: s.updated_at,
    }));
}

function collectFiles(
  tree: FileTreeNode[],
  sessionId: string,
  sessionTitle: string,
  query: string,
  results: SearchResultFile[],
): void {
  if (results.length >= MAX_RESULTS_PER_TYPE) return;
  const q = query.toLowerCase();
  for (const node of tree) {
    if (results.length >= MAX_RESULTS_PER_TYPE) break;
    if (node.type === 'file' && node.name.toLowerCase().includes(q)) {
      results.push({
        type: 'file',
        sessionId,
        sessionTitle,
        path: node.path,
        name: node.name,
      });
    }
    if (node.type === 'directory' && node.children) {
      collectFiles(node.children, sessionId, sessionTitle, query, results);
    }
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawQuery = searchParams.get('q') || '';
    const { scope, query } = parseQuery(rawQuery);

    if (!query) {
      return Response.json({ sessions: [], messages: [], files: [] });
    }

    const allSessions = getAllSessions();
    const result: SearchResponse = { sessions: [], messages: [], files: [] };

    if (scope === 'all' || scope === 'sessions') {
      result.sessions = filterSessions(allSessions, query);
    }

    if (scope === 'all' || scope === 'messages') {
      const messageRows = searchMessages(query, { limit: MAX_RESULTS_PER_TYPE });
      result.messages = messageRows.map((r) => ({
        type: 'message' as const,
        sessionId: r.sessionId,
        sessionTitle: r.sessionTitle,
        messageId: r.messageId,
        role: r.role,
        snippet: r.snippet,
        createdAt: r.createdAt,
      }));
    }

    if (scope === 'files') {
      for (const session of allSessions) {
        if (!session.working_directory) continue;
        const tree = await scanDirectory(session.working_directory, FILE_SCAN_DEPTH);
        collectFiles(tree, session.id, session.title, query, result.files);
        if (result.files.length >= MAX_RESULTS_PER_TYPE) break;
      }
    }

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[GET /api/search] Error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}
