// SpareAI companion — Electron main process.
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
const { spawn, spawnSync } = require('node:child_process');

// Rebrand from "Electron" — sets the macOS menu-bar app name (and userData path).
app.setName('SpareAI');

// Single shared bridge dir, must match src/ui/ipc-client.ts.
const BRIDGE = path.join(os.tmpdir(), 'spareai-ui-bridge');
const REQ_DIR = path.join(BRIDGE, 'requests');
const RES_DIR = path.join(BRIDGE, 'responses');
const PID_FILE = path.join(BRIDGE, 'companion.pid');

// The CLI passes the resolved dashboard URL (with auth token) via env.
const DASHBOARD_URL = (process.env.SPAREAI_DASHBOARD_URL ?? process.env.CLAWMONEY_DASHBOARD_URL) || 'https://clawmoney.ai/dashboard';

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
// We implement the desktop UI's commands against spareai config + backend so
// the UI runs in real (isTauri) mode. Mirrors the Rust commands in
// spareai-desktop/src-tauri/src/main.rs (which mostly call the same backend
// or `spareai` CLI).
const API_BASE = (process.env.SPAREAI_API_BASE ?? process.env.CLAWMONEY_API_BASE) || 'https://api.bnbot.ai';
const CONFIG_PATH = path.join(os.homedir(), '.spareai', 'config.yaml');
const EXTENSION_URL = 'https://clawmoney.ai/extension';

// Electron GUI apps inherit a minimal PATH; extend it so `bnbot` resolves.
const CLI_PATH = [
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
  path.join(os.homedir(), '.npm-global', 'bin'),
  process.env.PATH || '',
].join(':');

// Mirror Rust service_status: read the daemon pid file, check the process is alive.
function readPidStatus(name, pidFile) {
  const pidPath = path.join(os.homedir(), '.spareai', pidFile);
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
      resolve({ installed, connected, status, installUrl: EXTENSION_URL, detail: out.trim() });
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

// Mirror desktop's ensure_provider_running: when the dashboard loads and the
// user is logged in but the Market provider isn't running, start it — so the
// companion auto-takes orders on open, just like the desktop app does.
// Uses ELECTRON_RUN_AS_NODE so the companion's own node runs the CLI entry
// (no dependency on a global `spareai` or system node on PATH).
function ensureMarketRunning() {
  const entry = (process.env.SPAREAI_CLI_ENTRY ?? process.env.CLAWMONEY_CLI_ENTRY);
  if (!entry || !fs.existsSync(entry)) return;
  const cfg = readClawConfig();
  if (!cfg || !cfg.api_key) return; // not logged in → don't take orders
  if (readPidStatus('market', 'provider.pid').running) return; // already up
  try {
    // Use system `node` (not process.execPath). process.execPath is the SpareAI
    // electron binary; even with ELECTRON_RUN_AS_NODE, the CLI's daemon inherits
    // that execPath and re-launches as a GUI electron window → single-instance
    // clash → the companion flickers/relaunches. `node` keeps the daemon headless.
    const child = spawn('node', [entry, 'market', 'start'], {
      env: { ...process.env, PATH: CLI_PATH },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    log('ensureMarketRunning: started `node spareai market start`');
  } catch (e) {
    log(`ensureMarketRunning failed: ${e.message}`);
  }
}

async function loadDashboard() {
  ensureMarketRunning();
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

// LLM subscriptions that can be resold via the relay (mirrors desktop LLM_SPECS).
const LLM_SPECS = [
  { cli: 'codex', package: '@openai/codex', token: '.codex/auth.json', model: 'gpt-5.6-sol' },
  { cli: 'chatgpt-web', package: '@jackwener/opencli', token: '', model: 'gpt-5.2' },
  { cli: 'gemini', package: '@google/gemini-cli', token: '.gemini/oauth_creds.json', model: 'gemini-2.5-flash' },
];
const RELAY_RESALE_PATH = path.join(os.homedir(), '.spareai', 'relay-resale.json');

function commandExists(bin) {
  try {
    return spawnSync('which', [bin], { env: { ...process.env, PATH: CLI_PATH }, encoding: 'utf8' }).status === 0;
  } catch { return false; }
}
function llmProbeBinary(cli) { return cli === 'chatgpt-web' ? 'opencli' : cli; }
function llmReady(cli, token) {
  // chatgpt-web has no token file; treat opencli's presence as the ready signal.
  if (cli === 'chatgpt-web') return commandExists('opencli');
  return token ? fs.existsSync(path.join(os.homedir(), ...token.split('/'))) : false;
}
function readRelaySettings() {
  try {
    if (fs.existsSync(RELAY_RESALE_PATH)) return JSON.parse(fs.readFileSync(RELAY_RESALE_PATH, 'utf8'));
  } catch { /* ignore */ }
  return {};
}

// Run a process async (Promise) so the Electron main thread never blocks —
// mirrors desktop's run_cli on a spawn_blocking thread. The UI stays responsive
// while market/relay daemons start/stop or npm installs run.
function runProc(cmd, procArgs, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, procArgs, { env: { ...process.env, PATH: CLI_PATH } });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: out.trim(), stderr: err.trim() });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e) });
    });
  });
}

// Run a spareai CLI subcommand via system `node` (not process.execPath, which
// is the electron binary — see ensureMarketRunning). Returns a Promise.
function runCli(cliArgs, timeoutMs = 25000) {
  const entry = (process.env.SPAREAI_CLI_ENTRY ?? process.env.CLAWMONEY_CLI_ENTRY);
  if (!entry || !fs.existsSync(entry)) return Promise.resolve({ ok: false, error: 'CLI entry not found' });
  return runProc('node', [entry, ...cliArgs], timeoutMs);
}

