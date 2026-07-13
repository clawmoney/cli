import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const grok = await import(process.env.GROK_API_TEST_MODULE);

function makeFixture({ expired = false, flatCache = false, missingCache = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "grok-api-fixture-"));
  mkdirSync(join(home, "bin"), { recursive: true });
  const binary = join(home, "bin", "grok");
  writeFileSync(binary, "#!/bin/sh\nexit 99\n");
  chmodSync(binary, 0o755);
  writeAuth(home, "old-access", expired ? Date.now() - 1_000 : Date.now() + 3_600_000);
  if (!missingCache) writeModelCache(home, flatCache);
  return { home, binary };
}

function writeModelCache(home, flatCache = false) {
  const info = {
    id: "grok-4.5",
    model: "grok-4.5",
    base_url: "https://cli-chat-proxy.grok.com/v1",
    api_backend: "responses",
    auth_scheme: "bearer",
    supported_in_api: true,
  };
  writeFileSync(
    join(home, "models_cache.json"),
    JSON.stringify(
      flatCache ? info : { models: { "grok-4.5": { info } } }
    )
  );
}

function writeAuth(home, key, expiresAt) {
  const path = join(home, "auth.json");
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // first write
  }
  const source = "https://auth.x.ai::test-account";
  const prior = existing[source] ?? {};
  writeFileSync(
    path,
    JSON.stringify({
      ...existing,
      [source]: {
        ...prior,
        key,
        expires_at: new Date(expiresAt).toISOString(),
        refresh_token: prior.refresh_token ?? "official-cli-only",
      },
    })
  );
}

async function withFixture(options, fn) {
  const fixture = makeFixture(options);
  try {
    grok.__resetGrokApiForTests();
    await fn(fixture);
  } finally {
    grok.__resetGrokApiForTests();
    rmSync(fixture.home, { recursive: true, force: true });
  }
}

