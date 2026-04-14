/**
 * Programmatic Claude fingerprint capture.
 *
 * Mirrors scripts/capture-claude-request.mjs but runs as a library so the
 * setup wizard can bootstrap the fingerprint automatically instead of
 * asking the user to run a two-terminal dance.
 *
 * Flow:
 *   1. Listen on a random localhost port.
 *   2. Spawn `claude -p "hi"` with ANTHROPIC_BASE_URL pointing at us.
 *   3. When the first POST /v1/messages arrives, extract device_id,
 *      account_uuid, user_agent, cc_version, cc_entrypoint from the
 *      body + headers, persist to ~/.clawmoney/claude-fingerprint.json,
 *      and forward the request to api.anthropic.com so the claude CLI
 *      still sees a real response.
 *   4. Clean up proxy server + claude subprocess.
 *
 * The forwarded request costs 1-2 cents' worth of tokens on the
 * provider's real Claude Max subscription — acceptable for a one-time
 * bootstrap that otherwise blocks every subsequent relay request.
 */

import { createServer, Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

const CONFIG_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_PATH = join(CONFIG_DIR, "claude-fingerprint.json");

export interface ClaudeFingerprint {
  device_id: string;
  account_uuid: string;
  user_agent: string;
  cc_version: string;
  cc_entrypoint: string;
}

export function hasClaudeFingerprint(): boolean {
  return existsSync(FINGERPRINT_PATH);
}

const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
]);

