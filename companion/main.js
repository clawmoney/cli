// ClawMoney companion — Electron main process.
//
// A tiny menu-bar (tray) app that gives CLI-only users a persistent icon +
// a dashboard window, WITHOUT installing the full Tauri desktop app.
// The CLI (client) talks to this process over a filesystem IPC bridge
// (see ../src/ui/ipc-client.ts), the same pattern Coinbase's `awal` uses.
//
// Plain CommonJS on purpose (Electron main is happiest that way).

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

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

// ── Tauri invoke bridge ─────────────────────────────────────────────────────
// preload.js injects window.__TAURI_INTERNALS__.invoke -> ipcRenderer -> here.
// We implement the desktop UI's commands against clawmoney config + backend so
// the UI runs in real (isTauri) mode. Mirrors the Rust commands in
// clawmoney-desktop/src-tauri/src/main.rs (which mostly call the same backend
// or `clawmoney` CLI).
const API_BASE = process.env.CLAWMONEY_API_BASE || 'https://api.bnbot.ai';
const CONFIG_PATH = path.join(os.homedir(), '.clawmoney', 'config.yaml');
const EXTENSION_URL = 'https://clawmoney.ai/extension';

// Electron GUI apps inherit a minimal PATH; extend it so `bnbot` resolves.
const CLI_PATH = [
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  path.join(os.homedir(), '.npm-global', 'bin'),
  process.env.PATH || '',
].join(':');

// Mirror Rust service_status: read the daemon pid file, check the process is alive.
function readPidStatus(name, pidFile) {
  const pidPath = path.join(os.homedir(), '.clawmoney', pidFile);
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10) || null;
    if (pid) process.kill(pid, 0); // throws if the process isn't alive
    return { name, running: !!pid, pid, pidFile: pidPath };
  } catch {
    return { name, running: false, pid: null, pidFile: pidPath };
  }
}

// Mirror Rust get_extension_status: `bnbot status`; output with "extension" +
// "connected" => connected; command missing/failed => not installed.
function getExtensionStatus() {
  return new Promise((resolve) => {
    let done = false;
    let out = '';
    const finish = (installed, connected, status) => {
      if (done) return;
      done = true;
      resolve({ installed, connected, status, installUrl: EXTENSION_URL });
    };
    try {
      const p = spawn('bnbot', ['status'], { env: { ...process.env, PATH: CLI_PATH } });
      const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } finish(false, false, 'missing'); }, 12000);
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      p.on('error', () => { clearTimeout(timer); finish(false, false, 'missing'); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return finish(false, false, 'missing');
        const o = out.toLowerCase();
        const connected = o.includes('extension') && o.includes('connected');
        finish(true, connected, connected ? 'connected' : 'not_connected');
      });
    } catch {
      finish(false, false, 'missing');
    }
  });
}

function readClawConfig() {
  try {
    const txt = fs.readFileSync(CONFIG_PATH, 'utf8');
    const get = (k) => {
      const m = txt.match(new RegExp('^' + k + ':\\s*(.+)$', 'm'));
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
    };
    return {
      api_key: get('api_key'),
      agent_id: get('agent_id'),
      agent_slug: get('agent_slug'),
      email: get('email'),
      wallet_address: get('wallet_address'),
    };
  } catch {
    return null;
  }
}

async function apiGet(p, apiKey) {
  try {
    const r = await fetch(API_BASE + p, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String(e) };
  }
}

async function loadDashboard() {
  const cfg = readClawConfig();
  const configured = !!(cfg && cfg.api_key);
  const dash = {
    ok: true,
    apiBase: API_BASE,
    configPath: CONFIG_PATH,
    configured,
    config: configured
      ? { agent_slug: cfg.agent_slug, email: cfg.email, wallet_address: cfg.wallet_address }
      : null,
    account: { ok: false },
    wallet: { ok: false },
    extension: { installed: false, connected: false },
    services: { market: readPidStatus('market', 'provider.pid'), surf: readPidStatus('surf', 'relay.pid') },
    history: { ok: true, orders: [], escrow: [], orderCount: 0, escrowCount: 0 },
    orderEarnings: { ok: false },
    skills: [],
    providerLog: [],
    connections: { platforms: [] },
    cliAvailable: true,
  };
  dash.extension = await getExtensionStatus(); // local check, independent of config
  if (!configured) return dash;
  const key = cfg.api_key;
  const [account, wBase, wBsc, skills, orders, escrow, earnings] = await Promise.all([
    apiGet('/api/v1/claw-agents/me', key),
    apiGet('/api/v1/claw-agents/me/wallet/balance?asset=usdc&network=base', key),
    apiGet('/api/v1/claw-agents/me/wallet/balance?asset=usdc&network=bsc', key),
    apiGet('/api/v1/market/skills/mine?active_only=false', key),
    apiGet('/api/v1/market/orders/mine?role=provider&limit=50', key),
    apiGet('/api/v1/market/escrow/assigned?limit=12', key),
    apiGet('/api/v1/market/orders/mine/earnings', key),
  ]);

  if (account.ok) dash.account = { ok: true, data: account.data };

  const baseAmt = parseFloat((wBase.data && wBase.data.amount) || '0') || 0;
  const bscAmt = parseFloat((wBsc.data && wBsc.data.amount) || '0') || 0;
  dash.wallet = {
    ok: true,
    address: cfg.wallet_address || (wBase.data && wBase.data.address) || null,
    balance: baseAmt + bscAmt,
    base: baseAmt,
    bsc: bscAmt,
  };

  if (skills.ok) dash.skills = (skills.data && skills.data.data) || [];

  const orderList = (orders.data && orders.data.data) || [];
  const escrowList = (escrow.data && escrow.data.data) || [];
  dash.history = {
    ok: true,
    orders: orderList,
    escrow: escrowList,
    orderCount: orderList.length,
    escrowCount: escrowList.length,
  };

  if (earnings.ok) dash.orderEarnings = { ok: true, ...(earnings.data || {}) };

  return dash;
}

async function handleTauriCommand(cmd, args) {
  log(`invoke: ${cmd}`);
  try {
    switch (cmd) {
      case 'load_dashboard':
        return await loadDashboard();
      case 'load_provider_log':
        return { ok: true, providerLog: [] };
      default:
        // window/event plugin calls (e.g. plugin:window|start_dragging) — no-op for now.
        if (typeof cmd === 'string' && cmd.startsWith('plugin:')) return {};
        return { ok: true };
    }
  } catch (e) {
    log(`invoke ${cmd} failed: ${e.message}`);
    return { ok: false, error: String(e) };
  }
}

ipcMain.handle('tauri:invoke', (_e, cmd, args) => handleTauriCommand(cmd, args));

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
