// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
});
