/**
 * Programmatic Gemini fingerprint capture.
 *
 * Spawns the existing scripts/capture-gemini-request.mjs as a
 * subprocess and runs `gemini -p hi` against it, rather than
 * reimplementing the proxy in TypeScript. The TS port I tried
 * first timed out at 25s even though the mjs script captures in
 * ~4s on the same machine — the mjs path is proven and reused
 * code, so keep the pattern consistent with codex-bootstrap.
 *
 * Note: the mjs script hardcodes port 8789. A collision surfaces
 * as a spawn error we forward to the caller.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const CONFIG_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_PATH = join(CONFIG_DIR, "gemini-fingerprint.json");
const CAPTURE_PORT = 8789;
const CAPTURE_SCRIPT = "capture-gemini-request.mjs";

export interface GeminiFingerprint {
  project_id: string;
  cli_version: string;
  user_agent: string;
  x_goog_api_client: string;
}

export function hasGeminiFingerprint(): boolean {
  return existsSync(FINGERPRINT_PATH);
}

function findCaptureScript(): string | null {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  const candidates = [
    join(thisDir, "..", "..", "..", "scripts", CAPTURE_SCRIPT),
    join(thisDir, "..", "..", "scripts", CAPTURE_SCRIPT),
    join(thisDir, "..", "scripts", CAPTURE_SCRIPT),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function bootstrapGeminiFingerprint(
  opts: { timeoutMs?: number } = {}
): Promise<GeminiFingerprint> {
  const timeoutMs = opts.timeoutMs ?? 45_000;

  if (hasGeminiFingerprint()) {
    throw new Error(
      "gemini-fingerprint.json already exists — delete it to re-bootstrap"
    );
  }

  const scriptPath = findCaptureScript();
  if (!scriptPath) {
    throw new Error(
      "capture-gemini-request.mjs not found in the installed clawmoney package"
    );
  }

  let proxyChild: ChildProcess | null = null;
  let geminiChild: ChildProcess | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let done = false;

  const cleanup = () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (geminiChild && !geminiChild.killed) {
      try {
        geminiChild.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    if (proxyChild && !proxyChild.killed) {
      try {
        // SIGINT lets the mjs script scrub its capture-gemini-*.json
        // stragglers (they contain OAuth bearer tokens).
        proxyChild.kill("SIGINT");
      } catch {
        // ignore
      }
    }
  };

  return new Promise<GeminiFingerprint>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(
        new Error(`gemini fingerprint capture timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);

    // 1. Spawn the capture proxy (mjs script). It needs HTTPS_PROXY
    // to reach cloudcode-pa.googleapis.com from a GFW egress.
    proxyChild = spawn("node", [scriptPath], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let proxyStderr = "";
    proxyChild.stderr?.on("data", (c: Buffer) => {
      proxyStderr += c.toString();
      if (proxyStderr.length > 4_000) {
        proxyStderr = proxyStderr.slice(-4_000);
      }
    });
    proxyChild.stdout?.on("data", () => {
      // drain — the mjs prints a banner we ignore
    });

    proxyChild.on("error", (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`failed to spawn capture proxy: ${err.message}`));
    });

    proxyChild.on("exit", (code) => {
      if (done) return;
      if (!hasGeminiFingerprint()) {
        done = true;
        clearTimeout(timer);
        cleanup();
        const tail = proxyStderr.trim().slice(-400);
        const detail = tail ? ` stderr: ${tail}` : "";
        reject(
          new Error(
            `capture proxy exited (code ${code ?? "unknown"}) before fingerprint.${detail}`
          )
        );
      }
    });

    // Give the mjs proxy a moment to bind port 8789, then spawn
    // gemini. 1.5s is enough on every machine I've tested.
    setTimeout(() => {
      if (done) return;

      // Poll the fingerprint file — the mjs script writes it as
      // soon as the first v1internal request with a project field
      // comes through.
      pollInterval = setInterval(() => {
        if (done) {
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          return;
        }
        if (hasGeminiFingerprint()) {
          done = true;
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
          clearTimeout(timer);
          cleanup();
          try {
            const raw = JSON.parse(
              readFileSync(FINGERPRINT_PATH, "utf-8")
            ) as GeminiFingerprint;
            resolve(raw);
          } catch (err) {
            reject(
              new Error(
                `fingerprint file written but unreadable: ${(err as Error).message}`
              )
            );
          }
        }
      }, 500);

      // DO inherit HTTPS_PROXY — gemini CLI needs it to reach
      // oauth2.googleapis.com for token refresh (see gemini-api.ts
      // line 184). NO_PROXY=127.0.0.1 makes gemini bypass the proxy
      // for our local capture listener, so HTTPS_PROXY + NO_PROXY
      // together give gemini proxy access to Google AND direct
      // access to our listener.
      const childEnv = {
        ...process.env,
        CODE_ASSIST_ENDPOINT: `http://127.0.0.1:${CAPTURE_PORT}`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      };

      geminiChild = spawn("gemini", ["-p", "hi"], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      let geminiStderr = "";
      geminiChild.stderr?.on("data", (c: Buffer) => {
        geminiStderr += c.toString();
        if (geminiStderr.length > 4_000) {
          geminiStderr = geminiStderr.slice(-4_000);
        }
      });
      geminiChild.stdout?.on("data", () => {
        // drain
      });

      geminiChild.on("error", (err: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cleanup();
        reject(
          new Error(
            `failed to spawn gemini: ${err.message} (is the gemini CLI installed and in PATH?)`
          )
        );
      });

      geminiChild.on("exit", (code) => {
        setTimeout(() => {
          if (done || hasGeminiFingerprint()) return;
          done = true;
          clearTimeout(timer);
          cleanup();
          const tail = geminiStderr.trim().slice(-400);
          const detail = tail ? ` stderr: ${tail}` : "";
          reject(
            new Error(
              `gemini -p hi exited with code ${code ?? "unknown"} before the capture proxy saw a v1internal request with a project field.${detail}`
            )
          );
        }, 800);
      });
    }, 1500);
  });
}
