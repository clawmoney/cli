// Companion launcher: ensure the Electron companion is installed + running,
// then talk to it. This is the "reverse-launch" awal does — the CLI brings up
// the GUI on demand, zero app install for the user.
//
// Why a per-user run dir (~/.clawmoney/companion) instead of running straight
// from the installed package: the global npm package dir is often not writable,
// and we need to `npm i electron` somewhere. So we copy the tiny companion
// files into the user's home and install Electron there (awal uses env-paths
// for the same reason).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { getCompanionPid, sendIpc } from './ipc-client.js';
import { loadConfig } from '../utils/config.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Companion source shipped in the npm package: dist/ui/ -> ../../companion
const PKG_COMPANION = path.resolve(__dirname, '../../companion');
// Writable run dir in the user's home.
const RUN_DIR = path.join(os.homedir(), '.clawmoney', 'companion');
const COMPANION_FILES = ['main.js', 'package.json', 'tray-icon.png', 'icon.png', 'icon.icns', 'preload.js'];
function copyCompanionFiles() {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    for (const f of COMPANION_FILES) {
        const src = path.join(PKG_COMPANION, f);
        if (fs.existsSync(src))
            fs.copyFileSync(src, path.join(RUN_DIR, f));
    }
    // Bundled desktop UI (Vite build output) — copy recursively.
    const uiSrc = path.join(PKG_COMPANION, 'ui');
    if (fs.existsSync(uiSrc)) {
        fs.rmSync(path.join(RUN_DIR, 'ui'), { recursive: true, force: true });
        fs.cpSync(uiSrc, path.join(RUN_DIR, 'ui'), { recursive: true });
    }
}
// Rebrand the dev Electron.app so the Dock / Cmd-Tab name + icon read "Claw Money"
// instead of "Electron". The Dock name follows the running executable's name
// (CFBundleExecutable), so we rename the binary itself — CFBundleName /
// app.setName() alone don't change it.
const MACOS_BIN_NAME = 'Claw Money';
function electronBinaryPath() {
    if (process.platform === 'darwin') {
        const base = path.join(RUN_DIR, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS');
        const renamed = path.join(base, MACOS_BIN_NAME);
        return fs.existsSync(renamed) ? renamed : path.join(base, 'Electron');
    }
    return path.join(RUN_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
}
function patchElectronApp() {
    if (process.platform !== 'darwin')
        return;
    const appPath = path.join(RUN_DIR, 'node_modules', 'electron', 'dist', 'Electron.app');
    const contents = path.join(appPath, 'Contents');
    if (!fs.existsSync(contents))
        return;
    // Rename the executable — the Dock/Cmd-Tab name follows CFBundleExecutable.
    const oldBin = path.join(contents, 'MacOS', 'Electron');
    const newBin = path.join(contents, 'MacOS', MACOS_BIN_NAME);
    if (fs.existsSync(oldBin) && !fs.existsSync(newBin)) {
        try {
            fs.renameSync(oldBin, newBin);
        }
        catch { /* ignore */ }
    }
    const plist = path.join(contents, 'Info.plist');
    const buddy = '/usr/libexec/PlistBuddy';
    if (fs.existsSync(buddy) && fs.existsSync(plist)) {
        spawnSync(buddy, ['-c', 'Set :CFBundleName Claw Money', plist]);
        const dn = spawnSync(buddy, ['-c', 'Set :CFBundleDisplayName Claw Money', plist]);
        if (dn.status !== 0)
            spawnSync(buddy, ['-c', 'Add :CFBundleDisplayName string Claw Money', plist]);
        if (fs.existsSync(newBin))
            spawnSync(buddy, ['-c', `Set :CFBundleExecutable ${MACOS_BIN_NAME}`, plist]);
    }
    const icnsSrc = path.join(PKG_COMPANION, 'icon.icns');
    const icnsDst = path.join(contents, 'Resources', 'electron.icns');
    if (fs.existsSync(icnsSrc) && fs.existsSync(path.dirname(icnsDst))) {
        try {
            fs.copyFileSync(icnsSrc, icnsDst);
        }
        catch { /* ignore */ }
    }
    // Refresh LaunchServices so the new name/icon take effect.
    const lsregister = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
    if (fs.existsSync(lsregister))
        spawnSync(lsregister, ['-f', appPath]);
}
function ensureElectron() {
    const bin = path.join(RUN_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    if (!fs.existsSync(bin)) {
        // First run only: pull the prebuilt Electron runtime into RUN_DIR.
        // npm-installed files carry no macOS quarantine attr -> no Gatekeeper prompt.
        const r = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
            cwd: RUN_DIR,
            stdio: 'inherit',
        });
        if (r.status !== 0) {
            throw new Error('Failed to install the ClawMoney companion UI (Electron).');
        }
        patchElectronApp();
    }
    return electronBinaryPath();
}
/** Start the companion if it isn't already running. Idempotent. */
export async function ensureCompanionRunning(dashboardUrl) {
    if (getCompanionPid() !== null)
        return; // already up (single instance)
    copyCompanionFiles();
    const electronBin = ensureElectron();
    const env = { ...process.env };
    if (dashboardUrl)
        env.CLAWMONEY_DASHBOARD_URL = dashboardUrl;
    // Route Electron stdout/stderr to a log file so render issues are debuggable.
    const outLog = fs.openSync(path.join(RUN_DIR, 'companion.out.log'), 'a');
    const child = spawn(electronBin, [path.join(RUN_DIR, 'main.js')], {
        cwd: RUN_DIR,
        env,
        detached: true,
        stdio: ['ignore', outLog, outLog],
    });
    child.unref();
    // Wait for the companion to write its PID file (up to ~5s).
    for (let i = 0; i < 50; i++) {
        if (getCompanionPid() !== null)
            return;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Companion did not come up in time.');
}
/** Resolve the dashboard URL (with auth token) from ~/.clawmoney/config.yaml. */
function resolveDashboardUrl() {
    const base = process.env.CLAWMONEY_DASHBOARD_URL || 'https://clawmoney.ai/dashboard';
    try {
        const cfg = loadConfig();
        if (cfg?.api_key)
            return `${base}?token=${encodeURIComponent(cfg.api_key)}`;
    }
    catch {
        // fall through to base
    }
    return base;
}
// If the full ClawMoney Desktop (Tauri) app is installed, launch THAT and skip
// the Electron companion entirely — same tray icon, no duplicate UI.
const DESKTOP_APP_PATHS = [
    '/Applications/Claw Money.app',
    path.join(os.homedir(), 'Applications', 'Claw Money.app'),
];
function installedDesktopApp() {
    if (process.platform !== 'darwin')
        return null;
    return DESKTOP_APP_PATHS.find((p) => fs.existsSync(p)) ?? null;
}
/** Open the menu-bar UI: the installed Desktop app if present, else the companion. */
export async function openCompanion(dashboardUrl) {
    // CLAWMONEY_UI=companion forces the Electron companion even if Desktop is installed (testing).
    const forceCompanion = process.env.CLAWMONEY_UI === 'companion';
    const desktop = forceCompanion ? null : installedDesktopApp();
    if (desktop) {
        // Desktop app is installed → launch it, do NOT start the Electron companion.
        spawnSync('open', ['-a', desktop]);
        return 'desktop';
    }
    const url = dashboardUrl ?? resolveDashboardUrl();
    await ensureCompanionRunning(url);
    await sendIpc('show');
    return 'companion';
}
