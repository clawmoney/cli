#!/usr/bin/env node
// Validate that a locally-logged-in Claude Code OAuth token can be used to
// call api.anthropic.com directly with the exact headers + body shape Claude
// Code sends (captured from claude-cli/2.1.100 via ANTHROPIC_LOG=debug).
//
// Usage:
//   node scripts/probe-claude-api.mjs                    # send test request
//   node scripts/probe-claude-api.mjs --refresh          # force refresh first
//   node scripts/probe-claude-api.mjs --prompt "hello"
//   node scripts/probe-claude-api.mjs --model claude-sonnet-4-5

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { ProxyAgent, setGlobalDispatcher } from "undici";

// If the shell has https_proxy / http_proxy / all_proxy set (e.g. for users
// behind a GFW-style egress), honor it. Node's native fetch does NOT read
// these env vars by default — we have to plumb it through undici explicitly.
const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy;
if (proxyUrl) {
  // ProxyAgent only speaks HTTP CONNECT, not SOCKS.
  if (/^https?:\/\//.test(proxyUrl)) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
    console.log(`[proxy] using HTTP proxy ${proxyUrl}`);
  } else {
    console.warn(`[proxy] ignoring non-HTTP proxy ${proxyUrl} (SOCKS not supported by undici)`);
  }
}

// ── Constants ──

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

// /v1/messages?beta=true — the trailing query is what Claude Code actually sends.
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages?beta=true";

const KEYCHAIN_SERVICE = "Claude Code-credentials";

const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_FILE = join(CLAWMONEY_DIR, "claude-fingerprint.json");

// Fingerprint captured from claude-cli/2.1.100 on macOS.
const CLI_VERSION = "2.1.100";
const CLI_VERSION_SUFFIX = "2.1.100.f22"; // billing header token

const CLAUDE_CODE_HEADERS = {
  "accept": "application/json",
  "x-stainless-retry-count": "0",
  "x-stainless-timeout": "600",
  "x-stainless-lang": "js",
  "x-stainless-package-version": "0.81.0",
  "x-stainless-os": "MacOS",
  "x-stainless-arch": "arm64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v25.2.1",
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-version": "2023-06-01",
  "x-app": "cli",
  "user-agent": `claude-cli/${CLI_VERSION} (external, cli)`,
  "content-type": "application/json",
  "anthropic-beta":
    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
};

// Agent-SDK-style system prompt — matches what modern Claude Code (>= 2.1.x)
// actually sends. The first marker line matches claudeCodeSystemPrompts template
// #2 in sub2api's validator.
const CLAUDE_CODE_SYSTEM_PROMPT_LEAD =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const RELAY_INSTRUCTIONS =
  "You are operating in pure-LLM relay mode. Respond to the user's message with plain text only. Do not use tools. Do not ask clarifying questions. Be concise.";