test("template mode parses non-streaming usage with a partial RateGuard config", { timeout: 1_000 }, async () => {
  await withFixture({}, async ({ home, binary }) => {
    let captured;
    grok.__setGrokApiTestHooks({
      grokHome: home,
      fetch: async (url, init) => {
        captured = { url: String(url), init };
        return new Response(
          JSON.stringify({
            id: "resp-json",
            model: "grok-4.5",
            output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
            usage: {
              input_tokens: 20,
              output_tokens: 3,
              cache_creation_input_tokens: 2,
              input_tokens_details: { cached_tokens: 5 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });

    const state = grok.inspectGrokLocalState();
    assert.equal(state.available, true);
    assert.equal(state.binaryPath, binary);
    // setup normally persists only max_relay_utilization. Undefined fields
    // must not overwrite RateGuard defaults and crash/queue the first call.
    grok.configureGrokRateGuard({ max_relay_utilization: 50 });
    const result = await grok.callGrokApi({
      prompt: "say hello",
      model: "grok-4.5",
      maxTokens: 123,
      stream: false,
    });

    assert.equal(captured.url, "https://cli-chat-proxy.grok.com/v1/responses");
    assert.equal(captured.init.headers.authorization, "Bearer old-access");
    assert.equal(captured.init.signal instanceof AbortSignal, true);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.input[0].content[0].text, "say hello");
    assert.equal(body.max_output_tokens, 123);
    assert.equal(body.stream, false);
    assert.equal(body.store, false);
    assert.equal(body.background, false);
    assert.equal(result.text, "hello");
    assert.deepEqual(result.usage, {
      input_tokens: 13,
      output_tokens: 3,
      cache_creation_tokens: 2,
      cache_read_tokens: 5,
    });
    assert.ok(Math.abs(result.costUsd - 0.0000505) < 1e-12);
  });
});

test("passthrough mode preserves Responses fields and forwards SSE frames", async () => {
  await withFixture({}, async ({ home }) => {
    const forwarded = [];
    let requestBody;
    const sse = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello "}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"world"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-sse","model":"grok-4.5","output":[{"content":[{"type":"output_text","text":"hello world"}]}],"usage":{"input_tokens":100,"output_tokens":4,"input_tokens_details":{"cached_tokens":10}}}}',
    ].join("\n\n") + "\n\n";
    grok.__setGrokApiTestHooks({
      grokHome: home,
      fetch: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const result = await grok.callGrokApi({
      model: "grok-4.5",
      passthroughBody: {
        model: "buyer-cannot-override",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        instructions: "keep this",
        tools: [{ type: "function", name: "demo" }],
        stream: true,
        store: true,
      },
      onRawEvent: (frame) => forwarded.push(frame),
    });

    assert.equal(requestBody.model, "grok-4.5");
    assert.equal(requestBody.instructions, "keep this");
    assert.equal(requestBody.tools[0].name, "demo");
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.background, false);
    assert.equal(result.text, "hello world");
    assert.equal(result.sessionId, "resp-sse");
    assert.equal(result.usage.input_tokens, 90);
    assert.equal(forwarded.length, 3);
    assert.match(forwarded[0], /response\.output_text\.delta/);
  });
});

test("expired cached auth delegates refresh to official grok models", async () => {
  await withFixture({ expired: true, flatCache: true }, async ({ home, binary }) => {
    let refreshCalls = 0;
    let authHeader;
    grok.__setGrokApiTestHooks({
      grokHome: home,
      runModels: async (resolvedBinary) => {
        assert.equal(resolvedBinary, binary);
        refreshCalls++;
        writeAuth(home, "fresh-access", Date.now() + 3_600_000);
      },
      fetch: async (url, init) => {
        assert.equal(String(url), "https://cli-chat-proxy.grok.com/v1/models");
        authHeader = init.headers.authorization;
        return new Response('{"data":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const before = grok.inspectGrokLocalState();
    assert.equal(before.available, true);
    assert.equal(before.authPresent, true);
    assert.equal(before.authFresh, false);
    await grok.preflightGrokApi();
    assert.equal(refreshCalls, 1);
    assert.equal(authHeader, "Bearer fresh-access");
    const persisted = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    assert.equal(
      persisted["https://auth.x.ai::test-account"].refresh_token,
      "official-cli-only"
    );
  });
});

test("missing model cache is selectable and bootstrapped by official grok models", async () => {
  await withFixture({ missingCache: true }, async ({ home, binary }) => {
    let refreshCalls = 0;
    grok.__setGrokApiTestHooks({
      grokHome: home,
      runModels: async (resolvedBinary) => {
        assert.equal(resolvedBinary, binary);
        refreshCalls++;
        writeModelCache(home);
      },
      fetch: async (url) => {
        assert.equal(String(url), "https://cli-chat-proxy.grok.com/v1/models");
        return new Response('{"data":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const before = grok.inspectGrokLocalState();
    assert.equal(before.available, true);
    assert.equal(before.modelCacheValid, false);
    await grok.preflightGrokApi();
    assert.equal(refreshCalls, 1);
    assert.equal(grok.inspectGrokLocalState().modelCacheValid, true);
  });
});

test("a 401 refreshes through the official CLI once and retries Responses", async () => {
  await withFixture({}, async ({ home }) => {
    let fetchCalls = 0;
    let refreshCalls = 0;
    const seenAuth = [];
    grok.__setGrokApiTestHooks({
      grokHome: home,
      runModels: async () => {
        refreshCalls++;
        writeAuth(home, "after-401", Date.now() + 3_600_000);
      },
      fetch: async (_url, init) => {
        fetchCalls++;
        seenAuth.push(init.headers.authorization);
        if (fetchCalls === 1) {
          return new Response('{"error":"expired"}', {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            id: "resp-retry",
            model: "grok-4.5",
            output_text: "recovered",
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
    });

    const result = await grok.callGrokApi({
      prompt: "retry me",
      model: "grok-4.5",
      stream: false,
    });
    assert.equal(result.text, "recovered");
    assert.equal(fetchCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.deepEqual(seenAuth, ["Bearer old-access", "Bearer after-401"]);
  });
});

test("unsafe or unpriced passthrough modes fail before any upstream fetch", async () => {
  await withFixture({}, async ({ home }) => {
    let fetchCalls = 0;
    grok.__setGrokApiTestHooks({
      grokHome: home,
      fetch: async () => {
        fetchCalls++;
        throw new Error("fetch should not run");
      },
    });
    grok.configureGrokRateGuard({ min_request_gap_ms: 0, jitter_ms: 0 });

    const base = { model: "grok-4.5", input: "hello" };
    await assert.rejects(
      grok.callGrokApi({
        model: "grok-4.5",
        passthroughBody: { ...base, background: true },
      }),
      /background Responses are not supported/
    );
    await assert.rejects(
      grok.callGrokApi({
        model: "grok-4.5",
        passthroughBody: { ...base, service_tier: "priority" },
      }),
      /priority service_tier/
    );
    await assert.rejects(
      grok.callGrokApi({
        model: "grok-4.5",
        passthroughBody: { ...base, previous_response_id: "resp_provider_private" },
      }),
      /stored response\/conversation continuation/
    );
    await assert.rejects(
      grok.callGrokApi({
        model: "grok-4.5",
        passthroughBody: { ...base, stream: true, tools: [{ type: "web_search" }] },
      }),
      /server-side tool "web_search" is disabled/
    );
    await assert.rejects(
      grok.callGrokApi({
        model: "grok-4.5",
        passthroughBody: {
          ...base,
          tools: [{ type: "function", name: "demo" }],
        },
      }),
      /function tools require stream:true/
    );
    assert.equal(fetchCalls, 0);
  });
});

test("SSE rejects truncated streams and malformed event JSON", async () => {
  await withFixture({}, async ({ home }) => {
    let fetchCalls = 0;
    grok.__setGrokApiTestHooks({
      grokHome: home,
      fetch: async () => {
        fetchCalls++;
        const body =
          fetchCalls === 1
            ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n'
            : "event: response.output_text.delta\ndata: {not-json}\n\n";
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    grok.configureGrokRateGuard({ min_request_gap_ms: 0, jitter_ms: 0 });

    await assert.rejects(
      grok.callGrokApi({
        prompt: "truncate",
        model: "grok-4.5",
        stream: true,
      }),
      /ended before response\.completed/
    );
    await assert.rejects(
      grok.callGrokApi({
        prompt: "bad json",
        model: "grok-4.5",
        stream: true,
      }),
      /stream contained invalid JSON/
    );
  });
});

test("a tampered model cache cannot redirect the bearer key off the official base URL", async () => {
  await withFixture({}, async ({ home }) => {
    const path = join(home, "models_cache.json");
    const cache = JSON.parse(readFileSync(path, "utf8"));
    cache.models["grok-4.5"].info.base_url = "https://attacker.example/v1";
    writeFileSync(path, JSON.stringify(cache));
    let fetchCalls = 0;
    grok.__setGrokApiTestHooks({
      grokHome: home,
      fetch: async () => {
        fetchCalls++;
        throw new Error("fetch should not run");
      },
    });
    grok.configureGrokRateGuard({ min_request_gap_ms: 0, jitter_ms: 0 });

    const state = grok.inspectGrokLocalState();
    assert.equal(state.available, false);
    assert.equal(state.modelCacheValid, false);
    await assert.rejects(
      grok.callGrokApi({ prompt: "do not leak", model: "grok-4.5" }),
      /must be exactly https:\/\/cli-chat-proxy\.grok\.com\/v1/
    );

    cache.models["grok-4.5"].info.base_url =
      "https://cli-chat-proxy.grok.com/v1/redirect?target=attacker#fragment";
    writeFileSync(path, JSON.stringify(cache));
    await assert.rejects(
      grok.callGrokApi({ prompt: "still do not leak", model: "grok-4.5" }),
      /must be exactly https:\/\/cli-chat-proxy\.grok\.com\/v1/
    );
    assert.equal(fetchCalls, 0);
  });
});
