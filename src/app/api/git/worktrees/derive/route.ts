import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import * as gitService from '@/lib/git/service';
import { getSession, createSession, type CreateSessionExecutionBinding } from '@/lib/db';
import { normalizePermissionProfile, type SessionPermissionProfile } from '@/lib/permission/profile';
import { isRuntimeId } from '@/lib/runtime/runtime-id';

export async function POST(req: NextRequest) {
  try {
    const { cwd, branch, sourceSessionId } = await req.json();
    if (!cwd || !branch) {
      return NextResponse.json({ error: 'cwd and branch are required' }, { status: 400 });
    }

    // Compute worktree path: <repoParent>/<repoName>-worktrees/<sanitizedBranch>
    const repoRoot = await gitService.getRepoRoot(cwd);
    const repoParent = path.dirname(repoRoot);
    const repoName = path.basename(repoRoot);
    const sanitizedBranch = gitService.sanitizeBranchForPath(branch);
    const worktreePath = path.join(repoParent, `${repoName}-worktrees`, sanitizedBranch);

    // Create the worktree
    const actualPath = await gitService.deriveWorktree(cwd, branch, worktreePath);

    // Create a new session for the worktree, inheriting settings from the source session
    let model = '';
    let systemPrompt = '';
    let mode = 'code';
    let providerId = '';
    let permissionProfile: SessionPermissionProfile = 'default';
    let executionBinding: CreateSessionExecutionBinding | undefined;

    if (sourceSessionId) {
      const source = getSession(sourceSessionId);
      if (source) {
        model = source.model || '';
        systemPrompt = source.system_prompt || '';
        mode = source.mode || 'code';
        providerId = source.provider_id || '';
        permissionProfile = normalizePermissionProfile(source.permission_profile);
        if (isRuntimeId(source.runtime_pin)) {
          executionBinding = source.runtime_binding_state === 'bound' && model && providerId
            ? { runtimeId: source.runtime_pin, state: 'bound', source: 'inherited_owner' }
            : { runtimeId: source.runtime_pin, state: 'unbound' };
        }
      }
    }

    const newSession = createSession(
      `${branch} (worktree)`,
      model,
      systemPrompt,
      actualPath,
      mode,
      providerId,
      permissionProfile,
      undefined, // source
      // The branch name is the point of this session — a fallback from the
      // first message would bury which worktree it belongs to.
      'system',
      executionBinding,
    );

    return NextResponse.json({
      worktreePath: actualPath,
      branch,
      sessionId: newSession.id,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to derive worktree' },
      { status: 500 }
    );
  }
}
