#!/usr/bin/env node
/**
 * Capture a real Gemini CLI request so gemini-api.ts can mimic it exactly.
 *
 * Usage:
 *   Terminal 1:  node scripts/capture-gemini-request.mjs
 *   Terminal 2:  CODE_ASSIST_ENDPOINT=http://127.0.0.1:8789 gemini -p "hi"
 *
 * The server intercepts the request to cloudcode-pa.googleapis.com,
 * extracts project_id, user_agent, cli_version, writes them to
 * ~/.clawmoney/gemini-fingerprint.json, then proxies the request to the real
 * upstream so the CLI receives a valid response and exits cleanly.
 *
 * All capture files are scrubbed after successful fingerprint extraction
 * (they contain OAuth bearer tokens).
 *
 * Port: 8789 (8787=claude, 8788=codex, 8789=gemini)
 */

import { createServer } from "node:http";
import { writeFileSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const PORT = 8789;
const OUT_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_PATH = join(OUT_DIR, "gemini-fingerprint.json");

// Honor HTTPS_PROXY so we can reach Google from behind a GFW egress.
const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;
let upstreamDispatcher;
if (proxyUrl && /^https?:\/\//.test(proxyUrl)) {
  upstreamDispatcher = new ProxyAgent(proxyUrl);
  console.log(`[proxy] forwarding upstream through ${proxyUrl}`);
}

mkdirSync(OUT_DIR, { recursive: true });

// Headers that refer to the inbound TCP hop — must not be forwarded.
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
]);

function cloneHeaders(src) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

/**
 * Resolve the correct upstream URL.
 * /v1internal/* or default => cloudcode-pa (Code Assist / Provider subscription)
 * /v1beta, /v1alpha        => generativelanguage (AI Studio)
 */
function resolveUpstreamURL(path) {
  if (
    path.startsWith("/v1beta") ||
    path.startsWith("/v1/beta") ||
    path.startsWith("/v1alpha")
  ) {
    return `https://generativelanguage.googleapis.com${path}`;
  }
  return `https://cloudcode-pa.googleapis.com${path}`;
}

/**
 * Extract fingerprint fields from a real gemini-cli v1internal request body.
 *
 * The real envelope captured from gemini-cli 0.36.0:
 *   { model, project, user_prompt_id, request: {...} }
 *
 * project    → project_id (for body.project in our own requests)
 * User-Agent → user_agent header value
 * version from User-Agent → cli_version
 * x-goog-api-client header → stainless-equivalent
 *
 * Returns null if the body does not contain a usable `project` field — e.g.
 * the :loadCodeAssist bootstrap request has only `{metadata}` and no project,
 * so we skip it and wait for :retrieveUserQuota or :generateContent.
 */
function extractFingerprint(body, headers) {
  const projectId =
    typeof body === "object" && typeof body.project === "string"
      ? body.project.trim()
      : "";
  if (!projectId) return null;

  const ua = (headers["user-agent"] || "").trim();
  const versionMatch = ua.match(/GeminiCLI\/(\d+\.\d+[\.\d]*)/i);
  const cliVersion = versionMatch ? versionMatch[1] : "unknown";
  const xGoogApiClient = (headers["x-goog-api-client"] || "").trim();

  return {
    project_id: projectId,
    cli_version: cliVersion,
    user_agent: ua || `GeminiCLI/${cliVersion}`,
    x_goog_api_client: xGoogApiClient || `gl-node/unknown`,
  };
}

