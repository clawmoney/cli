#!/usr/bin/env node
// WebSocket-aware capture proxy for Codex CLI 0.118+.
//
// Codex CLI 0.118 migrated to a WebSocket-based Responses API:
//   GET /v1/responses HTTP/1.1
//   Connection: Upgrade
//   Upgrade: websocket
//   ...handshake headers + body frames...
//
// The old undici-fetch based capture proxy cannot handle Upgrade requests,
// so this rewrite uses Node's native http + net modules:
//   1. Listen on 127.0.0.1:8788 as a plain HTTP server.
//   2. On `upgrade` event, decode the handshake, open a raw TLS socket to
//      chatgpt.com:443, write a matching HTTP/1.1 Upgrade request onto it,
//      and tunnel raw frames in both directions.
//   3. Every frame (both directions) is unmasked and decoded as JSON. The
//      decoded objects + scrubbed handshake headers are appended to
//      ~/.clawmoney/capture-codex-<ts>-<dir>.json.
//   4. After the first upgrade succeeds, we extract a minimal fingerprint
//      (cli version, originator, openai-beta) to
//      ~/.clawmoney/codex-fingerprint.json.
//   5. On clean shutdown (SIGINT/SIGTERM) ALL capture files for this run
//      are deleted — they contain OAuth Bearer tokens and chatgpt-account-id.
//
// Usage:
//   1. terminal A:
//        https_proxy=http://127.0.0.1:7890 node scripts/capture-codex-request.mjs
//   2. terminal B:
//        OPENAI_BASE_URL=http://127.0.0.1:8788/v1 \
//          NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
//          https_proxy=http://127.0.0.1:7890 \
//          codex exec --skip-git-repo-check "say ok"

import { createServer } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";
import { writeFileSync, mkdirSync, unlinkSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { URL } from "node:url";

const PORT = 8788;
const UPSTREAM_HOST = "chatgpt.com";
const UPSTREAM_PORT = 443;
const UPSTREAM_PATH = "/backend-api/codex/responses";

const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_PATH = join(CLAWMONEY_DIR, "codex-fingerprint.json");

mkdirSync(CLAWMONEY_DIR, { recursive: true });

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;
if (proxyUrl) {
  console.log(`[proxy] upstream tunnels via ${proxyUrl}`);
}

// Open a TLS socket to UPSTREAM_HOST, optionally via an HTTP CONNECT proxy.
function openUpstreamSocket() {
  return new Promise((resolve, reject) => {
    const done = (err, sock) => (err ? reject(err) : resolve(sock));
    if (proxyUrl && /^https?:\/\//.test(proxyUrl)) {
      const parsed = new URL(proxyUrl);
      const tcp = netConnect(Number(parsed.port) || 80, parsed.hostname, () => {
        tcp.write(`CONNECT ${UPSTREAM_HOST}:${UPSTREAM_PORT} HTTP/1.1\r\nHost: ${UPSTREAM_HOST}:${UPSTREAM_PORT}\r\n\r\n`);
      });
      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString("utf-8");
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        tcp.off("data", onData);
        const statusLine = buf.split("\r\n", 1)[0] ?? "";
        if (!/^HTTP\/\d\.\d\s+200/.test(statusLine)) {
          tcp.destroy();
          done(new Error(`proxy CONNECT failed: ${statusLine}`));
          return;
        }
        const tls = tlsConnect({
          socket: tcp,
          servername: UPSTREAM_HOST,
          host: UPSTREAM_HOST,
          port: UPSTREAM_PORT,
          ALPNProtocols: ["http/1.1"],
        }, () => done(null, tls));
        tls.on("error", (err) => done(err));
      };
      tcp.on("data", onData);
      tcp.on("error", (err) => done(err));
    } else {
      const tls = tlsConnect({
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        servername: UPSTREAM_HOST,
        ALPNProtocols: ["http/1.1"],
      }, () => done(null, tls));
      tls.on("error", (err) => done(err));
    }
  });
}

// --- Frame codec (minimal, client → server is always masked; server → client
// is never masked per RFC 6455) ---
//
// We buffer bytes as they arrive and decode one frame at a time. Each decoded
// frame is fed to a sink which logs it.

