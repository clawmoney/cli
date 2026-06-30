// ClawMoney companion — Electron main process.
//
// A tiny menu-bar (tray) app that gives CLI-only users a persistent icon +
// a dashboard window, WITHOUT installing the full Tauri desktop app.
// The CLI (client) talks to this process over a filesystem IPC bridge
// (see ../src/ui/ipc-client.ts), the same pattern Coinbase's `awal` uses.
//
// Plain CommonJS on purpose (Electron main is happiest that way).

const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

// Rebrand from "Electron" — sets the macOS menu-bar app name (and userData path).
app.setName('Claw Money');

// Single shared bridge dir, must match src/ui/ipc-client.ts.
const BRIDGE = path.join(os.tmpdir(), 'clawmoney-ui-bridge');
const REQ_DIR = path.join(BRIDGE, 'requests');
const RES_DIR = path.join(BRIDGE, 'responses');
const PID_FILE = path.join(BRIDGE, 'companion.pid');

// The CLI passes the resolved dashboard URL (with auth token) via env.
const DASHBOARD_URL = process.env.CLAWMONEY_DASHBOARD_URL || 'https://clawmoney.ai/dashboard';

// Verbose log so the CLI side can diagnose render failures (white screen etc).
const LOG_FILE = path.join(__dirname, 'companion.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.error(line);
}

// Local static server for the bundled desktop UI. We serve over HTTP (not
// file://) because the UI references public assets by absolute path, e.g.
// "/brand/logo-icon.png" — file:// would resolve those against the filesystem
// root and 404. A server root makes them resolve correctly (like Tauri does).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

let serverPort = null;

function startUIServer() {
  const root = path.join(__dirname, 'ui');
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    log('ui/index.html missing — UI server not started');
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
      let filePath = path.join(root, safe);
      if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(root, 'index.html'); // SPA fallback
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on('error', (e) => { log(`UI server error: ${e.message}`); resolve(null); });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      log(`UI server on http://127.0.0.1:${serverPort}`);
      resolve(serverPort);
    });
  });
}

let win = null;
let tray = null;

// --- single instance: never two icons / two windows --------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => showWindow());

function ensureDirs() {
  for (const d of [BRIDGE, REQ_DIR, RES_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

function loadUI() {
  if (serverPort) {
    const url = `http://127.0.0.1:${serverPort}/`;
    log(`loading desktop UI: ${url}`);
    win.loadURL(url);
  } else {
    log(`UI server unavailable, loading ${DASHBOARD_URL}`);
    win.loadURL(DASHBOARD_URL);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 920,
    minHeight: 640,
    show: false,
    // Match the Tauri desktop window: transparent + frameless. The desktop UI
    // draws its own rounded "floating card" + traffic lights, so a native frame
    // or opaque background would double the chrome and leak a black border
    // around the card (exactly what the user saw).
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  });
  // Diagnostics: surface render failures / renderer console into companion.log.
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log(`did-fail-load ${code} ${desc} ${url}`));
  win.webContents.on('console-message', (e) => log(`[renderer] ${e.message} (${e.sourceId}:${e.lineNumber})`));
  win.webContents.on('did-finish-load', () => {
    log('did-finish-load OK');
    // The desktop UI only goes transparent / fills edge-to-edge when isTauri() is
    // true. We keep isTauri() false (so data stays on mock for this step), and
    // instead force the Tauri look via CSS: kill the fake macOS desktop bg, the
    // body color, the .stage padding, and the letterbox scale transform.
    win.webContents.insertCSS(
      'html,body{background:transparent !important;}' +
      '#desktop{display:none !important;}' +
      '.stage{padding:0 !important;}' +
      '#app{transform:none !important;border-radius:22px !important;}'
    ).catch((e) => log(`insertCSS failed: ${e.message}`));
    win.show();
  });
  loadUI();
  // Open external links in the real browser, not inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Closing the window just hides it — the tray icon stays put (use Quit to exit).
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  if (process.platform === 'darwin') icon = icon.resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('ClawMoney');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open ClawMoney', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.isQuitting = true;
          cleanup();
          app.exit(0);
        },
      },
    ])
  );
  tray.on('click', showWindow);
}

// --- filesystem IPC server (CLI -> companion) --------------------------------
// CLI writes requests/<id>.json; we handle and write responses/<id>.json.
function handleRequestFile(file) {
  const reqPath = path.join(REQ_DIR, file);
  let req;
  try {
    req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
  } catch {
    return; // half-written file; the next watch event will catch it
  }
  try { fs.unlinkSync(reqPath); } catch {}

  let result;
  switch (req.channel) {
    case 'ping':
      result = { ok: true, pid: process.pid };
      break;
    case 'show':
      showWindow();
      result = { ok: true };
      break;
    case 'navigate':
      if (win && req.data && req.data.url) win.loadURL(req.data.url);
      showWindow();
      result = { ok: true };
      break;
    case 'quit':
      result = { ok: true };
      setTimeout(() => { app.isQuitting = true; cleanup(); app.exit(0); }, 50);
      break;
    default:
      result = { error: `unknown channel: ${req.channel}` };
  }

  try {
    fs.writeFileSync(
      path.join(RES_DIR, `${req.id}.json`),
      JSON.stringify({ id: req.id, result }),
      { mode: 0o600 }
    );
  } catch {}
}

function watchRequests() {
  // fs.watch misses files written before the watcher attaches — drain any
  // requests that arrived during startup first (fixes the IPC "show" timeout).
  try {
    for (const f of fs.readdirSync(REQ_DIR)) {
      if (f.endsWith('.json')) handleRequestFile(f);
    }
  } catch {}
  fs.watch(REQ_DIR, (_event, file) => {
    if (file && file.endsWith('.json')) handleRequestFile(file);
  });
}

function cleanup() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

app.whenReady().then(async () => {
  ensureDirs();
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  // Dock icon — dev Electron otherwise shows the default atom icon.
  if (process.platform === 'darwin' && app.dock) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));
    } catch (e) {
      log(`dock.setIcon failed: ${e.message}`);
    }
  }
  await startUIServer();
  createTray();
  createWindow();
  watchRequests();
});

// Tray app: don't quit when the window closes.
app.on('window-all-closed', () => {});
app.on('before-quit', () => { app.isQuitting = true; cleanup(); });
