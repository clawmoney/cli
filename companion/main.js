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

// Single shared bridge dir, must match src/ui/ipc-client.ts.
const BRIDGE = path.join(os.tmpdir(), 'clawmoney-ui-bridge');
const REQ_DIR = path.join(BRIDGE, 'requests');
const RES_DIR = path.join(BRIDGE, 'responses');
const PID_FILE = path.join(BRIDGE, 'companion.pid');

// The CLI passes the resolved dashboard URL (with auth token) via env.
const DASHBOARD_URL = process.env.CLAWMONEY_DASHBOARD_URL || 'https://clawmoney.ai/dashboard';

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

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 920,
    minHeight: 640,
    title: 'ClawMoney',
    show: false,
    backgroundColor: '#0a0a14',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(DASHBOARD_URL);
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
  fs.watch(REQ_DIR, (_event, file) => {
    if (file && file.endsWith('.json')) handleRequestFile(file);
  });
}

function cleanup() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

app.whenReady().then(() => {
  ensureDirs();
  fs.writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  createTray();
  showWindow();
  watchRequests();
});

// Tray app: don't quit when the window closes.
app.on('window-all-closed', () => {});
app.on('before-quit', () => { app.isQuitting = true; cleanup(); });
