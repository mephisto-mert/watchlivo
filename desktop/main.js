// VORTEX Desktop Shell (Rave Electron parity): persistent DRM partition + <webview> support for Netflix/Disney+/Prime/Max/Crunchyroll/Tubi.
const { app, BrowserWindow, session, ipcMain, shell } = require('electron');
const path = require('path');

const SERVER_URL = process.env.VORTEX_URL || 'https://watchlivo.online';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function createWindow() {
  const drmSession = session.fromPartition('persist:vortex-drm');
  drmSession.setUserAgent(CHROME_UA);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b0a12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      partition: 'persist:vortex-app',
    },
  });

  win.webContents.setUserAgent(CHROME_UA);
  win.loadURL(SERVER_URL);
}

ipcMain.handle('vortex:open-external', (_ev, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
  return false;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
