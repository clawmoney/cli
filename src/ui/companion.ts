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
const COMPANION_FILES = ['main.js', 'package.json', 'tray-icon.png'];

function copyCompanionFiles(): void {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  for (const f of COMPANION_FILES) {
    const src = path.join(PKG_COMPANION, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(RUN_DIR, f));
  }
}

function ensureElectron(): string {
  const bin = path.join(
    RUN_DIR,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron'
  );
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
  }
  return bin;
}

/** Start the companion if it isn't already running. Idempotent. */
export async function ensureCompanionRunning(dashboardUrl?: string): Promise<void> {
  if (getCompanionPid() !== null) return; // already up (single instance)

  copyCompanionFiles();
  const electronBin = ensureElectron();

  const env = { ...process.env };
  if (dashboardUrl) env.CLAWMONEY_DASHBOARD_URL = dashboardUrl;

  const child = spawn(electronBin, [path.join(RUN_DIR, 'main.js')], {
    cwd: RUN_DIR,
    env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for the companion to write its PID file (up to ~5s).
  for (let i = 0; i < 50; i++) {
    if (getCompanionPid() !== null) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Companion did not come up in time.');
}

/** Resolve the dashboard URL (with auth token) from ~/.clawmoney/config.yaml. */
function resolveDashboardUrl(): string {
  const base = process.env.CLAWMONEY_DASHBOARD_URL || 'https://clawmoney.ai/dashboard';
  try {
    const cfg = loadConfig();
    if (cfg?.api_key) return `${base}?token=${encodeURIComponent(cfg.api_key)}`;
  } catch {
    // fall through to base
  }
  return base;
}

/** Open (or focus) the companion window. */
export async function openCompanion(dashboardUrl?: string): Promise<void> {
  const url = dashboardUrl ?? resolveDashboardUrl();
  await ensureCompanionRunning(url);
  await sendIpc('show');
}