function createFrameDecoder(direction, onFrame) {
  let buffer = Buffer.alloc(0);
  let fragPayloads = [];
  let fragOpcode = 0;

  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const b1 = buffer[0];
      const b2 = buffer[1];
      const fin = (b1 & 0x80) !== 0;
      const opcode = b1 & 0x0f;
      const masked = (b2 & 0x80) !== 0;
      let len = b2 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < offset + 2) return;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) return;
        // JavaScript numbers can represent up to 2^53; realistic frames are <64KB.
        const hi = buffer.readUInt32BE(offset);
        const lo = buffer.readUInt32BE(offset + 4);
        len = hi * 2 ** 32 + lo;
        offset += 8;
      }
      let mask;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + len) return;
      let payload = buffer.subarray(offset, offset + len);
      if (masked && mask) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + len);

      // Continuation frame handling.
      if (opcode === 0x0) {
        fragPayloads.push(payload);
        if (fin) {
          const full = Buffer.concat(fragPayloads);
          emit(fragOpcode, full);
          fragPayloads = [];
          fragOpcode = 0;
        }
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          emit(opcode, payload);
        } else {
          fragOpcode = opcode;
          fragPayloads = [payload];
        }
        continue;
      }

      // Control frames (ping / pong / close). Just surface the type.
      if (opcode === 0x8) {
        onFrame({ direction, type: "close", payload: payload.toString("utf-8") });
        return;
      }
      if (opcode === 0x9) {
        onFrame({ direction, type: "ping" });
        continue;
      }
      if (opcode === 0xa) {
        onFrame({ direction, type: "pong" });
        continue;
      }
    }
  };

  function emit(op, payload) {
    const textual = op === 0x1;
    const raw = payload.toString("utf-8");
    let parsed;
    if (textual) {
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
    } else {
      parsed = `<binary ${payload.length}B>`;
    }
    onFrame({ direction, type: textual ? "text" : "binary", data: parsed, rawLen: payload.length });
  }
}

// --- Capture session ---
//
// One per upgrade request. Owns a capture file and the two frame decoders.

const runTimestamp = Date.now();
const createdFiles = [];
let fingerprintWritten = false;

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === "authorization") {
      out[k] = "Bearer <redacted>";
    } else if (lower === "chatgpt-account-id") {
      out[k] = "<redacted:uuid>";
    } else if (lower === "session_id" || lower === "conversation_id" || lower === "x-client-request-id") {
      out[k] = "<redacted:uuid>";
    } else if (lower === "x-codex-turn-metadata") {
      out[k] = "<redacted:json>";
    } else {
      out[k] = Array.isArray(v) ? v.join(", ") : v;
    }
  }
  return out;
}

function redactBodyObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(clone)) {
    const lower = key.toLowerCase();
    if (lower === "session_id" || lower === "conversation_id" || lower === "turn_id" || lower === "response_id") {
      clone[key] = "<redacted:uuid>";
      continue;
    }
    if (typeof clone[key] === "object" && clone[key] !== null) {
      clone[key] = redactBodyObject(clone[key]);
    }
  }
  return clone;
}

function openCaptureFile(label) {
  const path = join(CLAWMONEY_DIR, `capture-codex-${runTimestamp}-${label}.json`);
  createdFiles.push(path);
  return path;
}

function scrubCaptures() {
  for (const f of createdFiles) {
    try { unlinkSync(f); } catch {}
  }
  // Also scrub any stragglers from a prior run.
  try {
    for (const f of readdirSync(CLAWMONEY_DIR)) {
      if (/^capture-codex-.*\.json$/.test(f)) {
        try { unlinkSync(join(CLAWMONEY_DIR, f)); } catch {}
      }
    }
  } catch {}
}

function maybeWriteFingerprint(handshakeHeaders) {
  if (fingerprintWritten) return;
  const version = handshakeHeaders["version"] || handshakeHeaders["Version"] || "";
  const originator = handshakeHeaders["originator"] || "";
  const openaiBeta = handshakeHeaders["openai-beta"] || handshakeHeaders["OpenAI-Beta"] || "";
  const ua = handshakeHeaders["user-agent"] || "";
  if (!version && !originator) return;
  const fp = {
    user_agent: ua,
    cli_version: version || "0.118.0",
    originator: originator || "codex_exec",
    openai_beta: openaiBeta || "responses_websockets=2026-02-06",
  };
  writeFileSync(FINGERPRINT_PATH, JSON.stringify(fp, null, 2), "utf-8");
  fingerprintWritten = true;
  console.log(`\n  [ok] fingerprint written -> ${FINGERPRINT_PATH}`);
  console.log(`    cli_version: ${fp.cli_version}`);
  console.log(`    originator:  ${fp.originator}`);
  console.log(`    openai_beta: ${fp.openai_beta}`);
}

// --- HTTP server with Upgrade handling ---

const server = createServer((req, res) => {
  // Non-upgrade hits: return a friendly 400 so codex sees a real error.
  console.log(`[http] ${req.method} ${req.url} — non-upgrade, rejecting`);
  res.writeHead(400, { "content-type": "text/plain" });
  res.end("capture-codex-request: only WebSocket upgrades are supported on this port\n");
});

