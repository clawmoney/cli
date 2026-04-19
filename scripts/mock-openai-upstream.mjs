#!/usr/bin/env node
/**
 * Mock OpenAI-compatible upstream for testing passthrough + minimax adapters.
 *
 * Listens on 127.0.0.1:9099 (override with MOCK_PORT). Implements just
 * enough of the surface the adapters touch to verify our SSE parsing,
 * Bearer-header plumbing, and MiniMax OAuth refresh.
 *
 * Endpoints:
 *   POST /v1/chat/completions   — streams canned SSE frames back.
 *                                  Echoes `Authorization` + `body.model` into
 *                                  the 4 recorded exchanges so probe-relay-call
 *                                  can assert on them.
 *   POST /oauth/token           — fake MiniMax refresh. Returns a rotated
 *                                  access/refresh pair with 1h ttl.
 *   GET  /__recorded             — returns the in-memory log of requests.
 *                                  Probe uses it to confirm each adapter
 *                                  forwarded the expected Bearer / body.
 *
 * No SIGINT handling fuss — probe script kills it.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 9099);

// In-memory record of every request we saw. `GET /__recorded` returns it.
// Cleared by `DELETE /__recorded`.
const recorded = [];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function writeSse(res, frames) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function buildChatStreamFrames({ model, text, inputTokens, outputTokens, cachedTokens = 0 }) {
  const id = `chatcmpl-mock-${Math.random().toString(36).slice(2, 10)}`;
  const frames = [
    { id, object: "chat.completion.chunk", model, choices: [{ delta: { role: "assistant" }, index: 0 }] },
  ];
  // Split the canned text into 3 delta frames so we exercise the
  // accumulator (one-shot completions would hide partial-frame bugs).
  const third = Math.max(1, Math.floor(text.length / 3));
  frames.push({ id, model, choices: [{ delta: { content: text.slice(0, third) }, index: 0 }] });
  frames.push({ id, model, choices: [{ delta: { content: text.slice(third, 2 * third) }, index: 0 }] });
  frames.push({ id, model, choices: [{ delta: { content: text.slice(2 * third) }, index: 0 }] });
  frames.push({ id, model, choices: [{ finish_reason: "stop", index: 0, delta: {} }] });
  frames.push({
    id,
    model,
    choices: [],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
    },
  });
  return frames;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/__recorded") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(recorded, null, 2));
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/__recorded") {
    recorded.length = 0;
    res.writeHead(204);
    res.end();
    return;
  }

  // Accept any path ending in /chat/completions — passthrough-api appends
  // /chat/completions to whatever baseUrl the spec provides (which already
  // contains /v1 or /api/paas/v4), while minimax-api appends /v1/chat/completions
  // to the bare OAuth resource_url.
  if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
    const raw = await readBody(req);
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {}
    recorded.push({
      kind: "chat",
      authorization: req.headers.authorization ?? null,
      model: body.model ?? null,
      stream: body.stream ?? null,
      hasMessages: Array.isArray(body.messages),
      firstMessage: Array.isArray(body.messages) ? body.messages[0] : null,
    });
    writeSse(
      res,
      buildChatStreamFrames({
        model: body.model ?? "mock-model",
        text: "mock reply: ok",
        inputTokens: 123,
        outputTokens: 45,
        cachedTokens: 7,
      })
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    const raw = await readBody(req);
    recorded.push({
      kind: "refresh",
      body: Object.fromEntries(new URLSearchParams(raw).entries()),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        access_token: `mock-at-${Date.now()}`,
        refresh_token: `mock-rt-${Date.now()}`,
        expires_in: 3600,
        resource_url: `http://127.0.0.1:${PORT}`,
      })
    );
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-upstream] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-upstream] endpoints: POST /v1/chat/completions, POST /oauth/token, GET /__recorded`);
});