function cloneHeaders(src: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function extractFingerprint(
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): ClaudeFingerprint | null {
  if (!body || typeof body !== "object") return null;
  const metadata = (body as { metadata?: { user_id?: unknown } }).metadata;
  const userIdRaw = metadata?.user_id;
  if (typeof userIdRaw !== "string") return null;
  let userId: { device_id?: string; account_uuid?: string };
  try {
    userId = JSON.parse(userIdRaw);
  } catch {
    return null;
  }
  if (!userId.device_id || !userId.account_uuid) return null;

  const uaRaw = headers["user-agent"];
  const ua = Array.isArray(uaRaw) ? uaRaw.join(", ") : (uaRaw ?? "");

  // cc_version / cc_entrypoint are embedded in the system prompt as:
  //   "x-anthropic-billing-header: cc_version=X; cc_entrypoint=Y; ..."
  let cc_version = "";
  let cc_entrypoint = "";
  const systemArr = (body as { system?: unknown }).system;
  if (Array.isArray(systemArr)) {
    for (const entry of systemArr) {
      const text =
        typeof entry === "string"
          ? entry
          : (entry as { text?: unknown })?.text;
      if (typeof text !== "string") continue;
      if (text.includes("cc_version=")) {
        const v = text.match(/cc_version=([^;\s]+)/);
        const e = text.match(/cc_entrypoint=([^;\s]+)/);
        if (v) cc_version = v[1];
        if (e) cc_entrypoint = e[1];
        break;
      }
    }
  }

  return {
    device_id: userId.device_id,
    account_uuid: userId.account_uuid,
    user_agent: ua,
    cc_version,
    cc_entrypoint,
  };
}

// Scrub any stray `capture-<ts>.json` files from earlier manual capture
// runs — they can contain OAuth bearer tokens, so we delete them as soon
// as the fingerprint write succeeds.
function scrubCaptureFiles(): void {
  try {
    for (const f of readdirSync(CONFIG_DIR)) {
      if (/^capture-\d+\.json$/.test(f)) {
        unlinkSync(join(CONFIG_DIR, f));
      }
    }
  } catch {
    // ignore — best-effort cleanup
  }
}

export async function bootstrapClaudeFingerprint(
  opts: { timeoutMs?: number } = {}
): Promise<ClaudeFingerprint> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  mkdirSync(CONFIG_DIR, { recursive: true });

  if (hasClaudeFingerprint()) {
    // Caller should check hasClaudeFingerprint() first, but be defensive.
    throw new Error("claude-fingerprint.json already exists — delete it to re-bootstrap");
  }

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  let upstreamDispatcher: Dispatcher | undefined;
  if (proxyUrl && /^https?:\/\//.test(proxyUrl)) {
    upstreamDispatcher = new ProxyAgent(proxyUrl);
  }

  let server: Server | null = null;
  let claudeChild: ChildProcess | null = null;
  let resolved = false;
  let capturedFp: ClaudeFingerprint | null = null;

  const cleanup = () => {
    if (claudeChild && !claudeChild.killed) {
      try {
        claudeChild.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    if (server) {
      try {
        server.close();
      } catch {
        // ignore
      }
      server = null;
    }
  };

  return new Promise<ClaudeFingerprint>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(
        new Error(
          `claude fingerprint capture timed out after ${timeoutMs}ms (claude -p hi did not complete)`
        )
      );
    }, timeoutMs);

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const bodyBuf = Buffer.concat(chunks);
        const bodyText = bodyBuf.toString("utf-8");
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(bodyText);
        } catch {
          parsedBody = bodyText;
        }

        // Try fingerprint extraction on every POST /v1/messages that
        // comes through. We persist the first one that parses cleanly.
        if (
          !capturedFp &&
          req.method === "POST" &&
          typeof req.url === "string" &&
          req.url.startsWith("/v1/messages")
        ) {
          const fp = extractFingerprint(parsedBody, req.headers as Record<string, string | string[] | undefined>);
          if (fp) {
            capturedFp = fp;
            try {
              writeFileSync(
                FINGERPRINT_PATH,
                JSON.stringify(fp, null, 2),
                "utf-8"
              );
              scrubCaptureFiles();
            } catch (writeErr) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                cleanup();
                reject(new Error(`failed to write fingerprint: ${(writeErr as Error).message}`));
                return;
              }
            }
          }
        }

        // Forward to upstream so the claude CLI gets a real response
        // and doesn't error out mid-request.
        try {
          const upstreamHeaders = cloneHeaders(req.headers as Record<string, string | string[] | undefined>);
          const upstreamResp = await undiciFetch(
            `https://api.anthropic.com${req.url}`,
            {
              method: req.method,
              headers: upstreamHeaders,
              body:
                req.method === "GET" || req.method === "HEAD"
                  ? undefined
                  : bodyBuf,
              dispatcher: upstreamDispatcher,
            }
          );
          const respHeaders: Record<string, string> = {};
          upstreamResp.headers.forEach((v: string, k: string) => {
            const lower = k.toLowerCase();
            if (
              lower === "content-encoding" ||
              lower === "content-length" ||
              lower === "transfer-encoding"
            )
              return;
            respHeaders[k] = v;
          });
          res.writeHead(upstreamResp.status, respHeaders);
          if (upstreamResp.body) {
            const reader = upstreamResp.body.getReader();
            while (true) {
              const { done: rDone, value } = await reader.read();
              if (rDone) break;
              res.write(Buffer.from(value));
            }
          }
          res.end();
        } catch (err) {
          try {
            res.writeHead(502);
            res.end();
          } catch {
            // socket already closed
          }
          // Upstream proxy failure on the bootstrap request is fatal —
          // without a 2xx back, claude CLI won't finish and we'd block
          // here until timeout. Surface it now.
          if (!resolved && !capturedFp) {
            resolved = true;
            clearTimeout(timer);
            cleanup();
            reject(
              new Error(
                `upstream api.anthropic.com request failed: ${(err as Error).message}`
              )
            );
            return;
          }
        }

        // Resolve once we've both captured AND forwarded the response.
        if (capturedFp && !resolved) {
          resolved = true;
          clearTimeout(timer);
          cleanup();
          resolve(capturedFp);
        }
      });
    });

    server.on("error", (err: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`bootstrap proxy server error: ${err.message}`));
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      if (!addr || typeof addr === "string") {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("failed to bind capture proxy"));
        return;
      }
      const port = addr.port;

      // Build child env: inherit parent's env but strip HTTPS_PROXY
      // entries so claude doesn't try to tunnel its call to
      // http://127.0.0.1:<port> through the upstream proxy. Set
      // NO_PROXY=localhost as belt-and-braces.
      const childEnv = {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      };
      delete (childEnv as Record<string, string | undefined>).HTTPS_PROXY;
      delete (childEnv as Record<string, string | undefined>).https_proxy;
      delete (childEnv as Record<string, string | undefined>).HTTP_PROXY;
      delete (childEnv as Record<string, string | undefined>).http_proxy;
      delete (childEnv as Record<string, string | undefined>).ALL_PROXY;
      delete (childEnv as Record<string, string | undefined>).all_proxy;

      // Launch `claude -p "hi"` — same command the manual capture
      // script documents. `-p` is non-interactive print mode; in
      // recent claude versions it skips the trust dialog for
      // text-only prompts. We intentionally do NOT pass
      // --dangerously-skip-permissions — that would silently opt
      // users into a lower safety setting without consent.
      claudeChild = spawn("claude", ["-p", "hi"], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });

      // Buffer stderr so we can surface it in the error message if
      // claude bails out. stdout is dropped — we don't care about
      // the content, only about the /v1/messages request it made.
      let stderrBuf = "";
      claudeChild.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        if (stderrBuf.length > 4_000) {
          stderrBuf = stderrBuf.slice(-4_000);
        }
      });
      claudeChild.stdout?.on("data", () => {
        // drain, ignore
      });

      claudeChild.on("error", (err: Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        cleanup();
        reject(
          new Error(
            `failed to spawn claude: ${err.message} (is the claude CLI installed and in PATH?)`
          )
        );
      });

      claudeChild.on("exit", (code) => {
        // Give the HTTP handler a short moment to finish writing the
        // fingerprint after claude's subprocess exits. If we still don't
        // have a fingerprint after that, reject with a useful error.
        setTimeout(() => {
          if (capturedFp || resolved) return;
          resolved = true;
          clearTimeout(timer);
          cleanup();
          const tail = stderrBuf.trim().slice(-400);
          const detail = tail ? ` stderr: ${tail}` : "";
          reject(
            new Error(
              `claude -p hi exited with code ${code ?? "unknown"} before sending a /v1/messages request.${detail}`
            )
          );
        }, 500);
      });
    });
  });
}
