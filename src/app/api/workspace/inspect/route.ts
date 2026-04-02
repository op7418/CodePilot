import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

type WorkspaceStatus = 'empty' | 'normal_directory' | 'existing_workspace' | 'partial_workspace' | 'invalid';

const ASSISTANT_FILES = ['soul.md', 'Soul.md', 'SOUL.md', 'user.md', 'User.md', 'USER.md', 'PROFILE.md', 'memory.md', 'Memory.md', 'MEMORY.md', 'claude.md', 'Claude.md', 'CLAUDE.md', 'AGENTS.md'];
const CORE_FILE_KEYS = ['soul', 'user', 'memory', 'claude'] as const;

function countExistingCoreFiles(dir: string): number {
  const found = new Set<string>();
  const keyMap: Record<string, string> = {
    'soul.md': 'soul', 'Soul.md': 'soul', 'SOUL.md': 'soul',
    'user.md': 'user', 'User.md': 'user', 'USER.md': 'user', 'PROFILE.md': 'user',
    'memory.md': 'memory', 'Memory.md': 'memory', 'MEMORY.md': 'memory',
    'claude.md': 'claude', 'Claude.md': 'claude', 'CLAUDE.md': 'claude', 'AGENTS.md': 'claude',
  };
  for (const filename of ASSISTANT_FILES) {
    if (fs.existsSync(path.join(dir, filename))) {
      const key = keyMap[filename];
      if (key) found.add(key);
    }
  }
  return found.size;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const inspectPath = searchParams.get('path');

    if (!inspectPath || typeof inspectPath !== 'string') {
      return NextResponse.json({ error: 'Missing required query parameter: path' }, { status: 400 });
    }

    // Check existence
    let exists = false;
    let isDirectory = false;
    try {
      const stat = fs.statSync(inspectPath);
      exists = true;
      isDirectory = stat.isDirectory();
    } catch {
      // Path doesn't exist
    }

    if (!exists || !isDirectory) {
      return NextResponse.json({
        exists,
        isDirectory,
        readable: false,
        writable: false,
        hasAssistantData: false,
        workspaceStatus: 'invalid' as WorkspaceStatus,
      });
    }

    // Check permissions
    let readable = false;
    let writable = false;
    try {
      fs.accessSync(inspectPath, fs.constants.R_OK);
      readable = true;
    } catch { /* not readable */ }
    try {
      fs.accessSync(inspectPath, fs.constants.W_OK);
      writable = true;
    } catch { /* not writable */ }

    if (!readable) {
      return NextResponse.json({
        exists,
        isDirectory,
        readable,
        writable,
        hasAssistantData: false,
        workspaceStatus: 'invalid' as WorkspaceStatus,
      });
    }

    // Check for .assistant/state.json
    const statePath = path.join(inspectPath, '.assistant', 'state.json');
    const hasAssistantData = fs.existsSync(statePath);

    // Determine workspace status
    let workspaceStatus: WorkspaceStatus;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(inspectPath, { withFileTypes: true });
    } catch {
      entries = [];
    }

    // Filter out hidden entries for "emptiness" check
    const visibleEntries = entries.filter(e => !e.name.startsWith('.'));
    const hasAssistantDir = fs.existsSync(path.join(inspectPath, '.assistant'));
    const fileCount = countExistingCoreFiles(inspectPath);

    if (hasAssistantData) {
      workspaceStatus = 'existing_workspace';
    } else if (hasAssistantDir || fileCount > 0) {
      // Has some assistant-related files but no state.json
      workspaceStatus = 'partial_workspace';
    } else if (visibleEntries.length === 0) {
      workspaceStatus = 'empty';
    } else {
      workspaceStatus = 'normal_directory';
    }

    // Build response
    const result: Record<string, unknown> = {
      exists,
      isDirectory,
      readable,
      writable,
      hasAssistantData,
      workspaceStatus,
    };

    // If existing_workspace, return summary
    if (workspaceStatus === 'existing_workspace') {
      try {
        const raw = fs.readFileSync(statePath, 'utf-8');
        const state = JSON.parse(raw) as { onboardingComplete?: boolean; lastHeartbeatDate?: string | null; lastCheckInDate?: string | null };
        result.summary = {
          onboardingComplete: state.onboardingComplete ?? false,
          lastHeartbeatDate: state.lastHeartbeatDate ?? state.lastCheckInDate ?? null,
          fileCount,
        };
      } catch {
        result.summary = {
          onboardingComplete: false,
          lastHeartbeatDate: null,
          fileCount,
        };
      }
    }

    return NextResponse.json(result);
  } catch (e) {
    console.error('[workspace/inspect] GET failed:', e);
    return NextResponse.json({ error: 'Failed to inspect workspace path' }, { status: 500 });
  }
}