server.on("upgrade", async (req, clientSocket, head) => {
  console.log(`\n[upgrade] ${req.method} ${req.url}`);
  const capturePath = openCaptureFile("handshake");
  const capture = {
    capturedAt: new Date().toISOString(),
    method: req.method,
    path: req.url,
    // Handshake headers scrubbed of sensitive values.
    requestHeaders: redactHeaders(req.headers),
    upstreamPath: UPSTREAM_PATH,
    frames: [],
  };
  writeFileSync(capturePath, JSON.stringify(capture, null, 2), "utf-8");

  maybeWriteFingerprint(req.headers);

  // Build the upstream upgrade request preserving all headers, only rewriting
  // the request-line path to the real codex endpoint.
  let upstreamSocket;
  try {
    upstreamSocket = await openUpstreamSocket();
  } catch (err) {
    console.error(`[upgrade] failed to reach upstream: ${err.message}`);
    clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\nupstream dial failed: ${err.message}`);
    return;
  }

  const headerLines = [`GET ${UPSTREAM_PATH} HTTP/1.1`];
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === "host") continue;
    headerLines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  headerLines.push(`Host: ${UPSTREAM_HOST}`);
  const upstreamRequest = headerLines.join("\r\n") + "\r\n\r\n";
  upstreamSocket.write(upstreamRequest);

  // Read the upstream HTTP response until we see \r\n\r\n, then forward the
  // raw bytes (which include 101 Switching Protocols) to the client.
  let headerBuf = Buffer.alloc(0);
  let upgraded = false;
  const persistFrames = () => {
    writeFileSync(capturePath, JSON.stringify(capture, null, 2), "utf-8");
  };

  const recordFrame = (frame) => {
    const redacted = { ...frame };
    if (frame.data && typeof frame.data === "object") {
      redacted.data = redactBodyObject(frame.data);
    }
    capture.frames.push({ t: Date.now(), ...redacted });
    persistFrames();
  };

  const clientFrameDecoder = createFrameDecoder("client->server", (f) => {
    console.log(`  [c->s] ${f.type}${f.type === "text" && f.data && f.data.type ? ` type=${f.data.type}` : ""}`);
    recordFrame(f);
  });
  const serverFrameDecoder = createFrameDecoder("server->client", (f) => {
    console.log(`  [s->c] ${f.type}${f.type === "text" && f.data && f.data.type ? ` type=${f.data.type}` : ""}`);
    recordFrame(f);
  });

  upstreamSocket.on("data", (chunk) => {
    if (!upgraded) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const end = headerBuf.indexOf("\r\n\r\n");
      if (end !== -1) {
        const headerPart = headerBuf.subarray(0, end + 4);
        const statusLine = headerPart.toString("utf-8").split("\r\n", 1)[0] ?? "";
        console.log(`[upgrade] upstream: ${statusLine}`);
        capture.upstreamStatusLine = statusLine;
        // Forward headers verbatim to client.
        clientSocket.write(headerPart);
        const leftover = headerBuf.subarray(end + 4);
        upgraded = true;
        if (leftover.length > 0) {
          clientSocket.write(leftover);
          serverFrameDecoder(leftover);
        }
        persistFrames();
        return;
      }
      return;
    }
    clientSocket.write(chunk);
    serverFrameDecoder(chunk);
  });

  clientSocket.on("data", (chunk) => {
    upstreamSocket.write(chunk);
    clientFrameDecoder(chunk);
  });

  // If the upgrade request had pre-buffered head (body bytes arriving with
  // the upgrade header), forward them.
  if (head && head.length > 0) {
    upstreamSocket.write(head);
    clientFrameDecoder(head);
  }

  const teardown = () => {
    try { clientSocket.destroy(); } catch {}
    try { upstreamSocket.destroy(); } catch {}
    persistFrames();
  };
  clientSocket.on("close", teardown);
  clientSocket.on("error", (err) => { console.error(`[client] ${err.message}`); teardown(); });
  upstreamSocket.on("close", teardown);
  upstreamSocket.on("error", (err) => { console.error(`[upstream] ${err.message}`); teardown(); });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`--- Codex WebSocket Capture ---`);
  console.log(`Listening on http://127.0.0.1:${PORT}`);
  console.log(`Upstream:    wss://${UPSTREAM_HOST}${UPSTREAM_PATH}`);
  console.log(`Fingerprint: ${FINGERPRINT_PATH}`);
  console.log(``);
  console.log(`In another terminal run:`);
  console.log(`  OPENAI_BASE_URL=http://127.0.0.1:${PORT}/v1 \\`);
  console.log(`    NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \\`);
  console.log(`    https_proxy=\${https_proxy} \\`);
  console.log(`    codex exec --skip-git-repo-check "say ok"`);
  console.log(``);
  console.log(`(Press Ctrl+C to stop and scrub capture files)`);
});

function shutdown() {
  console.log(`\n[shutdown] scrubbing ${createdFiles.length} capture file(s)`);
  scrubCaptures();
  server.close(() => process.exit(0));
  // Safety net — hard-exit if close hangs.
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