async function handleTauriCommand(cmd, args) {
  log(`invoke: ${cmd}`);
  try {
    switch (cmd) {
      case 'load_dashboard':
        return await loadDashboard();
      case 'load_provider_log':
        return { ok: true, providerLog: [] };
      // Local-service controls → drive the spareai CLI daemons.
      case 'start_market': return await runCli(['market', 'start']);
      case 'stop_market': return await runCli(['market', 'stop']);
      case 'start_surf': return await runCli(['relay', 'start']);
      case 'stop_surf': return await runCli(['relay', 'stop']);
      case 'launch_chrome':
        try { spawn('open', ['-a', 'Google Chrome'], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
        return { ok: true };
      case 'open_external':
        if (args && args.url) shell.openExternal(String(args.url));
        return { ok: true };
      case 'install_extension':
        shell.openExternal(EXTENSION_URL);
        return { ok: true };
      case 'logout': {
        // Clear api_key so the UI returns to the signed-out state.
        try {
          const txt = fs.readFileSync(CONFIG_PATH, 'utf8');
          fs.writeFileSync(CONFIG_PATH, txt.replace(/^api_key:.*$/m, '').replace(/\n{3,}/g, '\n\n'));
        } catch { /* ignore */ }
        return { ok: true };
      }
      // ── Agent 上架 (relay resale of LLM subscriptions) ──
      case 'llm_detect': {
        const providers = LLM_SPECS.map((s) => ({
          cli: s.cli,
          package: s.package,
          installed: commandExists(llmProbeBinary(s.cli)),
          loggedIn: llmReady(s.cli, s.token),
          defaultModel: s.model,
        }));
        return { ok: true, providers };
      }
      case 'llm_install': {
        const spec = LLM_SPECS.find((s) => s.cli === (args && args.cli));
        if (!spec) return { ok: false, error: `unknown cli ${args && args.cli}` };
        return await runProc('npm', ['install', '-g', spec.package], 180000);
      }
      case 'llm_login': {
        const cli = args && args.cli;
        if (cli === 'gemini') {
          try {
            spawn('osascript', ['-e', 'tell application "Terminal"\nactivate\ndo script "gemini"\nend tell'],
              { detached: true, stdio: 'ignore' }).unref();
          } catch { /* ignore */ }
          return { ok: true, message: '已打开终端 — 在终端里选 "Login with Google" 登录,完成后回来' };
        }
        const bin = llmProbeBinary(cli);
        if (!commandExists(bin)) return { ok: false, error: `${cli} 未安装` };
        try {
          spawn(bin, ['login'], { env: { ...process.env, PATH: CLI_PATH }, detached: true, stdio: 'ignore' }).unref();
        } catch (e) { return { ok: false, error: String(e) }; }
        return { ok: true };
      }
      case 'llm_set_enabled': {
        const cli = args && args.cli;
        const enabled = !!(args && args.enabled);
        try {
          const s = readRelaySettings();
          const disabled = new Set(Array.isArray(s.disabledClis) ? s.disabledClis : []);
          if (enabled) disabled.delete(cli); else disabled.add(cli);
          s.disabledClis = [...disabled];
          fs.mkdirSync(path.dirname(RELAY_RESALE_PATH), { recursive: true });
          fs.writeFileSync(RELAY_RESALE_PATH, JSON.stringify(s, null, 2));
          if (enabled && s.online) {
            const spec = LLM_SPECS.find((x) => x.cli === cli);
            if (spec && llmReady(spec.cli, spec.token)) {
              await runCli(['relay', 'register', '--cli', spec.cli, '--model', spec.model, '--concurrency', String(s.concurrency || 2)], 30000);
            }
          }
        } catch (e) { return { ok: false, error: String(e) }; }
        return { ok: true };
      }
      case 'relay_settings_get':
        return readRelaySettings();
      case 'relay_settings_set': {
        const settings = (args && args.settings) ? args.settings : (args || {});
        try {
          fs.mkdirSync(path.dirname(RELAY_RESALE_PATH), { recursive: true });
          fs.writeFileSync(RELAY_RESALE_PATH, JSON.stringify(settings, null, 2));
        } catch (e) { log(`relay_settings_set write: ${e.message}`); }
        if (settings.online === true) {
          const conc = String(settings.concurrency || 2);
          const disabled = Array.isArray(settings.disabledClis) ? settings.disabledClis : [];
          let registered = 0;
          for (const spec of LLM_SPECS) {
            if (disabled.includes(spec.cli)) continue;
            if (llmReady(spec.cli, spec.token)) {
              await runCli(['relay', 'register', '--cli', spec.cli, '--model', spec.model, '--concurrency', conc], 30000);
              registered++;
            }
          }
          return { ok: true, registered, applied: await runCli(['relay', 'start']) };
        }
        return { ok: true, applied: await runCli(['relay', 'stop']) };
      }
      default:
        // window/event plugin calls (plugin:window|*) + not-yet-wired commands
        // (llm_upload etc) — no-op so the UI doesn't error.
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
      '#app{transform:none !important;border-radius:22px !important;}' +
      // Frameless-window dragging: desktop UI uses Tauri JS dragging (no-op in
      // Electron), so make the top bars draggable via CSS app-region; keep all
      // interactive elements clickable.
      '.page-header,.sidebar-header{-webkit-app-region:drag;}' +
      '.page-actions,.page-actions *,button,a,input,select,[role=button]{-webkit-app-region:no-drag;}'
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
  tray.setToolTip('SpareAI');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open SpareAI', click: showWindow },
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
