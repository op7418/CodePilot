/** Memory scopes belong to CodePilot sessions, never to a Runtime. */
import fs from 'node:fs';
import path from 'node:path';
import { getSession, getSetting, setSetting } from './db';
import type { ChatSession } from '@/types';

const bindingKey = (sessionId: string) => `memory.assistant-binding.${sessionId}`;
export function canonicalMemoryWorkspace(value: string | undefined): string | undefined {
  if (!value || !path.isAbsolute(value)) return undefined;
  try {
    const real = fs.realpathSync.native(value);
    return fs.statSync(real).isDirectory() ? real : undefined;
  } catch { return undefined; }
}

/** Only explicit assistant entrypoints call this; cwd equality is not intent. */
export function bindAssistantMemory(sessionId: string): void {
  const session = getSession(sessionId);
  const configured = canonicalMemoryWorkspace(getSetting('assistant_workspace_path'));
  if (!session || session.source === 'task' || !configured || canonicalMemoryWorkspace(session.working_directory) !== configured) {
    throw new Error('MEMORY_BINDING_SCOPE_MISMATCH');
  }
  setSetting(bindingKey(sessionId), JSON.stringify({ version: 1, workspace: configured }));
}

export function getAssistantMemoryWorkspace(session: Pick<ChatSession, 'id' | 'working_directory' | 'runtime_binding_source' | 'source'>): string | undefined {
  if (session.source === 'task') return undefined;
  const configured = canonicalMemoryWorkspace(getSetting('assistant_workspace_path'));
  if (!configured || canonicalMemoryWorkspace(session.working_directory) !== configured) return undefined;
  const saved = getSetting(bindingKey(session.id));
  if (saved) {
    try {
      const binding = JSON.parse(saved);
      return binding.version === 1 && canonicalMemoryWorkspace(binding.workspace) === configured ? configured : undefined;
    } catch { return undefined; }
  }
  // Durable explicit origin is sufficient; reads never backfill settings.
  if (session.runtime_binding_source === 'assistant_session_create') return configured;
  return undefined;
}

/** Built-in memory is restricted to bound assistant sessions across all Runtimes. */
export function getSessionMemoryWorkspace(sessionId: string, requestedWorkspace?: string): string | undefined {
  const session = getSession(sessionId);
  if (!session) return undefined;
  const workspace = getAssistantMemoryWorkspace(session);
  if (!workspace) return undefined;
  return requestedWorkspace === undefined || canonicalMemoryWorkspace(requestedWorkspace) === workspace
    ? workspace : undefined;
}

/** The host re-checks mutable session scope and Plan mode at tool execution. */
export function canWriteSessionMemory(sessionId: string | undefined, workspacePath: string): boolean {
  if (!sessionId) return false;
  const session = getSession(sessionId);
  return !!session && session.mode !== 'plan' && !!getSessionMemoryWorkspace(sessionId, workspacePath);
}
