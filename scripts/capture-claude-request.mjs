#!/usr/bin/env node
// Capture a real Claude Code request by running:
//   1. terminal A: node scripts/capture-claude-request.mjs
//   2. terminal B: ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude -p "hi"
//
// The server logs headers + body to a file so we can see exactly what the
// real CLI sends, then proxies the request to api.anthropic.com so Claude
// Code doesn't error out. All captured data is written to
// ~/.clawmoney/capture-<timestamp>.json.

import { createServer } from "node:http";
import { writeFileSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetch as undiciFetch, ProxyAgent } from "undici";

const PORT = 8787;
const FINGERPRINT_PATH = join(homedir(), ".clawmoney", "claude-fingerprint.json");

// Honor shell HTTPS_PROXY / http_proxy so we can reach api.anthropic.com from
// behind a GFW-style egress. Node's native fetch/https does not read these
// env vars automatically.
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
const OUT_DIR = join(homedir(), ".clawmoney");
mkdirSync(OUT_DIR, { recursive: true });

// Headers that must not be forwarded as-is (they refer to the inbound hop).
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

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const bodyBuf = Buffer.concat(chunks);
    const bodyText = bodyBuf.toString("utf-8");

    let parsedBody;
    try { parsedBody = JSON.parse(bodyText); } catch { parsedBody = bodyText; }

    const capture = {
      capturedAt: new Date().toISOString(),
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: parsedBody,
    };

    const ts = Date.now();
    const file = join(OUT_DIR, `capture-${ts}.json`);
    writeFileSync(file, JSON.stringify(capture, null, 2), "utf-8");
    console.log(`\n━━━ Captured ${req.method} ${req.url} ━━━`);
    console.log(`Wrote: ${file}`);
    console.log("Headers:");
    for (const [k, v] of Object.entries(req.headers)) {
      console.log(`  ${k}: ${String(v).slice(0, 120)}`);
    }
    if (parsedBody && typeof parsedBody === "object") {
      console.log("Body keys:", Object.keys(parsedBody).join(", "));
      if (parsedBody.metadata) {
        console.log("  metadata:", JSON.stringify(parsedBody.metadata));
      }
      if (Array.isArray(parsedBody.system)) {
        console.log(`  system[0].text (first 300):`, (parsedBody.system[0]?.text ?? "").slice(0, 300));
      }
      if (parsedBody.model) console.log("  model:", parsedBody.model);
    }

    // ── Auto-extract fingerprint from /v1/messages requests ──
    // We pull device_id, account_uuid, user_agent, cc_version, cc_entrypoint
    // straight out of this real Claude Code request and persist them so the
    // claude-api module can mimic THIS machine's exact fingerprint instead of
    // a hardcoded reference one.
    if (
      req.method === "POST" &&
      typeof req.url === "string" &&
      req.url.startsWith("/v1/messages") &&
      parsedBody && typeof parsedBody === "object"
    ) {
      try {
        const fp = extractFingerprint(parsedBody, req.headers);
        if (fp) {
          mkdirSync(join(homedir(), ".clawmoney"), { recursive: true });
          writeFileSync(FINGERPRINT_PATH, JSON.stringify(fp, null, 2), "utf-8");
          console.log(`\n  ✓ fingerprint written → ${FINGERPRINT_PATH}`);
          console.log(`    device_id:     ${fp.device_id.slice(0, 20)}...`);
          console.log(`    account_uuid:  ${fp.account_uuid}`);
          console.log(`    user_agent:    ${fp.user_agent}`);
          console.log(`    cc_version:    ${fp.cc_version}`);
          console.log(`    cc_entrypoint: ${fp.cc_entrypoint}`);

          // Auto-delete ALL capture files in the dir — the POST one contains
          // the OAuth bearer token; HEAD captures are harmless but noisy.
          try {
            for (const f of readdirSync(OUT_DIR)) {
              if (/^capture-\d+\.json$/.test(f)) {
                unlinkSync(join(OUT_DIR, f));
              }
            }
            console.log(`  ✓ cleared all capture files (OAuth tokens scrubbed)`);
          } catch {}
        }
      } catch (err) {
        console.error(`  ✗ fingerprint extraction failed: ${err.message}`);
      }
    }

    // Proxy to real API via undici so we can honor HTTPS_PROXY.
    (async () => {
      try {
        const upstreamHeaders = cloneHeaders(req.headers);
        const upstreamResp = await undiciFetch(
          `https://api.anthropic.com${req.url}`,
          {
            method: req.method,
            headers: upstreamHeaders,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyBuf,
            dispatcher: upstreamDispatcher,
          }
        );
        console.log(`  ← upstream ${upstreamResp.status}`);
        const respHeaders = {};
        // undici fetch transparently decompresses gzip/br responses, so the
        // body chunks we pipe back are plain text. We MUST strip the original
        // content-encoding / content-length headers before forwarding,
        // otherwise the downstream client tries to gunzip plaintext and
        // explodes with "ZlibError" / "decompression failed".
        upstreamResp.headers.forEach((v, k) => {
          const lower = k.toLowerCase();
          if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") return;
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

function extractFingerprint(body, headers) {
  // metadata.user_id is a JSON-encoded string ({device_id, account_uuid, session_id})
  const userIdRaw = body?.metadata?.user_id;
  if (typeof userIdRaw !== "string") return null;
  let userId;
  try {
    userId = JSON.parse(userIdRaw);
  } catch {
    return null;
  }
  if (!userId.device_id || !userId.account_uuid) return null;

  // user_agent comes straight off the inbound request headers.
  const ua = headers["user-agent"] || "";

  // system[0].text contains the billing header line, e.g.:
  //   "x-anthropic-billing-header: cc_version=2.1.100.c68; cc_entrypoint=sdk-cli; cch=00000;"
  let cc_version = "";
  let cc_entrypoint = "";
  if (Array.isArray(body.system)) {
    for (const entry of body.system) {
      const text = typeof entry === "string" ? entry : entry?.text;
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`━━━ Claude Code Request Capture ━━━`);
  console.log(`Listening on http://127.0.0.1:${PORT}`);
  console.log(`Output dir: ${OUT_DIR}`);
  console.log(`\nIn another terminal, run:`);
  console.log(`  ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} claude -p "hi"`);
  console.log(`\n(Press Ctrl+C to stop)\n`);
});
