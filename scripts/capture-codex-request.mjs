#!/usr/bin/env node
// Capture a real Codex CLI request by running:
//   1. terminal A: node scripts/capture-codex-request.mjs
//   2. terminal B (configure base URL, see note below):
//
//      Option A — env var (if Codex CLI honors OPENAI_BASE_URL):
//        OPENAI_BASE_URL=http://127.0.0.1:8788/v1 codex exec "hi"
//
//      Option B — config.toml override (Codex CLI recommended method):
//        echo 'openai_base_url = "http://127.0.0.1:8788/v1"' >> ~/.codex/config.toml
//        codex exec "hi"
//        # then revert: remove that line from ~/.codex/config.toml
//
// The server logs headers + body to ~/.clawmoney/capture-codex-<ts>.json,
// proxies the request to chatgpt.com so the CLI does not error out, then
// auto-writes ~/.clawmoney/codex-fingerprint.json and scrubs capture files.

import { createServer } from "node:http";
import { writeFileSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const PORT = 8788;
const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_PATH = join(CLAWMONEY_DIR, "codex-fingerprint.json");

// Honor shell HTTPS_PROXY so we can reach chatgpt.com behind a GFW-style egress.
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

mkdirSync(CLAWMONEY_DIR, { recursive: true });

// Headers that refer to the inbound hop — must not be forwarded as-is.
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

// Map a local proxy path to the real chatgpt.com URL.
// Codex CLI (via openai_base_url override) sends to /v1/responses or similar.
// The real upstream at chatgpt.com is /backend-api/codex/responses.
function resolveUpstreamURL(localPath) {
  if (localPath.startsWith("/v1/responses") || localPath.startsWith("/v1/chat/completions")) {
    return `https://chatgpt.com/backend-api/codex/responses`;
  }
  if (localPath.startsWith("/backend-api/")) {
    return `https://chatgpt.com${localPath}`;
  }
  return null;
}

function isCodexRequest(path) {
  return (
    path.startsWith("/v1/responses") ||
    path.startsWith("/v1/chat/completions") ||
    path.startsWith("/backend-api/codex/")
  );
}

function deriveOriginatorFromUA(ua) {
  const m = ua.match(/^(codex_[\w]+)\//i);
  if (m) return m[1].toLowerCase();
  return "codex_cli_rs";
}

function extractCodexFingerprint(body, headers) {
  const ua = (headers["user-agent"] || "").trim();
  if (!ua) return null;
  let cli_version = "";
  const versionMatch = ua.match(/[\w]+\/(\d+\.\d+\.\d+)/);
  if (versionMatch) cli_version = versionMatch[1];
  const originator = (headers["originator"] || "").trim() || deriveOriginatorFromUA(ua);
  return {
    user_agent: ua,
    cli_version: cli_version || "0.104.0",
    originator: originator || "codex_cli_rs",
  };
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuf = Buffer.concat(chunks);
    const bodyText = bodyBuf.toString("utf-8");

    let parsedBody;
    try { parsedBody = JSON.parse(bodyText); } catch { parsedBody = bodyText; }

    const ts = Date.now();
    const captureFile = join(CLAWMONEY_DIR, `capture-codex-${ts}.json`);

    const capture = {
      capturedAt: new Date().toISOString(),
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: parsedBody,
    };
    writeFileSync(captureFile, JSON.stringify(capture, null, 2), "utf-8");

    console.log(`\n━━━ Captured ${req.method} ${req.url} ━━━`);
    console.log(`Wrote: ${captureFile}`);
    console.log("Headers:");
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "authorization") {
        console.log(`  ${k}: Bearer ***REDACTED***`);
      } else {
        console.log(`  ${k}: ${String(v).slice(0, 120)}`);
      }
    }
    if (parsedBody && typeof parsedBody === "object") {
      console.log("Body keys:", Object.keys(parsedBody).join(", "));
      if (parsedBody.model) console.log("  model:", parsedBody.model);
      if (parsedBody.instructions) {
        console.log("  instructions (first 200):", String(parsedBody.instructions).slice(0, 200));
      }
      if (Array.isArray(parsedBody.input)) {
        console.log(`  input[0]:`, JSON.stringify(parsedBody.input[0]).slice(0, 200));
      }
    }

    const upstreamURL = resolveUpstreamURL(req.url ?? "/");
    if (!upstreamURL || !isCodexRequest(req.url ?? "")) {
      console.log(`  → path not matched (${req.url}), returning 404`);
      res.writeHead(404);
      res.end(`capture-codex-request: path ${req.url} not handled`);
      return;
    }

    // Auto-extract fingerprint from matched requests.
    if (req.method === "POST" && parsedBody && typeof parsedBody === "object") {
      try {
        const fp = extractCodexFingerprint(parsedBody, req.headers);
        if (fp) {
          writeFileSync(FINGERPRINT_PATH, JSON.stringify(fp, null, 2), "utf-8");
          console.log(`\n  ✓ fingerprint written → ${FINGERPRINT_PATH}`);
          console.log(`    user_agent:  ${fp.user_agent}`);
          console.log(`    cli_version: ${fp.cli_version}`);
          console.log(`    originator:  ${fp.originator}`);
          // Scrub all capture files (they contain the Bearer token).
          try {
            for (const f of readdirSync(CLAWMONEY_DIR)) {
              if (/^capture-codex-\d+\.json$/.test(f)) {
                unlinkSync(join(CLAWMONEY_DIR, f));
              }
            }
            console.log(`  ✓ cleared all capture-codex-* files (OAuth tokens scrubbed)`);
          } catch {}
        }
      } catch (err) {
        console.error(`  ✗ fingerprint extraction failed: ${err.message}`);
      }
    }

    // Proxy to real upstream.
    (async () => {
      try {
        const upstreamHeaders = {
          ...cloneHeaders(req.headers),
          "host": "chatgpt.com",
        };

        console.log(`  → proxying to ${upstreamURL}`);
        const upstreamResp = await undiciFetch(upstreamURL, {
          method: req.method,
          headers: upstreamHeaders,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuf,
          dispatcher: upstreamDispatcher,
        });
        console.log(`  ← upstream ${upstreamResp.status}`);

        // Strip decompression headers — undici transparently decodes gzip/br.
        const respHeaders = {};
        upstreamResp.headers.forEach((v, k) => {
          const lower = k.toLowerCase();
          if (["content-encoding", "content-length", "transfer-encoding"].includes(lower)) return;
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
        console.error("  ✗ upstream error:", err.message);
        res.writeHead(502);
        res.end(`upstream error: ${err.message}`);
      }
    })();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`━━━ Codex Request Capture ━━━`);
  console.log(`Listening on http://127.0.0.1:${PORT}`);
  console.log(`Output dir: ${CLAWMONEY_DIR}`);
  console.log(`\nIn another terminal, run ONE of:`);
  console.log(`\n  Option A (env var — works if Codex CLI honors OPENAI_BASE_URL):`);
  console.log(`    OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1 codex exec "hi"`);
  console.log(`\n  Option B (config.toml — always works):`);
  console.log(`    echo 'openai_base_url = "http://127.0.0.1:${PORT}/v1"' >> ~/.codex/config.toml`);
  console.log(`    codex exec "hi"`);
  console.log(`    # then remove that line from ~/.codex/config.toml`);
  console.log(`\n(Press Ctrl+C to stop)\n`);
});
