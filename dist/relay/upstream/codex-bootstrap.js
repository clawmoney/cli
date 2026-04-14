/**
 * Programmatic Codex fingerprint capture.
 *
 * Codex CLI 0.118+ talks to chatgpt.com over a WebSocket Upgrade
 * (GET /v1/responses Upgrade: websocket) rather than plain HTTPS,
 * which makes the in-process TS proxy approach used for Claude and
 * Gemini much harder — we'd need to port the full handshake + frame
 * decoder. So instead we reuse the existing
 * `scripts/capture-codex-request.mjs` script which already handles
 * all of that correctly: spawn it as a subprocess, run `codex -p hi`
 * against it, and wait for `~/.clawmoney/codex-fingerprint.json` to
 * appear. On success we SIGINT the capture proxy so it can scrub the
 * transient capture files the way the manual flow does.
 *
 * Note: the mjs script hardcodes port 8788. If something else on the
 * machine is already using that port, the spawn fails and we surface
 * the error.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const CONFIG_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_PATH = join(CONFIG_DIR, "codex-fingerprint.json");
const CAPTURE_PORT = 8788;
const CAPTURE_SCRIPT = "capture-codex-request.mjs";
export function hasCodexFingerprint() {
    return existsSync(FINGERPRINT_PATH);
}
// Locate the mjs capture script relative to the installed dist.
// After TS compilation this file ends up at
//   <pkg>/dist/relay/upstream/codex-bootstrap.js
// and the scripts live at <pkg>/scripts/capture-codex-request.mjs
// so the relative walk is ../../../scripts.
function findCaptureScript() {
    const thisFile = fileURLToPath(import.meta.url);
    const thisDir = dirname(thisFile);
    const candidates = [
        join(thisDir, "..", "..", "..", "scripts", CAPTURE_SCRIPT),
        join(thisDir, "..", "..", "scripts", CAPTURE_SCRIPT),
        join(thisDir, "..", "scripts", CAPTURE_SCRIPT),
    ];
    for (const c of candidates) {
        if (existsSync(c))
            return c;
    }
    return null;
}
export async function bootstrapCodexFingerprint(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    if (hasCodexFingerprint()) {
        throw new Error("codex-fingerprint.json already exists — delete it to re-bootstrap");
    }
    const scriptPath = findCaptureScript();
    if (!scriptPath) {
        throw new Error(`capture-codex-request.mjs not found in the installed clawmoney package`);
    }
    let proxyChild = null;
    let codexChild = null;
    let pollInterval = null;
    let done = false;
    const cleanup = () => {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        if (codexChild && !codexChild.killed) {
            try {
                codexChild.kill("SIGTERM");
            }
            catch {
                // ignore
            }
        }
        if (proxyChild && !proxyChild.killed) {
            try {
                // SIGINT triggers the mjs script's capture-file scrub
                // cleanup (scrubs OAuth bearer tokens).
                proxyChild.kill("SIGINT");
            }
            catch {
                // ignore
            }
        }
    };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (done)
                return;
            done = true;
            cleanup();
            reject(new Error(`codex fingerprint capture timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // 1. Spawn the capture proxy (mjs script). It inherits the
        // current process's env, including HTTPS_PROXY which it needs
        // to reach chatgpt.com.
        proxyChild = spawn("node", [scriptPath], {
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let proxyStderr = "";
        proxyChild.stderr?.on("data", (c) => {
            proxyStderr += c.toString();
            if (proxyStderr.length > 4_000) {
                proxyStderr = proxyStderr.slice(-4_000);
            }
        });
        proxyChild.stdout?.on("data", () => {
            // drain — the mjs script prints a banner we don't care about
        });
        proxyChild.on("error", (err) => {
            if (done)
                return;
            done = true;
            clearTimeout(timer);
            cleanup();
            reject(new Error(`failed to spawn capture proxy: ${err.message}`));
        });
        proxyChild.on("exit", (code) => {
            // If the proxy crashed before the fingerprint was captured,
            // reject. If we killed it deliberately after capture, 'done'
            // is already set.
            if (done)
                return;
            if (!hasCodexFingerprint()) {
                done = true;
                clearTimeout(timer);
                cleanup();
                const tail = proxyStderr.trim().slice(-400);
                const detail = tail ? ` stderr: ${tail}` : "";
                reject(new Error(`capture proxy exited (code ${code ?? "unknown"}) before fingerprint.${detail}`));
            }
        });
        // Wait a moment for the proxy to bind port 8788, then spawn
        // codex. 1.5s is enough on every machine I've tested.
        setTimeout(() => {
            if (done)
                return;
            // Poll the fingerprint file — the mjs script writes it as
            // soon as the first upgrade handshake decodes successfully.
            pollInterval = setInterval(() => {
                if (done) {
                    if (pollInterval) {
                        clearInterval(pollInterval);
                        pollInterval = null;
                    }
                    return;
                }
                if (hasCodexFingerprint()) {
                    done = true;
                    if (pollInterval) {
                        clearInterval(pollInterval);
                        pollInterval = null;
                    }
                    clearTimeout(timer);
                    cleanup();
                    resolve();
                }
            }, 500);
            // Codex wants the proxy-local endpoint; strip HTTPS_PROXY so
            // it talks to 127.0.0.1 directly (going through a proxy to
            // loopback tends to wedge).
            const childEnv = {
                ...process.env,
                OPENAI_BASE_URL: `http://127.0.0.1:${CAPTURE_PORT}/v1`,
                NO_PROXY: "127.0.0.1,localhost",
                no_proxy: "127.0.0.1,localhost",
            };
            delete childEnv.HTTPS_PROXY;
            delete childEnv.https_proxy;
            delete childEnv.HTTP_PROXY;
            delete childEnv.http_proxy;
            delete childEnv.ALL_PROXY;
            delete childEnv.all_proxy;
            codexChild = spawn("codex", ["-p", "hi"], {
                env: childEnv,
                stdio: ["ignore", "pipe", "pipe"],
                shell: process.platform === "win32",
            });
            let codexStderr = "";
            codexChild.stderr?.on("data", (c) => {
                codexStderr += c.toString();
                if (codexStderr.length > 4_000) {
                    codexStderr = codexStderr.slice(-4_000);
                }
            });
            codexChild.stdout?.on("data", () => {
                // drain
            });
            codexChild.on("error", (err) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                cleanup();
                reject(new Error(`failed to spawn codex: ${err.message} (is the codex CLI installed and in PATH?)`));
            });
            codexChild.on("exit", (code) => {
                // Give the proxy a moment to finish writing the fingerprint
                // after the WS upgrade completes. If no file after that,
                // fail with the stderr tail for diagnostics.
                setTimeout(() => {
                    if (done || hasCodexFingerprint())
                        return;
                    done = true;
                    clearTimeout(timer);
                    cleanup();
                    const tail = codexStderr.trim().slice(-400);
                    const detail = tail ? ` stderr: ${tail}` : "";
                    reject(new Error(`codex -p hi exited with code ${code ?? "unknown"} before the capture proxy saw a /v1/responses upgrade.${detail}`));
                }, 800);
            });
        }, 1500);
    });
}
