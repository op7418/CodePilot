// ==========================================
// Git Types
// ==========================================

/** Git file status codes */
export type GitFileStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

/** File change item */
export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  staged: boolean;
  oldPath?: string; // For renamed files
}

/** Repository status */
export interface GitRepoStatus {
  branch: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  files: GitFileChange[];
  hasRemotes?: boolean;
}

/** Branch info */
export interface GitBranch {
  name: string;
  current: boolean;
  remote?: string;
  lastCommit?: {
    hash: string;
    date: string;
    message: string;
  };
}

/** Commit info */
export interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
}

/** Stash item */
export interface GitStash {
  index: number;
  message: string;
  branch: string;
  date: string;
}

/** Tag info */
export interface GitTag {
  name: string;
  hash: string;
  date?: string;
  message?: string;
}

/** Diff hunk line */
export interface GitDiffLine {
  type: 'context' | 'add' | 'delete';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/** Diff hunk */
export interface GitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: GitDiffLine[];
}

/** Diff result */
export interface GitDiff {
  file: string;
  oldFile?: string;
  additions: number;
  deletions: number;
  hunks: GitDiffHunk[];
  raw: string;
}

/** Repository record (stored in database) */
export interface GitRepository {
  id: string;
  path: string;
  name: string;
  scan_root?: string;
  is_default: boolean;
  last_opened_at?: string;
  created_at: string;
}

/** Scan root record (stored in database) */
export interface GitScanRoot {
  id: string;
  path: string;
  enabled: boolean;
  created_at: string;
}

/** Repository with status (for list display) */
export interface GitRepoWithStatus extends GitRepository {
  branch?: string;
  changes?: number;
  ahead?: number;
  behind?: number;
  hasRemote?: boolean;
  isPrivate?: boolean;
}

// ==========================================
// API Response Types
// ==========================================

export interface GitStatusResponse {
  status: GitRepoStatus;
}

export interface GitBranchesResponse {
  current: string;
  local: GitBranch[];
  remote: GitBranch[];
}

export interface GitLogResponse {
  commits: GitCommit[];
  hasMore: boolean;
}

export interface GitStashListResponse {
  stashes: GitStash[];
}

export interface GitTagsResponse {
  tags: GitTag[];
  latest: string | null;
}

export interface GitReposResponse {
  repos: GitRepoWithStatus[];
}

export interface GitScanResponse {
  found: number;
  added: number;
  skipped: number;
  repos: GitRepository[];
}

export interface GitDiffResponse {
  diff: GitDiff;
}

export interface GitCommitResponse {
  hash: string;
  message: string;
}

export interface GitBranchOperationResponse {
  success: boolean;
  message?: string;
  branch?: string;
}

// ==========================================
// Helper Functions
// ==========================================

/** Get status icon for file */
export function getGitStatusIcon(status: GitFileStatus): string {
  switch (status) {
    case 'M': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case 'C': return 'C';
    case 'U': return 'U';
    case '?': return 'U';
    default: return '?';
  }
}

/** Get status color class */
export function getGitStatusColor(status: GitFileStatus): string {
  switch (status) {
    case 'M': return 'text-yellow-500';
    case 'A': return 'text-green-500';
    case 'D': return 'text-red-500';
    case 'R': return 'text-purple-500';
    case 'C': return 'text-orange-500';
    case 'U': return 'text-red-600';
    case '?': return 'text-gray-400';
    default: return 'text-gray-400';
  }
}

/** Get status label */
export function getGitStatusLabel(status: GitFileStatus): string {
  switch (status) {
    case 'M': return 'Modified';
    case 'A': return 'Added';
    case 'D': return 'Deleted';
    case 'R': return 'Renamed';
    case 'C': return 'Copied';
    case 'U': return 'Untracked';
    case '?': return 'Untracked';
    default: return 'Unknown';
  }
}
