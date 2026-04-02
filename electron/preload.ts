// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
  },
  shell: {
    openPath: (folderPath: string) => ipcRenderer.invoke('shell:open-path', folderPath),
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
    onProgress: (callback: (data: unknown) => void) => {
      const listener = (_event: unknown, data: unknown) => callback(data);
      ipcRenderer.on('install:progress', listener);
      return () => { ipcRenderer.removeListener('install:progress', listener); };
    },
  },
  bridge: {
    isActive: () => ipcRenderer.invoke('bridge:is-active'),
  },
  widget: {
    exportPng: (html: string, width: number, isDark: boolean) =>
      ipcRenderer.invoke('widget:export-png', { html, width, isDark }),
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
    show: (options: { title: string; body: string; onClick?: unknown }) =>
      ipcRenderer.invoke('notification:show', options),
    onClick: (callback: (action: { type: string; payload: string }) => void) => {
      const listener = (_event: unknown, action: { type: string; payload: string }) => callback(action);
      ipcRenderer.on('notification:click', listener);
      return () => { ipcRenderer.removeListener('notification:click', listener); };
    },
  },
});
