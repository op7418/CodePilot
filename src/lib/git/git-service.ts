/**
 * Git Service - simple-git wrapper for CodePilot
 * Provides all Git operations needed for the Source Control feature
 */

import { simpleGit, SimpleGit, StatusResult, BranchSummary, LogResult, TagResult, DiffResult as SimpleGitDiffResult } from 'simple-git';
import path from 'path';
import fs from 'fs';
import type {
  GitRepoStatus,
  GitFileChange,
  GitFileStatus,
  GitBranch,
  GitCommit,
  GitStash,
  GitTag,
  GitDiff,
  GitDiffHunk,
  GitDiffLine,
} from '@/types/git';

export class GitService {
  private git: SimpleGit;
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  /** Get the repository path */
  getRepoPath(): string {
    return this.repoPath;
  }

  /** Check if the path is a valid git repository */
  async isValidRepo(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  /** Get repository status */
  async getStatus(): Promise<GitRepoStatus> {
    const status = await this.git.status();
    return {
      branch: status.current || 'HEAD',
      tracking: status.tracking || null,
      ahead: status.ahead,
      behind: status.behind,
      clean: status.isClean(),
      files: this.parseFileStatus(status),
    };
  }

  /** Stage files */
  async stage(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.git.add(files);
  }

  /** Stage all changes */
  async stageAll(): Promise<void> {
    await this.git.add('-A');
  }

  /** Unstage files */
  async unstage(files: string[]): Promise<void> {
    if (files.length === 0) return;
    // Use reset HEAD to unstage
    await this.git.reset(['--mixed', '--', ...files]);
  }

  /** Unstage all staged files */
  async unstageAll(): Promise<void> {
    await this.git.reset(['--mixed']);
  }

  /** Discard changes in files */
  async discard(files: string[]): Promise<void> {
    if (files.length === 0) return;
    await this.git.checkout(['--', ...files]);
  }

  /** Discard all changes */
  async discardAll(): Promise<void> {
    await this.git.checkout(['--', '.']);
    // Also clean untracked files
    await this.git.clean('fd');
  }

  /** Commit staged changes */
  async commit(message: string): Promise<string> {
    const result = await this.git.commit(message);
    return result.commit;
  }

  /** Get diff for a file or all changes */
  async getDiff(file?: string, staged: boolean = false): Promise<GitDiff> {
    const args: string[] = [];
    if (staged) {
      args.push('--cached');
    }
    if (file) {
      args.push('--', file);
    }

    const diff = await this.git.diff(args);
    return this.parseDiff(diff, file || 'all');
  }

  /** Get diff between two commits/branches */
  async getDiffBetween(from: string, to: string, file?: string): Promise<GitDiff> {
    const args = [`${from}...${to}`];
    if (file) {
      args.push('--', file);
    }
    const diff = await this.git.diff(args);
    return this.parseDiff(diff, file || `${from}...${to}`);
  }

  /** Get diff for a specific commit (compares commit with its parent) */
  async getCommitDiff(commitHash: string): Promise<GitDiff> {
    const diff = await this.git.diff([`${commitHash}^`, commitHash]);
    return this.parseDiff(diff, commitHash);
  }

  /** Get list of branches */
  async getBranches(): Promise<{ current: string; local: GitBranch[]; remote: GitBranch[] }> {
    const summary = await this.git.branch(['-a']);
    const local: GitBranch[] = [];
    const remote: GitBranch[] = [];
    let current = '';

    for (const [name, branch] of Object.entries(summary.branches)) {
      const isRemote = name.startsWith('remotes/');
      const branchInfo: GitBranch = {
        name: isRemote ? name.replace('remotes/', '') : name,
        current: branch.current,
        lastCommit: {
          hash: branch.commit,
          date: new Date().toISOString(), // simple-git doesn't provide date directly
          message: branch.label || '',
        },
      };

      if (branch.current) {
        current = isRemote ? branchInfo.name : name;
      }

      if (isRemote) {
        remote.push(branchInfo);
      } else {
        local.push(branchInfo);
      }
    }

    return { current, local, remote };
  }

  /** Checkout a branch */
  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  /** Create a new branch */
  async createBranch(name: string, startPoint?: string): Promise<void> {
    if (startPoint) {
      await this.git.checkoutBranch(name, startPoint);
    } else {
      await this.git.checkoutLocalBranch(name);
    }
  }

  /** Delete a local branch */
  async deleteBranch(name: string, force: boolean = false): Promise<void> {
    await this.git.deleteLocalBranch(name, force);
  }

  /** Merge a branch into current branch */
  async merge(branch: string, options?: { noFastForward?: boolean; message?: string }): Promise<{ success: boolean; conflict?: boolean; message: string }> {
    try {
      const args: string[] = [];
      if (options?.noFastForward) {
        args.push('--no-ff');
      }
      if (options?.message) {
        args.push('-m', options.message);
      }
      args.push(branch);

      const result = await this.git.merge(args);
      return {
        success: !result.conflicts?.length,
        conflict: !!result.conflicts?.length,
        message: result.merges?.length ? `Merged ${branch}` : `Merge failed`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        conflict: errorMessage.includes('CONFLICT'),
        message: errorMessage,
      };
    }
  }

  /** Push to remote */
  async push(remote: string = 'origin', branch?: string, options?: { force?: boolean; setUpstream?: boolean }): Promise<string> {
    const args: string[] = [];
    if (options?.force) {
      args.push('--force');
    }
    if (options?.setUpstream && branch) {
      args.push('-u', remote, branch);
    } else if (branch) {
      args.push(remote, branch);
    } else {
      args.push(remote);
    }

    const result = await this.git.push(args);
    return result.pushed?.length ? `Pushed to ${remote}` : 'Nothing to push';
  }

  /** Pull from remote */
  async pull(remote: string = 'origin', branch?: string): Promise<string> {
    const args = branch ? [remote, branch] : [remote];
    const result = await this.git.pull(args);
    return result.files?.length ? `Pulled ${result.files.length} file(s)` : 'Already up to date';
  }

  /** Fetch from remote */
  async fetch(remote: string = 'origin'): Promise<string> {
    await this.git.fetch(remote);
    return `Fetched from ${remote}`;
  }

  /** Get commit history */
  async getLog(limit: number = 50, skip: number = 0): Promise<{ commits: GitCommit[]; hasMore: boolean }> {
    const log = await this.git.log(['--max-count=' + (limit + 1), '--skip=' + skip]);
    const commits = log.all.slice(0, limit).map(commit => ({
      hash: commit.hash,
      shortHash: commit.hash.substring(0, 7),
      message: commit.message,
      author: commit.author_name || 'Unknown',
      email: commit.author_email || '',
      date: commit.date,
      parents: [], // parent_hashes not available in simple-git types
    }));

    return {
      commits,
      hasMore: log.all.length > limit,
    };
  }

  /** Get commit detail */
  async getCommitDetail(hash: string): Promise<GitCommit & { files: { path: string; status: string }[] }> {
    const commit = await this.git.show([hash, '--stat', '--format=%H%n%h%n%s%n%an%n%ae%n%aI%n%P']);
    const lines = commit.split('\n');

    const fullHash = lines[0] || hash;
    const shortHash = lines[1] || hash.substring(0, 7);
    const message = lines[2] || '';
    const author = lines[3] || 'Unknown';
    const email = lines[4] || '';
    const date = lines[5] || '';
    const parents = (lines[6] || '').split(' ').filter(Boolean);

    // Parse file changes (simplified)
    const files: { path: string; status: string }[] = [];
    const fileRegex = /^(\S+)\s+\|/gm;
    let match;
    while ((match = fileRegex.exec(commit)) !== null) {
      files.push({ path: match[1], status: 'M' });
    }

    return {
      hash: fullHash,
      shortHash,
      message,
      author,
      email,
      date,
      parents,
      files,
    };
  }

  /** Get stash list */
  async getStashList(): Promise<GitStash[]> {
    const list = await this.git.stashList();
    return list.all.map((item, index) => ({
      index,
      message: item.message || 'WIP',
      branch: '',
      date: new Date().toISOString(),
    }));
  }

  /** Create a stash */
  async stash(message?: string, includeUntracked: boolean = false): Promise<void> {
    const args = ['push'];
    if (message) {
      args.push('-m', message);
    }
    if (includeUntracked) {
      args.push('--include-untracked');
    }
    await this.git.stash(args);
  }

  /** Apply a stash */
  async applyStash(index: number, pop: boolean = false): Promise<void> {
    if (pop) {
      await this.git.stash(['pop', `stash@{${index}}`]);
    } else {
      await this.git.stash(['apply', `stash@{${index}}`]);
    }
  }

  /** Drop a stash */
  async dropStash(index: number): Promise<void> {
    await this.git.stash(['drop', `stash@{${index}}`]);
  }

  /** Get tags */
  async getTags(): Promise<{ tags: GitTag[]; latest: string | null }> {
    const result = await this.git.tags();
    const tags: GitTag[] = result.all.map(name => ({
      name,
      hash: '', // Would need additional call to get hash
    }));

    return {
      tags,
      latest: result.latest || null,
    };
  }

  /** Create a tag */
  async createTag(name: string, message?: string): Promise<void> {
    if (message) {
      await this.git.addAnnotatedTag(name, message);
    } else {
      await this.git.addTag(name);
    }
  }

  /** Delete a tag */
  async deleteTag(name: string): Promise<void> {
    await this.git.tag(['-d', name]);
  }

  /** Push tags to remote */
  async pushTags(remote: string = 'origin'): Promise<void> {
    await this.git.pushTags(remote);
  }

  /** Check for conflicts */
  async hasConflicts(): Promise<boolean> {
    const status = await this.git.status();
    return status.conflicted.length > 0;
  }

  /** Get conflict files */
  async getConflictedFiles(): Promise<string[]> {
    const status = await this.git.status();
    return status.conflicted;
  }

  /** Resolve conflict by accepting theirs */
  async acceptTheirs(file: string): Promise<void> {
    await this.git.checkout(['--theirs', file]);
    await this.git.add(file);
  }

  /** Resolve conflict by accepting ours */
  async acceptOurs(file: string): Promise<void> {
    await this.git.checkout(['--ours', file]);
    await this.git.add(file);
  }

  /** Get remote list */
  async getRemotes(): Promise<{ name: string; url: string }[]> {
    const remotes = await this.git.getRemotes(true);
    return remotes.map(r => ({
      name: r.name,
      url: r.refs?.fetch || '',
    }));
  }

  /** Add a remote */
  async addRemote(name: string, url: string): Promise<void> {
    await this.git.addRemote(name, url);
  }

  /** Remove a remote */
  async removeRemote(name: string): Promise<void> {
    await this.git.removeRemote(name);
  }

  /** Check if repository has any remotes */
  async hasRemotes(): Promise<boolean> {
    const remotes = await this.git.getRemotes();
    return remotes.length > 0;
  }

  // ==========================================
  // Private Helper Methods
  // ==========================================

  /** Parse file status from git status result */
  private parseFileStatus(status: StatusResult): GitFileChange[] {
    const files: GitFileChange[] = [];

    // Staged files
    for (const file of status.staged) {
      files.push({
        path: file,
        status: this.parseStatusCode(file, status),
        staged: true,
      });
    }

    // Modified files (not staged)
    for (const file of status.modified) {
      if (!files.find(f => f.path === file)) {
        files.push({
          path: file,
          status: 'M',
          staged: false,
        });
      }
    }

    // Created/Added files
    for (const file of status.created) {
      if (!files.find(f => f.path === file)) {
        files.push({
          path: file,
          status: 'A',
          staged: false,
        });
      }
    }

    // Deleted files
    for (const file of status.deleted) {
      if (!files.find(f => f.path === file)) {
        files.push({
          path: file,
          status: 'D',
          staged: false,
        });
      }
    }

    // Conflicted files
    for (const file of status.conflicted) {
      const existing = files.find(f => f.path === file);
      if (existing) {
        existing.status = 'C';
      } else {
        files.push({
          path: file,
          status: 'C',
          staged: false,
        });
      }
    }

    // Renamed files
    for (const file of status.renamed) {
      files.push({
        path: file.to,
        status: 'R',
        staged: false,
        oldPath: file.from,
      });
    }

    // Untracked files
    for (const file of status.not_added) {
      files.push({
        path: file,
        status: '?',
        staged: false,
      });
    }

    return files;
  }

  /** Parse status code from file path */
  private parseStatusCode(file: string, status: StatusResult): GitFileStatus {
    if (status.created.includes(file)) return 'A';
    if (status.deleted.includes(file)) return 'D';
    if (status.renamed.some(r => r.to === file)) return 'R';
    if (status.conflicted.includes(file)) return 'C';
    return 'M';
  }

  /** Parse diff output into structured format */
  private parseDiff(diff: string, file: string): GitDiff {
    if (!diff || diff.trim() === '') {
      return {
        file,
        additions: 0,
        deletions: 0,
        hunks: [],
        raw: diff,
      };
    }

    const lines = diff.split('\n');
    const hunks: GitDiffHunk[] = [];
    let currentHunk: GitDiffHunk | null = null;
    let additions = 0;
    let deletions = 0;
    let oldLineNumber = 0;
    let newLineNumber = 0;

    for (const line of lines) {
      // Hunk header: @@ -start,count +start,count @@ optional header
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }
        oldLineNumber = parseInt(hunkMatch[1], 10);
        newLineNumber = parseInt(hunkMatch[2], 10);
        currentHunk = {
          oldStart: oldLineNumber,
          oldLines: 0,
          newStart: newLineNumber,
          newLines: 0,
          header: line,
          lines: [],
        };
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith('+')) {
        additions++;
        newLineNumber++;
        currentHunk.newLines++;
        currentHunk.lines.push({
          type: 'add',
          content: line.substring(1),
          newLineNumber,
        });
      } else if (line.startsWith('-')) {
        deletions++;
        oldLineNumber++;
        currentHunk.oldLines++;
        currentHunk.lines.push({
          type: 'delete',
          content: line.substring(1),
          oldLineNumber,
        });
      } else if (line.startsWith(' ')) {
        oldLineNumber++;
        newLineNumber++;
        currentHunk.oldLines++;
        currentHunk.newLines++;
        currentHunk.lines.push({
          type: 'context',
          content: line.substring(1),
          oldLineNumber,
          newLineNumber,
        });
      }
    }

    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return {
      file,
      additions,
      deletions,
      hunks,
      raw: diff,
    };
  }
}

