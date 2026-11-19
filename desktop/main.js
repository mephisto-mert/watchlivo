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

function isSafeExternalHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
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
  const isAllowedAuthPopupUrl = (raw) => {
    try {
      const u = new URL(String(raw || ''));
      if (u.protocol !== 'https:') return false;
      const h = u.hostname.toLowerCase();
      return (
        h === 'accounts.google.com' ||
        h === 'appleid.apple.com' ||
        h === 'github.com' ||
        h === 'discord.com' ||
        h === 'watchlivo-38ab6.firebaseapp.com' ||
        h === 'watchlivo-38ab6.web.app' ||
        h === 'watchlivo.online'
      );
    } catch (_) {
      return false;
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedAuthPopupUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            partition: 'persist:vortex-app',
          },
        },
      };
    }
    if (isSafeExternalHttpUrl(url)) shell.openExternal(url);
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
      if (targetOrig !== appOrig) {
        event.preventDefault();
      }
    } catch (_) {
      event.preventDefault();
    }
  });
  win.webContents.on('did-fail-load', (_ev, errorCode, _errorDesc, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const safeFailedUrl = escHtml(validatedURL || SERVER_URL);
    const safeServerHref = isSafeExternalHttpUrl(SERVER_URL) ? escHtml(SERVER_URL) : 'https://watchlivo.online';
    const retryHtml = `data:text/html;charset=utf-8,${encodeURIComponent(
      `<!doctype html><html lang="tr"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0a12;color:#f8fafc;font-family:system-ui,sans-serif;text-align:center"><div><h2 style="margin:0 0 10px">Watchlivo Sunucusuna Bağlanılamadı</h2><p style="color:#94a3b8;margin:0 0 18px">${safeFailedUrl}</p><a href="${safeServerHref}" style="display:inline-block;text-decoration:none;padding:12px 22px;border-radius:10px;background:#27dcc8;color:#041014;font-weight:800;cursor:pointer">Yeniden Dene</a></div></body></html>`
    )}`;
    win.loadURL(retryHtml).catch(() => {});
  });
  win.loadURL(SERVER_URL);
}

ipcMain.handle('vortex:open-external', (_ev, url) => {
  if (isSafeExternalHttpUrl(url)) return shell.openExternal(url);
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
