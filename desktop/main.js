// VORTEX Desktop Shell (Rave Electron parity): persistent DRM partition + <webview> support for Netflix/Disney+/Prime/Max/Crunchyroll/Tubi.
const { app, BrowserWindow, session, ipcMain, shell } = require('electron');
const path = require('path');

const SERVER_URL = process.env.VORTEX_URL || 'https://watchlivo.online';

function buildDesktopUserAgent() {
  if (process.platform === 'darwin') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
  if (process.platform === 'linux') {
    return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
}

const CHROME_UA = buildDesktopUserAgent();
let mainWindow = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

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
      sandbox: true,
      webviewTag: true,
      partition: 'persist:vortex-app',
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setUserAgent(CHROME_UA);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.partition = 'persist:vortex-drm';
    if (!/^https:\/\//i.test(String(params?.src || ''))) {
      event.preventDefault();
    }
  });
  win.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const targetOrig = new URL(navUrl).origin;
      const appOrig = new URL(SERVER_URL).origin;
      if (targetOrig !== appOrig && !/^https:\/\/accounts\.google\.com$/i.test(targetOrig)) {
        event.preventDefault();
      }
    } catch (_) {
      event.preventDefault();
    }
  });
  win.webContents.on('did-fail-load', (_ev, errorCode, _errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const retryHtml = `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><html lang="tr"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0a12;color:#f8fafc;font-family:system-ui,sans-serif;text-align:center"><div><h2 style="margin:0 0 10px">Watchlivo Sunucusuna Bağlanılamadı</h2><p style="color:#94a3b8;margin:0 0 18px">${String(validatedURL || SERVER_URL)}</p><button onclick="location.href='${SERVER_URL}'" style="padding:12px 22px;border:none;border-radius:10px;background:#27dcc8;color:#041014;font-weight:800;cursor:pointer">Yeniden Dene</button></div></body></html>`
    )}`;
    win.loadURL(retryHtml).catch(() => {});
  });
  win.loadURL(SERVER_URL);
}

ipcMain.handle('vortex:open-external', (_ev, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
  return false;
});

if (gotLock) {
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
