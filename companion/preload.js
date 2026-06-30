// Companion preload — injects a Tauri __TAURI_INTERNALS__ bridge so the desktop
// UI runs in REAL mode (isTauri() === true) instead of mock. @tauri-apps/api's
// invoke() calls window.__TAURI_INTERNALS__.invoke(); we forward that to the
// Electron main process (see main.js ipcMain 'tauri:invoke'), which implements
// the commands against clawmoney config + the backend.
//
// contextIsolation:false so we can define window globals directly. The desktop
// UI doesn't use Tauri events, so callbacks are a minimal local stub.
const { ipcRenderer } = require('electron');

const callbacks = new Map();
let nextCallbackId = 0;

window.__TAURI_INTERNALS__ = {
  invoke: (cmd, args) => ipcRenderer.invoke('tauri:invoke', cmd, args ?? {}),
  transformCallback: (callback, once) => {
    const id = ++nextCallbackId;
    callbacks.set(id, { callback, once: !!once });
    return id;
  },
  unregisterCallback: (id) => callbacks.delete(id),
  runCallback: (id, payload) => {
    const entry = callbacks.get(id);
    if (!entry) return;
    if (entry.once) callbacks.delete(id);
    try { entry.callback(payload); } catch { /* ignore */ }
  },
  callbacks,
  convertFileSrc: (filePath) => filePath,
  metadata: {
    currentWindow: { label: 'main' },
    currentWebview: { windowLabel: 'main', label: 'main' },
  },
  plugins: {},
};
