import type { UpdaterInstallResult, UpdaterSnapshot } from '../src/lib/updater-contract';
import type {
  CliMaintenanceSnapshot,
  CliMaintenanceSnapshots,
  CliProvider,
} from '../src/lib/cli-maintenance-contract';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
  },
  serverRecovery: {
    copyDiagnostics: () => ipcRenderer.invoke('server-recovery:copy-diagnostics') as Promise<boolean>,
    retry: () => ipcRenderer.invoke('server-recovery:retry') as Promise<boolean>,
    restartApp: () => ipcRenderer.invoke('server-recovery:restart-app') as Promise<boolean>,
    quitApp: () => ipcRenderer.invoke('server-recovery:quit-app') as Promise<boolean>,
    openDatabaseBackups: () => ipcRenderer.invoke('server-recovery:open-database-backups') as Promise<boolean>,
    startFreshDatabase: () => ipcRenderer.invoke('server-recovery:start-fresh-database') as Promise<boolean>,
    keepRestoredDatabase: () => ipcRenderer.invoke('server-recovery:keep-restored-database') as Promise<boolean>,
    continueFreshDatabase: () => ipcRenderer.invoke('server-recovery:continue-fresh-database') as Promise<boolean>,
  },
  // Resolve a dropped/selected File's real filesystem path. Electron 32+ removed
  // the renderer-side `File.path`, so consumers must ask via webUtils.
  fs: {
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch {
        return '';
      }
    },
  },
  shell: {
    revealPath: (request: {
      path: string;
      sessionId?: string;
      scope?: 'home';
    }) => ipcRenderer.invoke('shell:reveal-path', request),
    openHtmlFile: (request: { path: string; sessionId: string }) =>
      ipcRenderer.invoke('shell:open-html-file', request),
  },
  browser: {
    getConfig: (workspaceId: string) => ipcRenderer.invoke('browser:get-config', workspaceId) as Promise<{
      partition: string;
      webPreferences: string;
    } | null>,
    openExternal: (url: string) => ipcRenderer.invoke('browser:open-external', url) as Promise<boolean>,
    onNavigationBlocked: (callback: (data: { webContentsId: number; reason: string }) => void) => {
      const listener = (_event: unknown, data: { webContentsId: number; reason: string }) => callback(data);
      ipcRenderer.on('browser:navigation-blocked', listener);
      return () => { ipcRenderer.removeListener('browser:navigation-blocked', listener); };
    },
    onOpenUrlRequested: (callback: (data: { webContentsId: number; url: string }) => void) => {
      const listener = (_event: unknown, data: { webContentsId: number; url: string }) => callback(data);
      ipcRenderer.on('browser:open-url-requested', listener);
      return () => { ipcRenderer.removeListener('browser:open-url-requested', listener); };
    },
    onDownloadBlocked: (callback: (data: { webContentsId: number }) => void) => {
      const listener = (_event: unknown, data: { webContentsId: number }) => callback(data);
      ipcRenderer.on('browser:download-blocked', listener);
      return () => { ipcRenderer.removeListener('browser:download-blocked', listener); };
    },
  },
  app: {
    getLogPath: () => ipcRenderer.invoke('app:get-log-path') as Promise<string | null>,
    getDefaultAssistantHome: () =>
      ipcRenderer.invoke('app:get-default-assistant-home') as Promise<string>,
  },
  codex: {
    prepareWindowsRecovery: () => ipcRenderer.invoke('codex:prepare-windows-recovery'),
  },
  theme: {
    setSource: (source: 'system' | 'light' | 'dark') =>
      ipcRenderer.invoke('theme:set-source', source) as Promise<boolean>,
  },
  dialog: {
    openFolder: (options?: { defaultPath?: string; title?: string }) =>
      ipcRenderer.invoke('dialog:open-folder', options),
  },
  install: {
    checkPrerequisites: () => ipcRenderer.invoke('install:check-prerequisites'),
    start: () => ipcRenderer.invoke('install:start'),
    cancel: () => ipcRenderer.invoke('install:cancel'),
    getLogs: () => ipcRenderer.invoke('install:get-logs'),
    installGit: () => ipcRenderer.invoke('install:git'),
    onProgress: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('install:progress', listener);
      return () => { ipcRenderer.removeListener('install:progress', listener); };
    },
  },
  updater: {
    getStatus: () => ipcRenderer.invoke('updater:get-status') as Promise<UpdaterSnapshot | null>,
    checkForUpdates: () => ipcRenderer.invoke('updater:check') as Promise<UpdaterSnapshot>,
    downloadUpdate: () => ipcRenderer.invoke('updater:download') as Promise<UpdaterSnapshot>,
    quitAndInstall: () => ipcRenderer.invoke('updater:install') as Promise<UpdaterInstallResult>,
    onStatus: (callback: (data: UpdaterSnapshot) => void) => {
      const listener = (_event: unknown, data: UpdaterSnapshot) => callback(data);
      ipcRenderer.on('updater:status', listener);
      return () => { ipcRenderer.removeListener('updater:status', listener); };
    },
  },
  cliMaintenance: {
    getStatus: () => ipcRenderer.invoke('cli-maintenance:get-status') as Promise<CliMaintenanceSnapshots | null>,
    check: (provider?: CliProvider) => ipcRenderer.invoke('cli-maintenance:check', provider) as Promise<CliMaintenanceSnapshots>,
    update: (provider: CliProvider) => ipcRenderer.invoke('cli-maintenance:update', provider) as Promise<CliMaintenanceSnapshot | null>,
    cancel: (provider: CliProvider) => ipcRenderer.invoke('cli-maintenance:cancel', provider) as Promise<boolean>,
    onStatus: (callback: (data: CliMaintenanceSnapshots) => void) => {
      const listener = (_event: unknown, data: CliMaintenanceSnapshots) => callback(data);
      ipcRenderer.on('cli-maintenance:status', listener);
      return () => { ipcRenderer.removeListener('cli-maintenance:status', listener); };
    },
  },
  bridge: {
    isActive: () => ipcRenderer.invoke('bridge:is-active'),
  },
  proxy: {
    resolve: (url: string) => ipcRenderer.invoke('proxy:resolve', url),
  },
  widget: {
    exportPng: (html: string, width: number, isDark: boolean) =>
      ipcRenderer.invoke('widget:export-png', { html, width, isDark }),
  },
  artifact: {
    // Phase 3 long-shot export: render HTML in a hidden BrowserWindow and
    // capture a full-page PNG via CDP captureBeyondViewport. Returns a
    // discriminated result — callers pattern-match on `.error` vs `.base64`.
    exportLongShot: (params: {
      html: string;
      width: number;
      pixelRatio?: number;
      // No `outPath` — the main handler never writes to a renderer-supplied
      // path; it returns base64 and the renderer downloads it. (audit 1.1)
      maxHeightPx?: number;
      timeoutMs?: number;
    }) => ipcRenderer.invoke('artifact:export-long-shot', params),
  },
  asset: {
    captureHtmlThumbnail: (params: {
      previewUrl: string;
      width?: number;
      height?: number;
    }) => ipcRenderer.invoke('asset:capture-html-thumbnail', params),
  },
  terminal: {
    create: (opts: { id: string; cwd: string; cols: number; rows: number }) =>
      ipcRenderer.invoke('terminal:create', opts),
    write: (id: string, data: string) =>
      ipcRenderer.send('terminal:write', { id, data }),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
    kill: (id: string) =>
      ipcRenderer.invoke('terminal:kill', id),
    onData: (callback: (data: { id: string; data: string }) => void) => {
      const listener = (_event: unknown, data: { id: string; data: string }) => callback(data);
      ipcRenderer.on('terminal:data', listener);
      return () => { ipcRenderer.removeListener('terminal:data', listener); };
    },
    onExit: (callback: (data: { id: string; code: number }) => void) => {
      const listener = (_event: unknown, data: { id: string; code: number }) => callback(data);
      ipcRenderer.on('terminal:exit', listener);
      return () => { ipcRenderer.removeListener('terminal:exit', listener); };
    },
  },
  notification: {
    ready: () => ipcRenderer.send('notification:renderer-ready'),
    onClick: (
      callback: (
        action:
          | { type: string; payload: string }
          | { taskId?: string; sessionId?: string; event_id?: string; route?: string },
      ) => void,
    ) => {
      const listener = (
        _event: unknown,
        action:
          | { type: string; payload: string }
          | { taskId?: string; sessionId?: string; event_id?: string; route?: string },
      ) => callback(action);
      ipcRenderer.on('notification:click', listener);
      return () => { ipcRenderer.removeListener('notification:click', listener); };
    },
  },
});
