// Rave-parity preload bridge: exposes window.vortexDesktop so DRM providers unlock inside Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vortexDesktop', {
  isElectron: true,
  version: '2.0.0',
  partition: 'persist:vortex-drm',
  openExternal: (url) => ipcRenderer.invoke('vortex:open-external', url),
});
