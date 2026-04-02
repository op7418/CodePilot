import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getSetting, setSetting } from '@/lib/db';
import { validateWorkspace, initializeWorkspace, loadState, saveState, shouldRunHeartbeat } from '@/lib/assistant-workspace';

export async function GET() {
  try {
    const workspacePath = getSetting('assistant_workspace_path');
    if (!workspacePath) {
      return NextResponse.json({ path: null, valid: false, reason: 'no_path_configured', files: {}, state: null });
    }

    // Check if the path is actually valid before proceeding
    let pathExists = false;
    let isDirectory = false;
    let readable = false;
    try {
      const stat = fs.statSync(workspacePath);
      pathExists = true;
      isDirectory = stat.isDirectory();
    } catch { /* path doesn't exist */ }

    let writable = false;
    if (pathExists && isDirectory) {
      try {
        fs.accessSync(workspacePath, fs.constants.R_OK);
        readable = true;
      } catch { /* not readable */ }
      try {
        fs.accessSync(workspacePath, fs.constants.W_OK);
        writable = true;
      } catch { /* not writable */ }
    }

    if (!pathExists) {
      return NextResponse.json({ path: workspacePath, valid: false, reason: 'path_not_found', files: {}, state: null });
    }
    if (!isDirectory) {
      return NextResponse.json({ path: workspacePath, valid: false, reason: 'not_a_directory', files: {}, state: null });
    }
    if (!readable) {
      return NextResponse.json({ path: workspacePath, valid: false, reason: 'not_readable', files: {}, state: null });
    }
    if (!writable) {
      return NextResponse.json({ path: workspacePath, valid: false, reason: 'not_writable', files: {}, state: null });
    }

    const validation = validateWorkspace(workspacePath);
    const state = loadState(workspacePath);

    // Build file status with preview
    const fileStatus: Record<string, { exists: boolean; chars: number; preview: string }> = {};
    for (const [key, info] of Object.entries(validation.files)) {
      let preview = '';
      if (info.exists && info.path) {
        try {
          const content = fs.readFileSync(info.path, 'utf-8');
          preview = content.split('\n').slice(0, 3).join('\n');
        } catch { /* ignore */ }
      }
      fileStatus[key] = {
        exists: info.exists,
        chars: info.size,
        preview,
      };
    }

    // Load taxonomy for UI
    let taxonomy: Array<{ id: string; label: string; role: string; confidence: number; source: string; paths: string[] }> = [];
    try {
      const { loadTaxonomy } = await import('@/lib/workspace-taxonomy');
      const taxData = loadTaxonomy(workspacePath);
      taxonomy = taxData.categories.map(c => ({
        id: c.id,
        label: c.label,
        role: c.role,
        confidence: c.confidence,
        source: c.source,
        paths: c.paths,
      }));
    } catch {
      // taxonomy module not available
    }

    return NextResponse.json({
      path: workspacePath,
      valid: true,
      exists: validation.exists,
      files: fileStatus,
      state,
      taxonomy,
      // Server-computed heartbeat check — single source of truth for all consumers.
      // Requires buddy to exist (heartbeat defers to buddy-welcome when no buddy).
      needsHeartbeat: !!state.buddy && shouldRunHeartbeat(state),
    });
  } catch (e) {
    console.error('[settings/workspace] GET failed:', e);
    return NextResponse.json({ error: 'Failed to load workspace info' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { path: workspacePath, initialize, resetOnboarding } = body as { path: string; initialize?: boolean; resetOnboarding?: boolean };

    if (!workspacePath || typeof workspacePath !== 'string') {
      return NextResponse.json({ error: 'Invalid workspace path' }, { status: 400 });
    }

    // Validate the path before saving
    let pathExists = false;
    let isDirectory = false;
    try {
      const stat = fs.statSync(workspacePath);
      pathExists = true;
      isDirectory = stat.isDirectory();
    } catch { /* path doesn't exist */ }

    if (!pathExists) {
      // Only create directory tree when user explicitly requests initialization
      if (!initialize) {
        return NextResponse.json(
          { error: 'Path does not exist. Set initialize=true to create it.', code: 'path_not_found' },
          { status: 400 }
        );
      }
      // Create the directory for initialization
      try {
        fs.mkdirSync(workspacePath, { recursive: true });
      } catch (mkdirErr) {
        return NextResponse.json(
          { error: `Failed to create directory: ${mkdirErr instanceof Error ? mkdirErr.message : 'unknown error'}`, code: 'mkdir_failed' },
          { status: 400 }
        );
      }
    } else if (!isDirectory) {
      return NextResponse.json(
        { error: 'Path exists but is not a directory.', code: 'not_a_directory' },
        { status: 400 }
      );
    }

    // Check read/write permissions (on existing or newly created directory)
    try {
      fs.accessSync(workspacePath, fs.constants.R_OK | fs.constants.W_OK);
    } catch {
      return NextResponse.json(
        { error: 'Directory is not readable/writable.', code: 'permission_denied' },
        { status: 400 }
      );
    }

    // Perform initialization/reset BEFORE saving the setting (atomic: if init fails, setting is unchanged)
    let createdFiles: string[] = [];
    if (initialize) {
      try {
        createdFiles = initializeWorkspace(workspacePath);
      } catch (initErr) {
        return NextResponse.json(
          { error: `Failed to initialize workspace: ${initErr instanceof Error ? initErr.message : 'unknown error'}`, code: 'init_failed' },
          { status: 500 }
        );
      }
    }

    if (resetOnboarding) {
      try {
        const state = loadState(workspacePath);
        saveState(workspacePath, { ...state, onboardingComplete: false });
      } catch (resetErr) {
        return NextResponse.json(
          { error: `Failed to reset onboarding: ${resetErr instanceof Error ? resetErr.message : 'unknown error'}`, code: 'reset_failed' },
          { status: 500 }
        );
      }
    }

    // All side-effects succeeded — now commit the setting
    setSetting('assistant_workspace_path', workspacePath);

    return NextResponse.json({ success: true, createdFiles });
  } catch (e) {
    console.error('[settings/workspace] PUT failed:', e);
    return NextResponse.json({ error: 'Failed to save workspace settings' }, { status: 500 });
  }
}

/** PATCH — update individual state fields (e.g. heartbeatEnabled toggle) */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const workspacePath = getSetting('assistant_workspace_path');
    if (!workspacePath) {
      return NextResponse.json({ error: 'No workspace configured' }, { status: 400 });
    }

    const state = loadState(workspacePath);

    // Apply supported state patches
    if ('heartbeatEnabled' in body && typeof body.heartbeatEnabled === 'boolean') {
      state.heartbeatEnabled = body.heartbeatEnabled;
    }
    // Reset buddy so user can hatch a new one
    if (body.resetBuddy === true) {
      state.buddy = undefined;

      // Also remove the ## Buddy Trait section from soul.md so re-hatch gets a fresh one
      try {
        const soulVariants = ['soul.md', 'Soul.md', 'SOUL.md'];
        for (const variant of soulVariants) {
          const soulPath = path.join(workspacePath, variant);
          if (fs.existsSync(soulPath)) {
            const content = fs.readFileSync(soulPath, 'utf-8');
            // Remove ## Buddy Trait section (everything from the heading to the next ## or end of file)
            const cleaned = content.replace(/\n*## Buddy Trait[\s\S]*?(?=\n## |\n*$)/, '');
            if (cleaned !== content) {
              fs.writeFileSync(soulPath, cleaned.trimEnd() + '\n', 'utf-8');
            }
            break;
          }
        }
      } catch { /* best effort — soul.md cleanup is non-critical */ }
    }
    // Reset heartbeat date to force re-trigger on next session open
    if (body.resetHeartbeat === true) {
      state.lastHeartbeatDate = null;
      state.hookTriggeredSessionId = undefined;
      state.hookTriggeredAt = undefined;
    }

    saveState(workspacePath, state);
    return NextResponse.json({ success: true, state });
  } catch (e) {
    console.error('[settings/workspace] PATCH failed:', e);
    return NextResponse.json({ error: 'Failed to update workspace state' }, { status: 500 });
  }
}
