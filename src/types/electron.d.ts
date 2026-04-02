/**
 * Global type declarations for the Electron preload API.
 * Exposed via contextBridge.exposeInMainWorld('electronAPI', ...) in electron/preload.ts.
 */

interface ClaudeInstallDetection {
  path: string;
  version: string | null;
  type: 'native' | 'homebrew' | 'npm' | 'bun' | 'unknown';
}

interface ElectronInstallAPI {
  checkPrerequisites: () => Promise<{
    hasClaude: boolean;
    claudeVersion?: string;
    claudePath?: string;
    claudeInstallType?: 'native' | 'homebrew' | 'npm' | 'bun' | 'unknown';
    otherInstalls?: ClaudeInstallDetection[];
    hasGit?: boolean;
    platform?: string;
  }>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  getLogs: () => Promise<string[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProgress: (callback: (data: any) => void) => () => void;
}

interface UpdateStatusEvent {
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  info?: {
    version: string;
    releaseNotes?: string | { version: string; note: string }[] | null;
    releaseName?: string | null;
    releaseDate?: string;
  };
  progress?: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  };
  error?: string;
}

interface ElectronUpdaterAPI {
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: () => Promise<void>;
  onStatus: (callback: (data: UpdateStatusEvent) => void) => () => void;
}

interface ElectronTerminalAPI {
  create: (opts: { id: string; cwd: string; cols: number; rows: number }) => Promise<void>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => Promise<void>;
  kill: (id: string) => Promise<void>;
  onData: (callback: (data: { id: string; data: string }) => void) => () => void;
  onExit: (callback: (data: { id: string; code: number }) => void) => () => void;
}

interface ElectronAPI {
  versions: {
    electron: string;
    node: string;
    chrome: string;
    platform: string;
  };
  shell: {
    openPath: (path: string) => Promise<string>;
  };
  dialog: {
    openFolder: (options?: {
      defaultPath?: string;
      title?: string;
    }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  install: ElectronInstallAPI;
  updater?: ElectronUpdaterAPI;
  bridge?: {
    isActive: () => Promise<boolean>;
  };
  terminal?: ElectronTerminalAPI;
  notification?: {
    show: (options: { title: string; body?: string; onClick?: string }) => Promise<void>;
    onClick: (listener: (action: string) => void) => () => void;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
