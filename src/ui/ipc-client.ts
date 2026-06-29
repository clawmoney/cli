// Filesystem IPC client: CLI (this process) -> companion Electron process.
//
// Same pattern as Coinbase awal's dist/ipcClient.js: write a request JSON file,
// watch the responses dir for the matching reply. No ports, no sockets.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// Must match companion/main.js.
const BRIDGE = path.join(os.tmpdir(), 'clawmoney-ui-bridge');
const REQ_DIR = path.join(BRIDGE, 'requests');
const RES_DIR = path.join(BRIDGE, 'responses');
const PID_FILE = path.join(BRIDGE, 'companion.pid');

function ensureDirs(): void {
  for (const d of [BRIDGE, REQ_DIR, RES_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

/** Returns the companion PID if it's alive, else null. */
export function getCompanionPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!pid) return null;
    process.kill(pid, 0); // signal 0 = liveness check, doesn't actually kill
    return pid;
  } catch {
    return null;
  }
}

/** Send one request to the companion and await its response. */
export function sendIpc<T = unknown>(
  channel: string,
  data: unknown = {},
  timeoutMs = 10_000
): Promise<T> {
  ensureDirs();
  const id = randomUUID();
  const resFile = path.join(RES_DIR, `${id}.json`);
  fs.writeFileSync(
    path.join(REQ_DIR, `${id}.json`),
    JSON.stringify({ id, channel, data }),
    { mode: 0o600 }
  );

  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      watcher.close();
      try {
        const parsed = JSON.parse(fs.readFileSync(resFile, 'utf8'));
        try { fs.unlinkSync(resFile); } catch {}
        const result = parsed.result;
        if (result && typeof result === 'object' && 'error' in result) {
          reject(new Error(String((result as { error: unknown }).error)));
        } else {
          resolve(result as T);
        }
      } catch (e) {
        reject(e as Error);
      }
    };

    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`Companion IPC timeout on "${channel}"`));
    }, timeoutMs);

    // Race: file may already exist before the watcher attaches.
    if (fs.existsSync(resFile)) return finish();
    const watcher = fs.watch(RES_DIR, (_e, f) => {
      if (f === `${id}.json`) finish();
    });
  });
}
