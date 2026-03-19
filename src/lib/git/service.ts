import { execFile } from 'child_process';
import path from 'path';
import type { GitStatus, GitChangedFile, GitBranch, GitLogEntry, GitCommitDetail, GitWorktree, GitRemote } from '@/types';

function runGit(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<string> {
  if (!path.isAbsolute(opts.cwd)) {
    return Promise.reject(new Error(`cwd must be absolute: ${opts.cwd}`));
  }
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 10000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--is-inside-work-tree'], { cwd, timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function getRepoRoot(cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 });
  return result.trim();
}

export async function getStatus(cwd: string): Promise<GitStatus> {
  const isRepo = await isGitRepo(cwd);
  if (!isRepo) {
    return {
      isRepo: false,
      repoRoot: '',
      branch: '',
      upstream: '',
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: [],
    };
  }

  const repoRoot = await getRepoRoot(cwd);

  // Get branch info
  let branch = '';
  try {
    branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5000 })).trim();
  } catch {
    branch = '';
  }

  // Get upstream
  let upstream = '';
  let ahead = 0;
  let behind = 0;
  try {
    upstream = (await runGit(['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd, timeoutMs: 5000 })).trim();
    const countOutput = (await runGit(['rev-list', '--left-right', '--count', `${upstream}...HEAD`], { cwd, timeoutMs: 5000 })).trim();
    const parts = countOutput.split(/\s+/);
    behind = parseInt(parts[0] || '0', 10);
    ahead = parseInt(parts[1] || '0', 10);
  } catch {
    // no upstream
  }

  // Get changed files using porcelain v2
  const changedFiles: GitChangedFile[] = [];
  try {
    const statusOutput = await runGit(['status', '--porcelain=v2', '--untracked-files=normal'], { cwd });
    for (const line of statusOutput.split('\n')) {
      if (!line) continue;

      if (line.startsWith('1 ') || line.startsWith('2 ')) {
        // Changed entry
        const xy = line.substring(2, 4);
        const pathPart = line.startsWith('2 ')
          ? line.split('\t')[1] || line.split(' ').pop() || ''
          : line.substring(line.lastIndexOf(' ') + 1);

        const indexStatus = xy[0];
        const worktreeStatus = xy[1];

        if (indexStatus !== '.' && indexStatus !== '?') {
          changedFiles.push({
            path: pathPart.trim(),
            status: parseStatusChar(indexStatus),
            staged: true,
          });
        }
        if (worktreeStatus !== '.' && worktreeStatus !== '?') {
          changedFiles.push({
            path: pathPart.trim(),
            status: parseStatusChar(worktreeStatus),
            staged: false,
          });
        }
      } else if (line.startsWith('? ')) {
        // Untracked
        const filePath = line.substring(2);
        changedFiles.push({
          path: filePath.trim(),
          status: 'untracked',
          staged: false,
        });
      }
    }
  } catch {
    // status failed
  }

  return {
    isRepo: true,
    repoRoot,
    branch,
    upstream,
    ahead,
    behind,
    dirty: changedFiles.length > 0,
    changedFiles,
  };
}

function parseStatusChar(c: string): GitChangedFile['status'] {
  switch (c) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    default: return 'modified';
  }
}

export async function getBranches(cwd: string): Promise<GitBranch[]> {
  const output = await runGit(
    ['branch', '-a', '--format=%(refname:short)\t%(upstream:short)\t%(worktreepath)'],
    { cwd }
  );

  // Get the list of local-only branch names so we can distinguish them from remotes
  let localNames: Set<string>;
  try {
    const localOutput = await runGit(['branch', '--format=%(refname:short)'], { cwd });
    localNames = new Set(localOutput.split('\n').map(l => l.trim()).filter(Boolean));
  } catch {
    localNames = new Set();
  }

  const branches: GitBranch[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [name, upstream, worktreePath] = line.split('\t');
    const trimmedName = name.trim();
    // A branch is remote only if it starts with "origin/" (or other remote prefix)
    // AND is NOT in the local branch list
    const isRemote = !localNames.has(trimmedName) && (trimmedName.startsWith('origin/') || trimmedName.includes('/'));
    branches.push({
      name: trimmedName,
      isRemote,
      upstream: upstream?.trim() || '',
      worktreePath: worktreePath?.trim() || '',
    });
  }

  return branches;
}

export async function checkout(cwd: string, branch: string): Promise<void> {
  // Validate branch name — reject suspicious characters
  if (!/^[\w.\-/]+$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  // Check for dirty worktree
  const status = await getStatus(cwd);
  if (status.dirty) {
    throw new Error('Cannot checkout: dirty working tree. Commit or stash changes first.');
  }

  await runGit(['checkout', branch], { cwd, timeoutMs: 15000 });
}

export async function getLog(cwd: string, limit = 50): Promise<GitLogEntry[]> {
  const SEP = '|||';
  const format = `%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s`;
  const output = await runGit(
    ['log', `--pretty=format:${format}`, `-${limit}`],
    { cwd }
  );

  const entries: GitLogEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(SEP);
    if (parts.length < 5) continue;
    entries.push({
      sha: parts[0],
      authorName: parts[1],
      authorEmail: parts[2],
      timestamp: parts[3],
      message: parts[4],
    });
  }

  return entries;
}

export async function commit(cwd: string, message: string): Promise<string> {
  // Stage all changes
  await runGit(['add', '-A'], { cwd, timeoutMs: 15000 });

  // Check if there are staged changes.
  // `git diff --cached --quiet` exits 0 = clean, exits 1 = has staged changes.
  // runGit rejects on any non-zero exit. We treat rejection as "has changes".
  // If there's a real error (corrupt index, etc.), the subsequent git commit
  // will fail with a proper message, so it's safe to proceed optimistically.
  try {
    await runGit(['diff', '--cached', '--quiet'], { cwd, timeoutMs: 10000 });
    // Exit 0 = nothing staged
    throw new Error('Nothing to commit');
  } catch (err) {
    if (err instanceof Error && err.message === 'Nothing to commit') {
      throw err;
    }
    // Exit 1 (has changes) or real error — proceed to commit either way
  }

  const commitMsg = message.trim() || 'Update';
  const output = await runGit(['commit', '-m', commitMsg], { cwd, timeoutMs: 30000 });

  // Extract SHA from output
  const match = output.match(/\[[\w/.-]+ ([0-9a-f]+)\]/);
  return match?.[1] || '';
}

export async function push(cwd: string): Promise<void> {
  // Try regular push first
  try {
    await runGit(['push'], { cwd, timeoutMs: 30000 });
  } catch (err) {
    // If no upstream, set it
    if (err instanceof Error && (err.message.includes('no upstream') || err.message.includes('has no upstream'))) {
      const branch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeoutMs: 5000 })).trim();
      await runGit(['push', '-u', 'origin', branch], { cwd, timeoutMs: 30000 });
    } else {
      throw err;
    }
  }
}