let fingerprintWritten = false;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuf = Buffer.concat(chunks);
    const bodyText = bodyBuf.toString("utf-8");

    let parsedBody;
    try {
      parsedBody = JSON.parse(bodyText);
    } catch {
      parsedBody = bodyText;
    }

    // Write a redacted capture file (bearer token is in Authorization header).
    const ts = Date.now();
    const file = join(OUT_DIR, `capture-gemini-${ts}.json`);
    const captureForDisk = {
      capturedAt: new Date().toISOString(),
      method: req.method,
      path: req.url,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) =>
          k.toLowerCase() === "authorization"
            ? [k, "Bearer ***REDACTED***"]
            : [k, v]
        )
      ),
      body: parsedBody,
    };
    writeFileSync(file, JSON.stringify(captureForDisk, null, 2), "utf-8");

    console.log(`\n━━━ Captured ${req.method} ${req.url} ━━━`);
    console.log(`Wrote: ${file}`);
    console.log("Headers:");
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "authorization") {
        console.log(`  ${k}: Bearer ***REDACTED***`);
        continue;
      }
      console.log(`  ${k}: ${String(v).slice(0, 120)}`);
    }

    if (parsedBody && typeof parsedBody === "object") {
      console.log("Body keys:", Object.keys(parsedBody).join(", "));
      if (parsedBody.project) console.log("  project:", parsedBody.project);
      if (parsedBody.model) console.log("  model:", parsedBody.model);
      if (parsedBody.userAgent) console.log("  userAgent:", parsedBody.userAgent);
      if (parsedBody.requestId) console.log("  requestId:", parsedBody.requestId);
    }

    // ── Auto-extract fingerprint on first v1internal:generateContent POST ──
    const isGenerateContent =
      req.method === "POST" &&
      typeof req.url === "string" &&
      (req.url.includes("generateContent") || req.url.includes("v1internal"));

    if (
      isGenerateContent &&
      parsedBody &&
      typeof parsedBody === "object" &&
      !fingerprintWritten
    ) {
      try {
        const fp = extractFingerprint(parsedBody, req.headers);
        if (!fp) {
          // Request doesn't carry a project (probably :loadCodeAssist) — wait
          // for the next v1internal request that does.
          console.log(`  → skipping fingerprint extraction (no project in body)`);
        } else {
          writeFileSync(FINGERPRINT_PATH, JSON.stringify(fp, null, 2), "utf-8");
          fingerprintWritten = true;
          console.log(`\n  ✓ fingerprint written → ${FINGERPRINT_PATH}`);
          console.log(`    project_id:       ${fp.project_id}`);
          console.log(`    cli_version:      ${fp.cli_version}`);
          console.log(`    user_agent:       ${fp.user_agent}`);
          console.log(`    x_goog_api_client: ${fp.x_goog_api_client}`);

          // Scrub all capture files — they contain OAuth bearer tokens.
          try {
            for (const f of readdirSync(OUT_DIR)) {
              if (/^capture-gemini-\d+\.json$/.test(f)) {
                unlinkSync(join(OUT_DIR, f));
              }
            }
            console.log(
              `  ✓ cleared all capture-gemini-*.json files (OAuth tokens scrubbed)`
            );
          } catch (e) {
            console.warn(`  ! could not scrub captures: ${e.message}`);
          }
        }
      } catch (err) {
        console.error(`  ! fingerprint extraction failed: ${err.message}`);
      }
    }

    // ── Proxy to real upstream ──
    (async () => {
      const upstreamURL = resolveUpstreamURL(req.url || "/");
      const targetHost = new URL(upstreamURL).host;
      try {
        const upstreamHeaders = cloneHeaders(req.headers);
        upstreamHeaders["host"] = targetHost;

        const upstreamResp = await undiciFetch(upstreamURL, {
          method: req.method,
          headers: upstreamHeaders,
          body:
            req.method === "GET" || req.method === "HEAD"
              ? undefined
              : bodyBuf,
          dispatcher: upstreamDispatcher,
        });

        console.log(`  ← upstream ${upstreamResp.status} from ${targetHost}`);

        const respHeaders = {};
        upstreamResp.headers.forEach((v, k) => {
          const lower = k.toLowerCase();
          if (
            lower === "content-encoding" ||
            lower === "content-length" ||
            lower === "transfer-encoding"
          ) {
            return;
          }
          respHeaders[k] = v;
        });

        res.writeHead(upstreamResp.status, respHeaders);
        if (upstreamResp.body) {
          const reader = upstreamResp.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        }
        res.end();
      } catch (err) {
        console.error("  ! upstream error:", err.message);
        res.writeHead(502);
        res.end(`upstream error: ${err.message}`);
      }
    })();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`━━━ Gemini CLI Request Capture ━━━`);
  console.log(`Listening on http://127.0.0.1:${PORT}`);
  console.log(`Output dir: ${OUT_DIR}`);
  console.log(`\nIn another terminal, run:`);
  console.log(
    `  CODE_ASSIST_ENDPOINT=http://127.0.0.1:${PORT} gemini -p "hi"`
  );
  console.log(
    `\nThis captures project_id, user_agent, and cli_version from a real`
  );
  console.log(`Gemini CLI request and writes them to:`);
  console.log(`  ${FINGERPRINT_PATH}`);
  console.log(
    `\nAll capture files are auto-deleted after fingerprint extraction.`
  );
  console.log(`\n(Press Ctrl+C to stop)\n`);
});
