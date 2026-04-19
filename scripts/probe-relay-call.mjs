#!/usr/bin/env node
/**
 * End-to-end probe of every passthrough cli_type and the MiniMax adapter
 * against a local mock upstream. Run mock-openai-upstream.mjs first, then
 * this script.
 *
 * Coverage matrix — each probe row exercises one adapter + one code path:
 *
 *   cli_type      credential path         upstream  assertion
 *   ─────────────────────────────────────────────────────────
 *   zai-coding    openclaw api_key         mock      text/usage/cost OK
 *   zai           env var                  mock      text/usage/cost OK
 *   moonshot      env var                  mock      text/usage/cost OK
 *   kimi-coding   env var                  mock      text/usage/cost OK
 *   qwen-coding   env var                  mock      text/usage/cost OK
 *   openai        env var                  mock      text/usage/cost OK
 *   minimax       openclaw oauth (fresh)   mock      text/usage/cost OK, no refresh
 *   minimax       openclaw oauth (expired) mock      refresh triggered, retry OK
 *
 * Exits 0 on full pass, non-zero with a summary on any failure.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const MOCK_PORT = Number(process.env.MOCK_PORT ?? 9099);
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;

// ─── Test HOME with fixture auth-profiles.json ────────────────────────────
// We set a throwaway HOME so openclaw-creds reads our fixture and only our
// fixture (no pollution from the operator's real openclaw install).

const TEST_HOME = join(tmpdir(), `clawmoney-probe-${Date.now()}`);
const AUTH_PROFILES_PATH = join(TEST_HOME, ".openclaw/agents/main/agent/auth-profiles.json");

function writeFixture({ minimaxExpiresAt }) {
  mkdirSync(join(TEST_HOME, ".openclaw/agents/main/agent"), { recursive: true });
  const fixture = {
    version: 1,
    profiles: {
      "zai:default": { type: "api_key", provider: "zai", key: "sk-zai-openclaw" },
      "minimax-portal:jacklee@example.com": {
        type: "oauth",
        provider: "minimax-portal",
        access: "AT_ORIGINAL",
        refresh: "RT_ORIGINAL",
        expires: minimaxExpiresAt,
        resourceUrl: MOCK_URL,
        email: "jacklee@example.com",
      },
    },
    lastGood: { "minimax-portal": "minimax-portal:jacklee@example.com" },
  };
  writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(fixture, null, 2));
}

// ─── Env baseline (gets mutated per-probe) ────────────────────────────────

process.env.HOME = TEST_HOME;
// Point every passthrough target at the mock; no real upstream contact.
process.env.ZAI_CODING_BASE_URL = MOCK_URL;
process.env.ZAI_BASE_URL = MOCK_URL;
process.env.MOONSHOT_BASE_URL = MOCK_URL;
process.env.KIMI_CODING_BASE_URL = MOCK_URL;
process.env.QWEN_CODING_BASE_URL = MOCK_URL;
process.env.OPENAI_BASE_URL = MOCK_URL;
// Remove any real HTTPS_PROXY so the undici dispatcher doesn't tunnel our
// loopback calls through a remote proxy.
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.NO_PROXY;
delete process.env.no_proxy;
// Env-var credentials for cli_types that deliberately have no openclaw
// fixture row — forces the adapter to fall back to env lookup.
process.env.MOONSHOT_API_KEY = "sk-moonshot-env";
process.env.KIMI_API_KEY = "sk-kimi-env";
process.env.BAILIAN_CODING_PLAN_API_KEY = "sk-qwen-env";
process.env.OPENAI_API_KEY = "sk-openai-env";
// NOTE: no ZAI_API_KEY set — we want zai to read the openclaw fixture.
delete process.env.ZAI_API_KEY;

// ─── Lazy imports after HOME + env are locked in ──────────────────────────

writeFixture({ minimaxExpiresAt: Date.now() + 60 * 60 * 1000 }); // fresh

const [
  { callPassthroughApi, getPassthroughSpec },
  { resolveSpecByModel, hubCliTypeFor },
  { callMinimaxApi },
] = await Promise.all([
  import("../dist/relay/upstream/passthrough-api.js"),
  import("../dist/relay/upstream/passthrough-specs.js"),
  import("../dist/relay/upstream/minimax-api.js"),
]);

// ─── Assertion helpers ────────────────────────────────────────────────────

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${name}${detail ? "  — " + detail : ""}`);
}

async function fetchRecorded() {
  const resp = await fetch(`${MOCK_URL}/__recorded`);
  return resp.json();
}
async function clearRecorded() {
  await fetch(`${MOCK_URL}/__recorded`, { method: "DELETE" });
}

function assertParsedOutput(parsed, expect) {
  const issues = [];
  if (!parsed.text.includes(expect.text)) issues.push(`text mismatch: got "${parsed.text.slice(0, 60)}"`);
  if (parsed.usage.input_tokens !== expect.inputTokens) {
    issues.push(`input_tokens: ${parsed.usage.input_tokens} != ${expect.inputTokens}`);
  }
  if (parsed.usage.output_tokens !== expect.outputTokens) {
    issues.push(`output_tokens: ${parsed.usage.output_tokens} != ${expect.outputTokens}`);
  }
  if (parsed.usage.cache_read_tokens !== expect.cachedTokens) {
    issues.push(`cache_read_tokens: ${parsed.usage.cache_read_tokens} != ${expect.cachedTokens}`);
  }
  if (!(parsed.costUsd >= 0)) issues.push(`costUsd non-positive: ${parsed.costUsd}`);
  return issues;
}

// Text frames from mock total 123 prompt + 45 completion + 7 cached.
// cache_read_tokens should be 7, input_tokens should be 123 - 7 = 116.
const EXPECTED_USAGE = { inputTokens: 116, outputTokens: 45, cachedTokens: 7 };

// ─── Probes ───────────────────────────────────────────────────────────────

async function probePassthrough(cliType, model, expectedKeyPrefix) {
  await clearRecorded();
  const parsed = await callPassthroughApi({
    cliType,
    prompt: "say ok",
    model,
    maxTokens: 100,
  });
  const rec = await fetchRecorded();
  const chatRows = rec.filter((r) => r.kind === "chat");
  const issues = assertParsedOutput(parsed, { text: "mock reply: ok", ...EXPECTED_USAGE });
  if (chatRows.length !== 1) issues.push(`expected 1 upstream call, saw ${chatRows.length}`);
  if (chatRows[0] && !chatRows[0].authorization?.startsWith(`Bearer ${expectedKeyPrefix}`)) {
    issues.push(`Bearer header: ${chatRows[0].authorization}`);
  }
  if (chatRows[0] && chatRows[0].model !== model) {
    issues.push(`upstream saw model=${chatRows[0].model}, expected ${model}`);
  }
  const baseUrl = getPassthroughSpec(cliType)?.baseUrl;
  record(`passthrough ${cliType}`, issues.length === 0, issues.length ? issues.join("; ") : `baseUrl=${baseUrl}`);
}

async function probeMinimaxFresh() {
  await clearRecorded();
  writeFixture({ minimaxExpiresAt: Date.now() + 60 * 60 * 1000 }); // 1h future
  // Force a re-read of the creds cache by re-importing with ?bust
  const mod = await import(`../dist/relay/upstream/minimax-api.js?fresh=${Date.now()}`);
  const parsed = await mod.callMinimaxApi({ prompt: "say ok", model: "MiniMax-M2.7" });
  const rec = await fetchRecorded();
  const chatRows = rec.filter((r) => r.kind === "chat");
  const refreshRows = rec.filter((r) => r.kind === "refresh");
  const issues = assertParsedOutput(parsed, { text: "mock reply: ok", ...EXPECTED_USAGE });
  if (chatRows.length !== 1) issues.push(`expected 1 chat call, saw ${chatRows.length}`);
  if (refreshRows.length !== 0) issues.push(`unexpected refresh: ${refreshRows.length}`);
  if (chatRows[0] && chatRows[0].authorization !== "Bearer AT_ORIGINAL") {
    issues.push(`Bearer should be AT_ORIGINAL, saw ${chatRows[0].authorization}`);
  }
  record("minimax (fresh token)", issues.length === 0, issues.length ? issues.join("; ") : null);
}

async function probeMinimaxExpired() {
  await clearRecorded();
  writeFixture({ minimaxExpiresAt: Date.now() - 1000 }); // already expired
  const mod = await import(`../dist/relay/upstream/minimax-api.js?expired=${Date.now()}`);
  const parsed = await mod.callMinimaxApi({ prompt: "say ok", model: "MiniMax-M2.7" });
  const rec = await fetchRecorded();
  const chatRows = rec.filter((r) => r.kind === "chat");
  const refreshRows = rec.filter((r) => r.kind === "refresh");
  const issues = assertParsedOutput(parsed, { text: "mock reply: ok", ...EXPECTED_USAGE });
  if (refreshRows.length !== 1) issues.push(`expected 1 refresh, saw ${refreshRows.length}`);
  if (refreshRows[0] && refreshRows[0].body?.grant_type !== "refresh_token") {
    issues.push(`refresh grant_type: ${refreshRows[0].body?.grant_type}`);
  }
  if (refreshRows[0] && refreshRows[0].body?.refresh_token !== "RT_ORIGINAL") {
    issues.push(`refresh_token sent: ${refreshRows[0].body?.refresh_token}`);
  }
  if (chatRows.length !== 1) issues.push(`expected 1 chat call after refresh, saw ${chatRows.length}`);
  if (chatRows[0] && !chatRows[0].authorization?.startsWith("Bearer mock-at-")) {
    issues.push(`chat Bearer after refresh: ${chatRows[0].authorization}`);
  }

  // Confirm the profile on disk was updated with the new tokens.
  const file = JSON.parse(readFileSync(AUTH_PROFILES_PATH, "utf-8"));
  const p = file.profiles["minimax-portal:jacklee@example.com"];
  if (!p.access?.startsWith("mock-at-")) issues.push(`profile.access not rotated: ${p.access}`);
  if (!p.refresh?.startsWith("mock-rt-")) issues.push(`profile.refresh not rotated: ${p.refresh}`);

  record("minimax (expired → refresh)", issues.length === 0, issues.length ? issues.join("; ") : null);
}

// ─── Run ──────────────────────────────────────────────────────────────────

console.log(`HOME=${TEST_HOME}`);
console.log(`mock upstream at ${MOCK_URL}`);
console.log("");

try {
  // openclaw fixture supplies zai's key via api_key profile
  await probePassthrough("zai-coding", "glm-5", "sk-zai-openclaw");
  await probePassthrough("zai", "glm-4.7", "sk-zai-openclaw");
  // others fall back to env
  await probePassthrough("moonshot", "kimi-k2.5", "sk-moonshot-env");
  await probePassthrough("kimi-coding", "kimi-code", "sk-kimi-env");
  await probePassthrough("qwen-coding", "qwen3.6-plus", "sk-qwen-env");
  await probePassthrough("openai", "gpt-5.4", "sk-openai-env");

  // minimax: fresh vs expired
  await probeMinimaxFresh();
  await probeMinimaxExpired();

  // api-key dispatch: Hub-canonical cli_type resolves to correct internal spec
  // via model prefix. Covers each family the resolver handles.
  const dispatchCases = [
    { model: "glm-5",         expected: "zai-coding" },
    { model: "kimi-k2.5",     expected: "moonshot" },
    { model: "kimi-code",     expected: "kimi-coding" },
    { model: "qwen3.6-plus",  expected: "qwen-coding" },
    { model: "MiniMax-M2.7",  expected: "minimax" },
    { model: "gpt-5.4",       expected: "openai" },
    { model: "o4-mini",       expected: "openai" },
    { model: "unknown-model", expected: null },
  ];
  let dispatchFails = 0;
  for (const { model, expected } of dispatchCases) {
    const got = resolveSpecByModel(model);
    const ok = got === expected;
    if (!ok) {
      dispatchFails++;
      console.log(`  FAIL  resolveSpecByModel(${model}) — got=${got} expected=${expected}`);
    }
  }
  record(
    "api-key model → spec resolver (8 cases)",
    dispatchFails === 0,
    dispatchFails === 0 ? null : `${dispatchFails} mismatched`
  );

  // hubCliTypeFor collapses fine-grained → "api-key" and leaves legacy OAuth
  // cli_types untouched.
  const collapseCases = [
    { internal: "zai-coding",  hub: "api-key" },
    { internal: "moonshot",    hub: "api-key" },
    { internal: "qwen-coding", hub: "api-key" },
    { internal: "openai",      hub: "api-key" },
    { internal: "minimax",     hub: "api-key" },
    { internal: "claude",      hub: "claude" },
    { internal: "codex",       hub: "codex" },
    { internal: "gemini",      hub: "gemini" },
    { internal: "antigravity", hub: "antigravity" },
  ];
  let collapseFails = 0;
  for (const { internal, hub } of collapseCases) {
    const got = hubCliTypeFor(internal);
    if (got !== hub) {
      collapseFails++;
      console.log(`  FAIL  hubCliTypeFor(${internal}) — got=${got} expected=${hub}`);
    }
  }
  record(
    "hub cli_type collapse (9 cases)",
    collapseFails === 0,
    collapseFails === 0 ? null : `${collapseFails} mismatched`
  );
} catch (err) {
  console.error("\nfatal:", err?.stack ?? err);
  process.exit(2);
}

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
