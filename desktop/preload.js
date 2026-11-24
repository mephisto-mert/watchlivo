// Rave-parity preload bridge: exposes window.vortexDesktop so DRM providers unlock inside Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vortexDesktop', {
  isElectron: true,
  version: '2.0.0',
  partition: 'persist:vortex-drm',
  openExternal: (url) => ipcRenderer.invoke('vortex:open-external', url),
  startDesktopOAuth: (loginHint = '') => ipcRenderer.invoke('vortex:start-oauth', loginHint),
  onOAuthResult: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const listener = (_ev, payload) => cb(payload);
    ipcRenderer.on('vortex:oauth-result', listener);
    return () => ipcRenderer.removeListener('vortex:oauth-result', listener);
  },
});