const MODEL_ID_OVERRIDES = {
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

function normalizeModel(model) {
  return MODEL_ID_OVERRIDES[model] ?? model;
}

// ── Fingerprint (device_id + account_uuid) ──

function loadFingerprint() {
  if (!existsSync(FINGERPRINT_FILE)) {
    throw new Error(
      `Fingerprint not found at ${FINGERPRINT_FILE}. Run scripts/capture-claude-request.mjs once against a real Claude CLI request to bootstrap it.`
    );
  }
  const fp = JSON.parse(readFileSync(FINGERPRINT_FILE, "utf-8"));
  if (!fp.device_id || !fp.account_uuid) {
    throw new Error(`Fingerprint file missing device_id/account_uuid`);
  }
  return fp;
}

function buildMetadataUserID(fingerprint, sessionId) {
  // Claude Code >= 2.1.78 uses JSON-encoded user_id.
  return JSON.stringify({
    device_id: fingerprint.device_id,
    account_uuid: fingerprint.account_uuid,
    session_id: sessionId,
  });
}

// ── Credential I/O ──

function readCredentialsFromKeychain() {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
      .toString()
      .trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readCredentialsFromFile() {
  const path = join(homedir(), ".claude", ".credentials.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function loadClaudeOAuth() {
  const fromKeychain = readCredentialsFromKeychain();
  const fromFile = fromKeychain ? null : readCredentialsFromFile();
  const raw = fromKeychain ?? fromFile;
  if (!raw) {
    throw new Error(
      "Claude Code credentials not found. Run `claude` to log in first."
    );
  }
  const oauth = raw.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error("Credentials file missing claudeAiOauth.accessToken");
  }
  return {
    source: fromKeychain ? "keychain" : "file",
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes ?? [],
    subscriptionType: oauth.subscriptionType ?? "unknown",
    rateLimitTier: oauth.rateLimitTier ?? "unknown",
    _rawWrapper: raw,
  };
}

function writeCredentialsToKeychain(wrapper) {
  if (process.platform !== "darwin") {
    throw new Error("Keychain write is only supported on macOS");
  }
  const account = userInfo().username;
  const json = JSON.stringify(wrapper);
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s", KEYCHAIN_SERVICE,
      "-a", account,
      "-w", json,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

// ── OAuth refresh ──

async function refreshToken(refreshTokenStr) {
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json",
      "user-agent": "axios/1.13.6",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshTokenStr,
      client_id: OAUTH_CLIENT_ID,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token refresh failed: ${resp.status} ${body.slice(0, 300)}`);
  }

  const data = await resp.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshTokenStr,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: (data.scope ?? "").split(" ").filter(Boolean),
  };
}

async function refreshAndPersist(creds) {
  console.log("\n→ Refreshing OAuth token...");
  const fresh = await refreshToken(creds.refreshToken);
  const wrapper = creds._rawWrapper;
  wrapper.claudeAiOauth = {
    ...wrapper.claudeAiOauth,
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    expiresAt: fresh.expiresAt,
    scopes: fresh.scopes.length > 0 ? fresh.scopes : wrapper.claudeAiOauth.scopes,
  };
  if (creds.source === "keychain") {
    writeCredentialsToKeychain(wrapper);
    console.log("✓ Keychain updated");
  } else {
    console.warn("⚠ Token refreshed but not persisted (credentials came from file)");
  }
  return {
    ...creds,
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    expiresAt: fresh.expiresAt,
    _rawWrapper: wrapper,
  };
}

// ── API call ──

async function callAnthropic(creds, fingerprint, prompt, model, maxTokens = 1024) {
  const sessionId = randomUUID();

  const body = {
    model: normalizeModel(model),
    max_tokens: maxTokens,
    system: [
      {
        type: "text",
        text: `x-anthropic-billing-header: cc_version=${CLI_VERSION_SUFFIX}; cc_entrypoint=cli; cch=00000;`,
      },
      {
        type: "text",
        text: `${CLAUDE_CODE_SYSTEM_PROMPT_LEAD}\n\n${RELAY_INSTRUCTIONS}`,
      },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    ],
    metadata: {
      user_id: buildMetadataUserID(fingerprint, sessionId),
    },
    stream: false,
  };

  const resp = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      ...CLAUDE_CODE_HEADERS,
      "authorization": `Bearer ${creds.accessToken}`,
      "x-claude-code-session-id": sessionId,
    },
    body: JSON.stringify(body),
  });

  return { status: resp.status, ok: resp.ok, data: await resp.text(), sessionId };
}

// ── Main ──

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    forceRefresh: args.includes("--refresh"),
    prompt: "Reply with the single word: ok",
    model: "claude-sonnet-4-5",
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prompt" && args[i + 1]) { out.prompt = args[i + 1]; i++; }
    if (args[i] === "--model" && args[i + 1]) { out.model = args[i + 1]; i++; }
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  console.log("━━━ Claude Code API Probe ━━━\n");

  const fingerprint = loadFingerprint();
  console.log(`Fingerprint:       ${FINGERPRINT_FILE}`);
  console.log(`  device_id:       ${fingerprint.device_id.slice(0, 16)}...`);
  console.log(`  account_uuid:    ${fingerprint.account_uuid}`);
  console.log();

  let creds;
  try {
    creds = loadClaudeOAuth();
  } catch (err) {
    console.error("✗", err.message);
    process.exit(1);
  }

  const expiresInMs = creds.expiresAt - Date.now();
  const expiresInMin = Math.round(expiresInMs / 60000);
  console.log(`Source:            ${creds.source}`);
  console.log(`Subscription:      ${creds.subscriptionType} (${creds.rateLimitTier})`);
  console.log(`Token:             ${creds.accessToken.slice(0, 20)}...${creds.accessToken.slice(-6)}`);
  console.log(`Expires:           ${new Date(creds.expiresAt).toISOString()} (${expiresInMin} min)`);
  console.log();

  const needsRefresh = opts.forceRefresh || expiresInMs < 3 * 60_000;
  if (needsRefresh) {
    try {
      creds = await refreshAndPersist(creds);
      const freshMin = Math.round((creds.expiresAt - Date.now()) / 60000);
      console.log(`New expiry:        ${new Date(creds.expiresAt).toISOString()} (${freshMin} min)`);
    } catch (err) {
      console.error("✗ Refresh failed:", err.message);
      process.exit(1);
    }
  }

  console.log(`\n→ POST ${ANTHROPIC_API_URL}`);
  console.log(`  model:    ${normalizeModel(opts.model)}`);
  console.log(`  prompt:   ${opts.prompt}`);

  const t0 = Date.now();
  let result = await callAnthropic(creds, fingerprint, opts.prompt, opts.model);
  const elapsedMs = Date.now() - t0;
  console.log(`  session:  ${result.sessionId}`);
  console.log(`\n← HTTP ${result.status} (${elapsedMs}ms)`);

  if (result.status === 401 && !opts.forceRefresh) {
    console.log("\n→ Got 401, retrying with a fresh token...");
    try {
      creds = await refreshAndPersist(creds);
    } catch (err) {
      console.error("✗ Refresh failed:", err.message);
      process.exit(1);
    }
    result = await callAnthropic(creds, fingerprint, opts.prompt, opts.model);
    console.log(`← HTTP ${result.status}`);
  }

  if (!result.ok) {
    console.error("\n✗ Request failed");
    console.error(result.data.slice(0, 1200));
    process.exit(1);
  }

  try {
    const json = JSON.parse(result.data);
    const text = (json.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    console.log("\n--- Response ---");
    console.log(`model:   ${json.model}`);
    console.log(`stop:    ${json.stop_reason}`);
    console.log(
      `usage:   input=${json.usage?.input_tokens} output=${json.usage?.output_tokens} cache_read=${json.usage?.cache_read_input_tokens ?? 0} cache_write=${json.usage?.cache_creation_input_tokens ?? 0}`
    );
    console.log(`text:    ${text}`);
    console.log(
      "\n✓ SUCCESS — local OAuth token works against Anthropic API with Claude Code fingerprint."
    );
  } catch {
    console.log(result.data.slice(0, 2000));
  }
}

main().catch((err) => {
  console.error("✗ Unexpected error:", err);
  process.exit(1);
});