/** Create a GitService instance */
export function createGitService(repoPath: string): GitService {
  return new GitService(repoPath);
}

/** Check if a path is a git repository */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    const git = simpleGit(path);
    await git.status();
    return true;
  } catch {
    return false;
  }
}

/** Find the root of a git repository from a subdirectory */
export async function findGitRoot(path: string): Promise<string | null> {
  try {
    const git = simpleGit(path);
    const root = await git.revparse(['--show-toplevel']);
    return root.trim();
  } catch {
    return null;
  }
}

/** Clone a repository from URL to target directory */
export async function cloneRepository(
  url: string,
  targetDir: string,
  options?: {
    branch?: string;
    depth?: number;
    onProgress?: (event: { phase: string; loaded?: number; total?: number }) => void;
  }
): Promise<{ success: boolean; path: string; error?: string }> {
  try {
    // Extract repo name from URL
    const repoName = url.split('/').pop()?.replace(/\.git$/, '') || 'repo';
    const clonePath = path.join(targetDir, repoName);

    // Check if target already exists
    if (fs.existsSync(clonePath)) {
      return {
        success: false,
        path: clonePath,
        error: `Directory "${repoName}" already exists in ${targetDir}`,
      };
    }

    // Build clone args
    const cloneOptions: string[] = [];
    if (options?.branch) {
      cloneOptions.push('--branch', options.branch);
    }
    if (options?.depth) {
      cloneOptions.push('--depth', String(options.depth));
    }

    // Perform clone with progress
    const git = simpleGit({
      progress({ stage, progress, processed, total }) {
        if (options?.onProgress) {
          options.onProgress({
            phase: stage,
            loaded: processed,
            total: total || progress * 100,
          });
        }
      },
    });

    // simple-git clone signature: clone(repoPath, localPath, options)
    await git.clone(url, clonePath, cloneOptions.length > 0 ? cloneOptions : undefined);

    return {
      success: true,
      path: clonePath,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      path: '',
      error: errorMessage,
    };
  }
}
