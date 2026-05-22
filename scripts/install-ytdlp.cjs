#!/usr/bin/env node

/**
 * Post-install: best-effort install of yt-dlp.
 *
 * Why: clawmoney's YouTube `transcript` and `streaming-data` skills
 * shell out to yt-dlp because the chrome-extension path can't reach
 * either endpoint reliably (YouTube anti-automation gates). If yt-dlp
 * is missing those skills degrade silently to stub data, so we try
 * to install it up-front rather than letting users find out later.
 *
 * Strategy:
 *   1. If yt-dlp already on PATH — done.
 *   2. Otherwise pick the most appropriate installer for the platform
 *      and run it non-interactively, with a short timeout. If it
 *      fails (no sudo, no brew, sandbox, …) print actionable
 *      instructions but never exit non-zero — `npm i` must keep
 *      succeeding.
 */

const { execSync, execFileSync, spawnSync } = require('child_process');
const { platform } = require('os');

function which(cmd) {
  try {
    const out = execFileSync('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function tryRun(cmd, args, label) {
  console.log(`[ClawMoney] Installing yt-dlp via ${label}...`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', timeout: 180_000 });
  return r.status === 0;
}

function main() {
  if (which('yt-dlp')) {
    console.log('[ClawMoney] yt-dlp already installed');
    return;
  }

  const os = platform();
  let ok = false;

  if (os === 'darwin') {
    if (which('brew')) {
      ok = tryRun('brew', ['install', 'yt-dlp'], 'Homebrew');
    } else if (which('pipx')) {
      ok = tryRun('pipx', ['install', 'yt-dlp'], 'pipx');
    } else if (which('pip3')) {
      // --user keeps install in user site-packages; --break-system-packages
      // tolerates PEP 668 externally-managed flag on newer Python.
      ok = tryRun('pip3', ['install', '--user', '--break-system-packages', 'yt-dlp'], 'pip3');
    }
  } else if (os === 'linux') {
    if (which('pipx')) {
      ok = tryRun('pipx', ['install', 'yt-dlp'], 'pipx');
    } else if (which('pip3')) {
      ok = tryRun('pip3', ['install', '--user', '--break-system-packages', 'yt-dlp'], 'pip3');
    } else if (which('apt-get')) {
      ok = tryRun('apt-get', ['install', '-y', 'yt-dlp'], 'apt');
    }
  } else if (os === 'win32') {
    if (which('pip')) {
      ok = tryRun('pip', ['install', '--user', 'yt-dlp'], 'pip');
    } else if (which('winget')) {
      ok = tryRun('winget', ['install', '-e', '--id', 'yt-dlp.yt-dlp'], 'winget');
    }
  }

  if (ok && which('yt-dlp')) {
    console.log('[ClawMoney] yt-dlp installed successfully');
    return;
  }

  // Don't fail npm install — just print guidance.
  console.warn('');
  console.warn('[ClawMoney] Could not auto-install yt-dlp.');
  console.warn('  YouTube `transcript` and `streaming-data` skills will be degraded');
  console.warn('  (stub data) until you install it manually:');
  console.warn('    macOS:    brew install yt-dlp');
  console.warn('    Linux:    pipx install yt-dlp   (or apt install yt-dlp)');
  console.warn('    Windows:  pip install yt-dlp    (or winget install yt-dlp.yt-dlp)');
  console.warn('');
}

try {
  main();
} catch (err) {
  console.warn('[ClawMoney] yt-dlp install hook errored (non-fatal):', err && err.message);
}
