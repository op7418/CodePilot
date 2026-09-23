/**
 * Global type declarations for the Electron preload API.
 * Exposed via contextBridge.exposeInMainWorld('electronAPI', ...) in electron/preload.ts.
 */
import type { UpdaterInstallResult, UpdaterSnapshot } from '@/lib/updater-contract';
import type {
  CliMaintenanceSnapshot,
  CliMaintenanceSnapshots,
  CliProvider,
} from '@/lib/cli-maintenance-contract';

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
  installGit: () => Promise<{ success: boolean; output?: string; error?: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onProgress: (callback: (data: any) => void) => () => void;
}

interface ElectronUpdaterAPI {
  getStatus: () => Promise<UpdaterSnapshot | null>;
  checkForUpdates: () => Promise<UpdaterSnapshot>;
  downloadUpdate: () => Promise<UpdaterSnapshot>;
  quitAndInstall: () => Promise<UpdaterInstallResult>;
  onStatus: (callback: (data: UpdaterSnapshot) => void) => () => void;
}

interface ElectronCliMaintenanceAPI {
  getStatus: () => Promise<CliMaintenanceSnapshots | null>;
  check: (provider?: CliProvider) => Promise<CliMaintenanceSnapshots>;
  update: (provider: CliProvider) => Promise<CliMaintenanceSnapshot | null>;
  cancel: (provider: CliProvider) => Promise<boolean>;
  onStatus: (callback: (data: CliMaintenanceSnapshots) => void) => () => void;
}

interface ElectronTerminalAPI {
  create: (opts: { id: string; cwd: string; cols: number; rows: number }) => Promise<void>;
  write: (id: string, data: string) => void;
  resize: (id: string, cols: number, rows: number) => Promise<void>;
  kill: (id: string) => Promise<void>;
  onData: (callback: (data: { id: string; data: string }) => void) => () => void;
  onExit: (callback: (data: { id: string; code: number }) => void) => () => void;
}

interface ElectronAssetAPI {
  captureHtmlThumbnail: (params: {
    previewUrl: string;
    width?: number;
    height?: number;
  }) => Promise<{
    base64?: string;
    width?: number;
    height?: number;
    error?: 'invalid_request' | 'invalid_preview_url' | 'capture_failed';
  }>;
}

interface ElectronBrowserAPI {
  getConfig: (workspaceId: string) => Promise<{
    partition: string;
    webPreferences: string;
  } | null>;
  openExternal: (url: string) => Promise<boolean>;
  onNavigationBlocked: (
    callback: (data: { webContentsId: number; reason: string }) => void,
  ) => () => void;
  onOpenUrlRequested: (
    callback: (data: { webContentsId: number; url: string }) => void,
  ) => () => void;
  onDownloadBlocked: (
    callback: (data: { webContentsId: number }) => void,
  ) => () => void;
}

interface ElectronAPI {
  versions: {
    electron: string;
    node: string;
    chrome: string;
    platform: string;
  };
  serverRecovery?: {
    /** Available on Main's offline recovery surface only. */
    copyDiagnostics: () => Promise<boolean>;
    retry: () => Promise<boolean>;
    restartApp: () => Promise<boolean>;
    /** Blocked state only: plain quit, never relaunch (registry is per-Main). */
    quitApp: () => Promise<boolean>;
    /** Database recovery state only; target path is fixed by Main. */
    openDatabaseBackups: () => Promise<boolean>;
    /** Database recovery state only; Main requires a native confirmation. */
    startFreshDatabase: () => Promise<boolean>;
    /** Fresh-start conflict only: preserve the restored DB and cancel the old intent. */
    keepRestoredDatabase: () => Promise<boolean>;
    /** Fresh-start conflict only: reverify the old backup before deleting current files. */
    continueFreshDatabase: () => Promise<boolean>;
  };
  shell: {
    revealPath: (request: {
      path: string;
      sessionId?: string;
      scope?: 'home';
    }) => Promise<string>;
    openHtmlFile: (request: { path: string; sessionId: string }) => Promise<string>;
  };
  browser?: ElectronBrowserAPI;
  app?: {
    /** Resolve the persistent log directory used by main process logging.
     *  Returns null when Electron can't surface a path (e.g. permission
     *  error). Renderer must guard for absence in non-Electron / web contexts. */
    getLogPath: () => Promise<string | null>;
    /** Platform-correct default assistant directory resolved by Electron. */
    getDefaultAssistantHome: () => Promise<string>;
  };
  codex?: {
    /** Copy one of the fixed official install commands and open a visible PowerShell.
     *  The main process never executes, pastes, or accepts a command argument. */
    prepareWindowsRecovery: () => Promise<{
      ok: boolean;
      copied: boolean;
      opened: boolean;
      installMethod?: 'npm' | 'standalone_script';
      error?: string;
    }>;
  };
  theme?: {
    /** Keep Electron's native window material in sync with next-themes. */
    setSource: (source: 'system' | 'light' | 'dark') => Promise<boolean>;
  };
  fs: {
    /** Resolve a File's absolute filesystem path (via Electron webUtils). Empty string if unavailable. */
    getPathForFile: (file: File) => string;
  };
  dialog: {
    openFolder: (options?: {
      defaultPath?: string;
      title?: string;
    }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  };
  install: ElectronInstallAPI;
  updater?: ElectronUpdaterAPI;
  cliMaintenance?: ElectronCliMaintenanceAPI;
  bridge?: {
    isActive: () => Promise<boolean>;
  };
  proxy?: {
    resolve: (url: string) => Promise<string>;
  };
  asset?: ElectronAssetAPI;
  terminal?: ElectronTerminalAPI;
  notification?: {
    /** Announces that the renderer click listener is installed. */
    ready: () => void;
    /**
     * Phase 3 Step 3: action payload now carries the task/session/event
     * tuple so `useNotificationClickRoute` can `router.push` to the
     * right page. Legacy string / `{type, payload}` shape kept for
     * non-task notifications.
     */
    onClick: (
      listener: (
        action:
          | string
          | { type: string; payload: string }
          | { taskId?: string; sessionId?: string; event_id?: string; route?: string },
      ) => void,
    ) => () => void;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
