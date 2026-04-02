export interface FileStatus {
  exists: boolean;
  chars: number;
  preview: string;
}

export interface WorkspaceState {
  onboardingComplete: boolean;
  lastHeartbeatDate: string | null;
  /** @deprecated Use lastHeartbeatDate instead */
  lastCheckInDate?: string | null;
  schemaVersion: number;
  heartbeatEnabled: boolean;
  /** @deprecated Use heartbeatEnabled instead */
  dailyCheckInEnabled?: boolean;
}

export interface TaxonomyCategoryInfo {
  id: string;
  label: string;
  role: string;
  confidence: number;
  source: string;
  paths: string[];
}

export interface IndexStats {
  fileCount: number;
  chunkCount: number;
  lastIndexed: number;
  staleCount: number;
}

export interface WorkspaceInfo {
  path: string | null;
  valid?: boolean;
  reason?: string;
  exists?: boolean;
  files: Record<string, FileStatus>;
  state: WorkspaceState | null;
}

export type TabId = 'files' | 'taxonomy' | 'index' | 'organize';

export type PathValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';