export async function getCommitDetail(cwd: string, sha: string): Promise<GitCommitDetail> {
  // Validate SHA
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`Invalid SHA: ${sha}`);
  }

  const SEP = '|||';
  const format = `%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s`;
  const output = await runGit(['show', `--pretty=format:${format}`, '--stat', sha], { cwd });

  const lines = output.split('\n');
  const headerLine = lines[0];
  const parts = headerLine.split(SEP);

  // Stats are everything after the header until the diff
  const statsLines: string[] = [];
  const diffLines: string[] = [];
  let inDiff = false;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git')) {
      inDiff = true;
    }
    if (inDiff) {
      diffLines.push(lines[i]);
    } else {
      statsLines.push(lines[i]);
    }
  }

  // Get the full diff separately
  let diff = '';
  try {
    diff = await runGit(['show', '--format=', sha], { cwd });
  } catch {
    diff = diffLines.join('\n');
  }

  return {
    sha: parts[0] || sha,
    authorName: parts[1] || '',
    authorEmail: parts[2] || '',
    timestamp: parts[3] || '',
    message: parts[4] || '',
    stats: statsLines.join('\n').trim(),
    diff,
  };
}

export async function getWorktrees(cwd: string): Promise<GitWorktree[]> {
  const output = await runGit(['worktree', 'list', '--porcelain'], { cwd });

  const worktrees: GitWorktree[] = [];
  let current: Partial<GitWorktree> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) {
        worktrees.push({
          path: current.path,
          head: current.head || '',
          branch: current.branch || '',
          bare: current.bare || false,
          dirty: false, // filled below
        });
      }
      current = { path: line.substring(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.substring(5);
    } else if (line.startsWith('branch ')) {
      // Strip refs/heads/ prefix
      current.branch = line.substring(7).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    }
  }

  // Don't forget the last entry
  if (current.path) {
    worktrees.push({
      path: current.path,
      head: current.head || '',
      branch: current.branch || '',
      bare: current.bare || false,
      dirty: false,
    });
  }

  // Check dirty status for each non-bare worktree
  await Promise.all(
    worktrees.map(async (wt) => {
      if (wt.bare) return;
      try {
        const statusOutput = await runGit(
          ['status', '--porcelain', '--untracked-files=no'],
          { cwd: wt.path, timeoutMs: 5000 }
        );
        wt.dirty = statusOutput.trim().length > 0;
      } catch {
        // If we can't check, leave as false
      }
    })
  );

  return worktrees;
}

export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export async function deriveWorktree(cwd: string, branch: string, targetPath: string): Promise<string> {
  // Validate branch name
  if (!/^[\w.\-/]+$/.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }

  // Create the worktree
  await runGit(['worktree', 'add', '-b', branch, targetPath], { cwd, timeoutMs: 30000 });

  return targetPath;
}

export async function getRemotes(cwd: string): Promise<GitRemote[]> {
  const output = await runGit(['remote', '-v'], { cwd });
  const remotes: GitRemote[] = [];
  const seen = new Set<string>();

  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    // Format: "origin  git@github.com:user/repo.git (fetch)" or "origin  https://github.com/user/repo.git (push)"
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      remotes.push({
        name: match[1],
        url: match[2],
      });
    }
  }

  return remotes;
}

export async function fetchRemotes(cwd: string): Promise<void> {
  await runGit(['fetch', '--all'], { cwd, timeoutMs: 60000 });
}
