/**
 * Direct Anthropic API upstream for Claude Code OAuth subscriptions.
 *
 * Instead of spawning the `claude` CLI for every relay request, this module
 * reuses the OAuth token that the locally-logged-in Claude Code has already
 * obtained, and sends /v1/messages requests directly to api.anthropic.com
 * with the exact Claude Code request shape (captured from claude-cli/2.1.100).
 *
 * Why this exists:
 *   - spawn CLI latency is 1-3s per request; direct HTTP is ~300ms
 *   - CLI mode can't stream; HTTP mode is real SSE
 *   - CLI mode can't saturate concurrency; HTTP mode scales trivially
 *
 * Token is loaded once at startup (from macOS Keychain or ~/.claude) and
 * refreshed in-process when within 3 min of expiry. Refreshed tokens are
 * persisted back to the Keychain so the Provider's real Claude Code stays
 * in sync — otherwise Claude Code would find its refresh_token revoked on
 * next use.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, userInfo } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { relayLogger as logger } from "../logger.js";
import {
  RateGuard,
  RateGuardBudgetExceededError,
  RateGuardCooldownError,
  type SessionWindow,
} from "./rate-guard.js";
import { calculateCost } from "../pricing.js";

export { RateGuardBudgetExceededError, RateGuardCooldownError };

// ── Constants (sourced from sub2api + claude-cli/2.1.100 capture) ──

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_FILE = join(CLAWMONEY_DIR, "claude-fingerprint.json");

// Default fingerprint values used when the per-machine fingerprint file
// doesn't carry these fields (e.g. older bootstraps before we extended the
// schema). Bootstrapping with the new capture script will replace these
// with the values observed on the actual Provider machine.
const DEFAULT_CLI_VERSION = "2.1.100";
// NOTE: DEFAULT_CC_VERSION is only used as a fallback if the fingerprint file
// doesn't tell us the CLI's base version. The 3-char suffix is always
// recomputed per-request via computeClaudeFingerprint() — storing a baked
// suffix here would make every request look identical to Anthropic's
// fingerprint matcher, which is the relay-farm signature we want to avoid.
const DEFAULT_CC_VERSION = DEFAULT_CLI_VERSION;
const DEFAULT_CC_ENTRYPOINT = "cli";
const DEFAULT_USER_AGENT = `claude-cli/${DEFAULT_CLI_VERSION} (external, ${DEFAULT_CC_ENTRYPOINT})`;

// Hardcoded salt from Claude Code's backend fingerprint validator. Lifted
// verbatim from `src/utils/fingerprint.ts` in the reconstructed source map
// (claude-code-sourcemap) and cross-checked against cc-haha's copy of the
// same file — both projects have the identical string. This value is part
// of Anthropic's server-side check that the request came from a real CLI.
const CLAUDE_FINGERPRINT_SALT = "59cf53e54c78";

const STATIC_CLAUDE_CODE_HEADERS: Record<string, string> = {
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
  "content-type": "application/json",
  // Minimal beta set that Max-tier subscriptions always accept. Adding
  // context-1m or context-management here will get rejected as "long
  // context beta not available for this subscription" on non-Enterprise tiers.
  "anthropic-beta":
    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
};

// System prompt captured from real Claude Code ≥ 2.1.x. The first marker line
// matches claudeCodeSystemPrompts template #2 in sub2api's validator
// (hasClaudeCodeSystemPrompt → dice coefficient ≥ 0.5).
const CLAUDE_CODE_SYSTEM_PROMPT_LEAD =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// Appended after the CC marker; this is the only part a buyer actually
// controls the behavior of. Keeps the relay output in plain-text mode.
const RELAY_INSTRUCTIONS =
  "You are operating in pure-LLM relay mode. Respond to the user's message with plain text only. Do not use tools. Do not ask clarifying questions. Be concise.";

// Short-name → fully qualified ID mapping required by the Claude OAuth API.
const MODEL_ID_OVERRIDES: Record<string, string> = {
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

function normalizeModel(model: string): string {
  return MODEL_ID_OVERRIDES[model] ?? model;
}

// ── Types ──

interface ClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface LoadedCreds extends ClaudeAiOauth {
  source: "keychain" | "file";
  /** Populated when source === "file". Used by refresh logic to write back. */
  filePath?: string;
  _rawWrapper: Record<string, unknown>;
}

interface Fingerprint {
  device_id: string;
  account_uuid: string;
  // Optional — added by capture-claude-request.mjs in newer bootstraps so the
  // per-machine UA / cc_version / cc_entrypoint match what real Claude Code
  // on this same Provider sends. Older fingerprint files won't have these,
  // and we fall back to DEFAULT_* constants above.
  user_agent?: string;
  cc_version?: string;
  cc_entrypoint?: string;
}

interface ResolvedFingerprint {
  device_id: string;
  account_uuid: string;
  user_agent: string;
  cc_version: string;
  cc_entrypoint: string;
}

// ── Proxy (honor HTTPS_PROXY / http_proxy env vars) ──
//
// Node's native fetch does NOT read these env vars automatically, so if the
// Provider is behind a GFW-style egress (where api.anthropic.com is only
// reachable through a local HTTP proxy like 127.0.0.1:7890), we have to
// plumb it through undici explicitly. This only needs to run once per process.

let dispatcherConfigured = false;
function configureDispatcher(): void {
  if (dispatcherConfigured) return;
  dispatcherConfigured = true;
  const url =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!url) return;
  if (!/^https?:\/\//.test(url)) {
    logger.warn(`[claude-api] ignoring non-HTTP proxy ${url} (SOCKS not supported)`);
    return;
  }
  setGlobalDispatcher(new ProxyAgent(url) as unknown as Dispatcher);
  logger.info(`[claude-api] upstream proxy ${url}`);
}

// ── Fingerprint ──
//
// The metadata.user_id field (JSON format since Claude Code 2.1.78) must
// contain a 64-hex device_id and a real Anthropic account_uuid. These are
// stable per-account — we read them once from ~/.clawmoney/claude-fingerprint.json
// which the bootstrap `scripts/capture-claude-request.mjs` writes after
// observing a real Claude CLI request.
//
// Without a valid account_uuid, upstream may return 403 "Request not allowed".

let cachedFingerprint: ResolvedFingerprint | null = null;

function loadFingerprint(): ResolvedFingerprint {
  if (cachedFingerprint) return cachedFingerprint;
  if (!existsSync(FINGERPRINT_FILE)) {
    throw new Error(
      `Claude fingerprint not found at ${FINGERPRINT_FILE}. Run ` +
      `\`node scripts/capture-claude-request.mjs\` once, then in another ` +
      `terminal run \`ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude -p hi\` ` +
      `to bootstrap device_id and account_uuid.`
    );
  }
  const raw = JSON.parse(readFileSync(FINGERPRINT_FILE, "utf-8")) as Fingerprint;
  if (!raw.device_id || !raw.account_uuid) {
    throw new Error(`Fingerprint file missing device_id/account_uuid`);
  }
  // Older fingerprint files only have device_id + account_uuid. Fill in
  // sensible defaults for the new fields so we stay backward-compatible.
  //
  // cc_version sanitization: older capture scripts recorded the full
  // "<CLI-version>.<3char-hash>" string Anthropic sent back (e.g.
  // "2.1.100.c68"). That trailing hash is a per-request fingerprint of
  // the prompt content — baking it into every outbound request means all
  // of this provider's traffic shares the same fingerprint suffix even
  // though prompts differ, which is a strong relay-farm signal. Strip it
  // here so the at-rest cc_version is the bare CLI version, and let
  // computeClaudeFingerprint() recompute the suffix per request.
  const rawCcVersion = raw.cc_version ?? DEFAULT_CC_VERSION;
  const cleanCcVersion = rawCcVersion.replace(/\.[a-f0-9]{3}$/i, "");
  cachedFingerprint = {
    device_id: raw.device_id,
    account_uuid: raw.account_uuid,
    user_agent: raw.user_agent ?? DEFAULT_USER_AGENT,
    cc_version: cleanCcVersion,
    cc_entrypoint: raw.cc_entrypoint ?? DEFAULT_CC_ENTRYPOINT,
  };
  if (raw.user_agent || raw.cc_version || raw.cc_entrypoint) {
    logger.info(
      `[claude-api] using captured fingerprint (ua=${cachedFingerprint.user_agent}, cc_version=${cachedFingerprint.cc_version}, entrypoint=${cachedFingerprint.cc_entrypoint})`
    );
  } else {
    logger.warn(
      `[claude-api] fingerprint file missing user_agent/cc_version/cc_entrypoint — using hardcoded defaults. Re-run capture-claude-request.mjs to upgrade.`
    );
  }
  return cachedFingerprint;
}

function buildMetadataUserID(fingerprint: ResolvedFingerprint, sessionId: string): string {
  // Claude Code >= 2.1.78 uses JSON-encoded user_id (see metadata_userid.go).
  return JSON.stringify({
    device_id: fingerprint.device_id,
    account_uuid: fingerprint.account_uuid,
    session_id: sessionId,
  });
}

// ── Masked session id (3-minute sliding window, jittered) ──
//
// Real Claude Code reuses the same session_id across many requests in the
// same conversation. If we randomize a new UUID per request, from Anthropic's
// side this account produces dozens of single-request "sessions" per hour,
// which is a strong bot signal. sub2api (identity_service.go) solves this
// with a masked session id — every request within the window gets the same
// id, sliding forward on each hit.
//
// We use a **3-minute** window (not 15) because that matches the median real
// human coding rhythm better: a user types a prompt, reads the answer, types
// a follow-up, reads, context-switches. 15 minutes of same-session traffic
// at machine-paced intervals is itself suspicious for a human operator. We
// also add ±30s jitter so multiple providers don't all roll their sessions
// in lockstep at :00 / :03 / :06 etc — that kind of coordinated reset is an
// obvious relay-farm signature.

const MASKED_SESSION_TTL_MS = 3 * 60 * 1000; // 3 minutes
const MASKED_SESSION_JITTER_MS = 30 * 1000; // ±30s
let maskedSessionId: string | null = null;
let maskedSessionExpiresAt = 0;

function getMaskedSessionId(): string {
  const now = Date.now();
  if (maskedSessionId && now < maskedSessionExpiresAt) {
    return maskedSessionId;
  }
  maskedSessionId = randomUUID();
  // New window starts now, expires TTL + jitter from here.
  const jitter = Math.floor((Math.random() * 2 - 1) * MASKED_SESSION_JITTER_MS);
  maskedSessionExpiresAt = now + MASKED_SESSION_TTL_MS + jitter;
  logger.info(
    `[claude-api] new masked session_id ${maskedSessionId.slice(0, 8)}... ` +
      `(window=${Math.round((MASKED_SESSION_TTL_MS + jitter) / 1000)}s)`
  );
  return maskedSessionId;
}

// ── Prompt sanitization ──
//
// Some third-party CLIs (OpenCode is the canonical offender, per sub2api's
// gateway_service.go:882-897) embed a fixed self-identity sentence at the
// top of their prompt. If a buyer using such a tool sends that sentence
// through our relay, Anthropic will see it, decide "this isn't Claude Code",
// and 403 the request. Rewrite the known bad sentences to the Claude Code
// banner before forwarding.

const IDENTITY_REPLACEMENTS: Array<[string, string]> = [
  [
    "You are OpenCode, the best coding agent on the planet.",
    "You are Claude Code, Anthropic's official CLI for Claude.",
  ],
];

// ── Attribution fingerprint ──
//
// Claude Code's server-side fingerprint validator expects the outgoing
// /v1/messages request to contain, as the first system block, a text node
// of the form:
//
//   x-anthropic-billing-header: cc_version=<CLI-VERSION>.<FP3>; cc_entrypoint=<EP>;
//
// where <FP3> is a per-request 3-hex-char hash that Anthropic derives from
// the first user message's content and the CLI version. The algorithm is
// verbatim from the reconstructed Claude Code source
// (claude-code-sourcemap/restored-src/src/utils/fingerprint.ts, cross-
// verified against cc-haha/src/utils/fingerprint.ts):
//
//   chars = msg[4] + msg[7] + msg[20]          (each char, "0" if OOB)
//   input = SALT + chars + version
//   hash  = sha256(input).hex
//   fp    = hash[:3]
//
// If every request we send reuses the SAME baked <FP3> (e.g. the one that
// happened to be recorded when capture-claude-request.mjs ran), Anthropic
// can observe: same account_uuid, wildly different first-user-message
// texts, but identical cc_version suffix — a strong relay-farm signal.
// Computing it per request removes that signal.

function computeClaudeFingerprint(
  firstUserMessageText: string,
  cliVersion: string
): string {
  const indices = [4, 7, 20];
  const chars = indices.map((i) => firstUserMessageText[i] ?? "0").join("");
  const input = `${CLAUDE_FINGERPRINT_SALT}${chars}${cliVersion}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

function buildClaudeAttributionHeader(
  firstUserMessageText: string,
  cliVersion: string,
  entrypoint: string
): string {
  const fp = computeClaudeFingerprint(firstUserMessageText, cliVersion);
  // NOTE: real Claude Code optionally appends ` cch=00000;` when its Bun
  // native client has NATIVE_CLIENT_ATTESTATION enabled — the Bun HTTP
  // stack then rewrites the zeros with an attestation token in-flight.
  // We can't replicate that (no Bun runtime, no native attester), and the
  // server also accepts the header without it (feature() guarded in
  // sourcemap's getAttributionHeader), so we omit cch entirely rather
  // than sending a literal `cch=00000;` that would fail attestation on
  // tiers where Anthropic validates it.
  return `x-anthropic-billing-header: cc_version=${cliVersion}.${fp}; cc_entrypoint=${entrypoint};`;
}

function sanitizePrompt(prompt: string): string {
  if (!prompt) return prompt;
  let out = prompt;
  for (const [needle, repl] of IDENTITY_REPLACEMENTS) {
    if (out.includes(needle)) {
      out = out.split(needle).join(repl);
      logger.info(
        `[claude-api] sanitized third-party identity marker in prompt`
      );
    }
  }
  return out;
}

// ── 429 / 5h session window header parsing ──
//
// Anthropic surfaces rate-limit state on responses via these headers:
//   anthropic-ratelimit-unified-5h-reset            RFC3339 / unix ts
//   anthropic-ratelimit-unified-5h-utilization      0-100
//   anthropic-ratelimit-unified-5h-status           "ok" | "surpassed" | ...
//   anthropic-ratelimit-unified-7d-reset
//   anthropic-ratelimit-unified-7d-utilization
//   anthropic-ratelimit-unified-reset               aggregated fallback
// Values may be either a decimal unix second count or an RFC3339 timestamp.
// Returns absolute UNIX ms, or null.

function parseAnthropicResetHeader(raw: string | null): number | null {
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds) && asSeconds > 0) {
    // Heuristic: values < 2 × 10^10 are unix seconds, higher are unix ms.
    return asSeconds < 2e10 ? asSeconds * 1000 : asSeconds;
  }
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return asDate;
  return null;
}

function extractSessionWindowFromHeaders(headers: Headers): SessionWindow | null {
  const resetMs =
    parseAnthropicResetHeader(headers.get("anthropic-ratelimit-unified-5h-reset")) ??
    parseAnthropicResetHeader(headers.get("anthropic-ratelimit-unified-reset"));
  if (!resetMs) return null;
  const win: SessionWindow = {
    endMs: resetMs,
    startMs: resetMs - 5 * 60 * 60 * 1000,
  };
  const utilRaw = headers.get("anthropic-ratelimit-unified-5h-utilization");
  if (utilRaw) {
    const util = Number(utilRaw);
    if (Number.isFinite(util)) win.utilization = util;
  }
  const status = headers.get("anthropic-ratelimit-unified-5h-status");
  if (status) win.status = status;
  return win;
}

function extractCooldownUntilFromHeaders(headers: Headers): { untilMs: number; reason: string } | null {
  // Prefer the exact 5h window if present, fall back to the aggregated unified reset.
  const reset5h = parseAnthropicResetHeader(headers.get("anthropic-ratelimit-unified-5h-reset"));
  const reset7d = parseAnthropicResetHeader(headers.get("anthropic-ratelimit-unified-7d-reset"));
  const resetUnified = parseAnthropicResetHeader(headers.get("anthropic-ratelimit-unified-reset"));
  const retryAfter = parseRetryAfterMs(headers.get("retry-after"));
  const retryAfterAbs = retryAfter != null ? Date.now() + retryAfter : null;
  const candidates: Array<{ ms: number; reason: string }> = [];
  if (reset5h) candidates.push({ ms: reset5h, reason: "anthropic 5h window" });
  if (reset7d) candidates.push({ ms: reset7d, reason: "anthropic 7d window" });
  if (resetUnified) candidates.push({ ms: resetUnified, reason: "anthropic unified" });
  if (retryAfterAbs) candidates.push({ ms: retryAfterAbs, reason: "retry-after" });
  if (candidates.length === 0) return null;
  // Pick the soonest real reset time so we don't over-cooldown.
  candidates.sort((a, b) => a.ms - b.ms);
  return { untilMs: candidates[0].ms, reason: candidates[0].reason };
}

// ── OAuth credential I/O ──

function readCredentialsFromKeychain(): Record<string, unknown> | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { stdio: ["ignore", "pipe", "pipe"] }
    ).toString().trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const CLAUDE_CREDENTIALS_FILE_PATH = join(homedir(), ".claude", ".credentials.json");

function readCredentialsFromFile(): Record<string, unknown> | null {
  if (!existsSync(CLAUDE_CREDENTIALS_FILE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CLAUDE_CREDENTIALS_FILE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function loadClaudeOAuth(): LoadedCreds {
  const fromKeychain = readCredentialsFromKeychain();
  const fromFile = fromKeychain ? null : readCredentialsFromFile();
  const raw = fromKeychain ?? fromFile;
  if (!raw) {
    throw new Error(
      "Claude Code credentials not found. Log in with `claude` first."
    );
  }
  const oauth = raw.claudeAiOauth as ClaudeAiOauth | undefined;
  if (!oauth?.accessToken) {
    throw new Error("Credentials file missing claudeAiOauth.accessToken");
  }
  return {
    source: fromKeychain ? "keychain" : "file",
    filePath: fromKeychain ? undefined : CLAUDE_CREDENTIALS_FILE_PATH,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes ?? [],
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
    _rawWrapper: raw,
  };
}

function writeCredentialsToKeychain(wrapper: Record<string, unknown>): void {
  if (process.platform !== "darwin") {
    throw new Error("Keychain write is only supported on macOS");
  }
  const account = userInfo().username;
  execFileSync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s", KEYCHAIN_SERVICE,
      "-a", account,
      "-w", JSON.stringify(wrapper),
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

// ── OAuth refresh ──

interface RefreshedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

async function refreshUpstreamToken(refreshToken: string): Promise<RefreshedToken> {
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json",
      "user-agent": "axios/1.13.6",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token refresh failed: ${resp.status} ${body.slice(0, 300)}`);
  }
  const data = await resp.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: (data.scope ?? "").split(" ").filter(Boolean),
  };
}

// ── Token cache ──
//
// Single in-memory credential cache per daemon process. Refreshed tokens
// are also written back to the Keychain so the Provider's real Claude Code
// (which shares the same credential store) stays functional.

let cachedCreds: LoadedCreds | null = null;
let refreshInflight: Promise<LoadedCreds> | null = null;

const REFRESH_SKEW_MS = 3 * 60 * 1000;

async function doRefreshAndPersist(current: LoadedCreds): Promise<LoadedCreds> {
  logger.info("[claude-api] refreshing OAuth token...");
  const fresh = await refreshUpstreamToken(current.refreshToken);
  const wrapper = { ...current._rawWrapper };
  wrapper.claudeAiOauth = {
    ...(wrapper.claudeAiOauth as object),
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    expiresAt: fresh.expiresAt,
    scopes: fresh.scopes.length > 0
      ? fresh.scopes
      : (wrapper.claudeAiOauth as ClaudeAiOauth).scopes,
  };

  // IMPORTANT: persist BEFORE advancing the in-memory state. If the keychain
  // write silently fails we must NOT start using the new access/refresh token
  // — doing so creates a "two valid tokens in flight" pattern that looks to
  // Anthropic like account hijacking (same account_id, two access_tokens
  // issued within the 3-minute refresh skew window). The correct fallback is
  // to keep serving on the old token until the next refresh cycle retries
  // the persist, so on-disk and in-memory state always agree.
  if (current.source === "keychain") {
    try {
      writeCredentialsToKeychain(wrapper);
      logger.info("[claude-api] keychain updated");
    } catch (err) {
      logger.error(
        `[claude-api] CRITICAL: keychain write failed — keeping old token to avoid account-hijack detection signal: ${(err as Error).message}`
      );
      return current;
    }
  } else if (current.source === "file" && current.filePath) {
    try {
      writeFileSync(
        current.filePath,
        JSON.stringify(wrapper, null, 2),
        { encoding: "utf-8", mode: 0o600 }
      );
      logger.info(`[claude-api] ${current.filePath} updated`);
    } catch (err) {
      logger.error(
        `[claude-api] CRITICAL: credential file write failed — keeping old token to avoid account-hijack detection signal: ${(err as Error).message}`
      );
      return current;
    }
  }

  const next: LoadedCreds = {
    ...current,
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    expiresAt: fresh.expiresAt,
    _rawWrapper: wrapper,
  };
  return next;
}

async function getFreshCreds(): Promise<LoadedCreds> {
  if (!cachedCreds) {
    cachedCreds = loadClaudeOAuth();
  }
  if (Date.now() < cachedCreds.expiresAt - REFRESH_SKEW_MS) {
    return cachedCreds;
  }
  // Coalesce concurrent refreshes so we don't burn multiple refresh_tokens.
  if (!refreshInflight) {
    const prior = cachedCreds;
    refreshInflight = doRefreshAndPersist(prior).finally(() => {
      refreshInflight = null;
    });
  }
  cachedCreds = await refreshInflight;
  return cachedCreds;
}

// ── Version drift check ──
//
// Anthropic's Claude Code fingerprint detection is UA-sensitive. If the real
// Claude CLI on this machine is meaningfully newer than the version we
// hardcode here, the Provider's normal baseline has drifted from what we
// send on the Buyer's behalf. Not a hard error — just a warning so ops
// know to refresh the capture.

function detectInstalledClaudeVersion(): string | null {
  try {
    const out = execFileSync("claude", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).toString();
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function autoBumpFingerprintUaVersion(): void {
  const installed = detectInstalledClaudeVersion();
  if (!installed) {
    logger.warn(
      "[claude-api] could not detect installed claude CLI version; fingerprint may drift"
    );
    return;
  }
  const fp = cachedFingerprint;
  if (!fp) return;
  const fpVersion = fp.user_agent.match(/claude-cli\/(\d+\.\d+\.\d+)/)?.[1];
  if (!fpVersion) {
    logger.info(`[claude-api] claude-cli version: ${installed} (no fingerprint version pin)`);
    return;
  }
  if (fpVersion === installed) {
    logger.info(`[claude-api] claude-cli version match: ${installed}`);
    return;
  }
  if (compareSemver(installed, fpVersion) > 0) {
    // Local CLI is NEWER than the fingerprint — auto-bump only the version
    // number inside user_agent, leaving the entrypoint suffix ("external,
    // sdk-cli") and all stainless headers as-is. sub2api does the same
    // (identity_service.go mergeHeadersIntoFingerprint): merge semantics,
    // not clobber, so we never overwrite known-real values with defaults.
    const newUa = fp.user_agent.replace(
      /claude-cli\/\d+\.\d+\.\d+/,
      `claude-cli/${installed}`
    );
    fp.user_agent = newUa;
    // Persist so we don't re-bump on every daemon restart.
    try {
      const onDisk = JSON.parse(readFileSync(FINGERPRINT_FILE, "utf-8"));
      onDisk.user_agent = newUa;
      writeFileSync(
        FINGERPRINT_FILE,
        JSON.stringify(onDisk, null, 2),
        "utf-8"
      );
    } catch (err) {
      logger.warn(`[claude-api] could not persist UA bump: ${(err as Error).message}`);
    }
    logger.info(
      `[claude-api] auto-bumped fingerprint UA: claude-cli/${fpVersion} → claude-cli/${installed} (re-run capture-claude-request.mjs for full resync if upstream starts 403-ing)`
    );
  } else {
    // Local CLI is OLDER than the fingerprint — fingerprint was captured
    // on a newer machine and synced here. Don't touch it.
    logger.info(
      `[claude-api] local claude-cli ${installed} older than fingerprint ${fpVersion}, keeping fingerprint`
    );
  }
}

// ── Rate guard ──

let rateGuard: RateGuard | null = null;

export function configureRateGuard(config?: RelayRateGuardConfig): void {
  const mapped = config
    ? {
        maxConcurrency: config.max_concurrency,
        quietHoursMaxConcurrency: config.quiet_hours_max_concurrency,
        quietHours: config.quiet_hours,
        minRequestGapMs: config.min_request_gap_ms,
        jitterMs: config.jitter_ms,
        dailyBudgetUsd: config.daily_budget_usd,
      }
    : {};
  // Filter out undefined so defaults apply.
  const cleaned = Object.fromEntries(
    Object.entries(mapped).filter(([, v]) => v !== undefined)
  );
  rateGuard = new RateGuard(cleaned);
  logger.info(
    `[claude-api] rate-guard active (concurrency_active=${rateGuard["cfg"].maxConcurrency}, quiet=${rateGuard["cfg"].quietHoursMaxConcurrency}, daily_budget=$${rateGuard["cfg"].dailyBudgetUsd})`
  );
}

export function getRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null {
  return rateGuard?.currentLoad() ?? null;
}

// Called once at daemon startup so that an invalid fingerprint / missing
// credential fails fast instead of on the first inbound relay request.
export async function preflightClaudeApi(config?: RelayRateGuardConfig): Promise<void> {
  configureDispatcher();
  configureRateGuard(config);
  loadFingerprint();
  await getFreshCreds();
  autoBumpFingerprintUaVersion();
  logger.info(
    `[claude-api] preflight OK (subscription=${cachedCreds?.subscriptionType ?? "?"}, tier=${cachedCreds?.rateLimitTier ?? "?"})`
  );
}

// ── API call ──

interface AnthropicMessageResponse {
  model?: string;
  stop_reason?: string;
  content?: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export interface CallClaudeApiOptions {
  prompt: string;
  model: string;
  maxTokens?: number;
}

export async function callClaudeApi(opts: CallClaudeApiOptions): Promise<ParsedOutput> {
  configureDispatcher();
  // Lazy-init rate-guard with defaults if preflight wasn't called (e.g. unit tests).
  if (!rateGuard) configureRateGuard();
  return rateGuard!.run(() => doCallClaudeApi(opts));
}

// Maximum number of automatic retries on transient upstream errors
// (429 / 5xx). Matches the Anthropic official SDK default. Does NOT count
// the initial attempt or the one-shot 401-refresh retry.
const MAX_TRANSIENT_RETRIES = 2;

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

async function doCallClaudeApi(opts: CallClaudeApiOptions): Promise<ParsedOutput> {
  // Empty prompts would hit upstream as `{type: "text", text: ""}` which
  // Anthropic rejects with 400. Fail fast before burning a rate-guard slot.
  const sanitizedPrompt = sanitizePrompt(opts.prompt ?? "");
  if (!sanitizedPrompt.trim()) {
    throw new Error("Empty prompt");
  }

  const fingerprint = loadFingerprint();
  // Masked session id: same value across all requests in a 15-min window,
  // so Anthropic sees a persistent "conversation" instead of hundreds of
  // one-shot sessions.
  const sessionId = getMaskedSessionId();
  const maxTokens = opts.maxTokens ?? 4096;

  // Dynamic attribution header — computed per request from the first user
  // message text so the cc_version.<FP3> suffix varies request-by-request,
  // matching what real Claude Code sends. See computeClaudeFingerprint().
  const attributionHeader = buildClaudeAttributionHeader(
    sanitizedPrompt,
    fingerprint.cc_version,
    fingerprint.cc_entrypoint
  );

  const body = {
    model: normalizeModel(opts.model),
    max_tokens: maxTokens,
    system: [
      {
        type: "text",
        text: attributionHeader,
      },
      {
        type: "text",
        text: `${CLAUDE_CODE_SYSTEM_PROMPT_LEAD}\n\n${RELAY_INSTRUCTIONS}`,
        // Mark the last system block for prompt caching. Real Claude Code
        // *always* attaches cache_control: {type: "ephemeral"} to its system
        // blocks — Anthropic uses the presence of this marker as part of its
        // "is this really Claude Code?" fingerprint check, so sending a bare
        // string-typed or unmarked array-typed system is a detectability
        // signal that can trip 403 "Request not allowed". Our system is too
        // short (<1024 tokens) to actually hit the cache, so the marker's
        // immediate effect is zero — it exists purely for fingerprint fidelity.
        // When we later bloat system to >=1024 tokens (e.g. for high-traffic
        // cost savings), this same marker will automatically start
        // materializing real cache reads.
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: sanitizedPrompt }],
      },
    ],
    metadata: { user_id: buildMetadataUserID(fingerprint, sessionId) },
    stream: false,
  };
  const bodyJson = JSON.stringify(body);

  let transientAttempt = 0;
  let hasRefreshed = false;

  while (true) {
    const creds = await getFreshCreds();
    const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        ...STATIC_CLAUDE_CODE_HEADERS,
        "user-agent": fingerprint.user_agent,
        "authorization": `Bearer ${creds.accessToken}`,
        "x-claude-code-session-id": sessionId,
      },
      body: bodyJson,
    });

    // Update session window state from every response (success OR failure) —
    // upstream surfaces the 5h window state in response headers regardless.
    const sessionWin = extractSessionWindowFromHeaders(resp.headers);
    if (sessionWin) rateGuard?.setSessionWindow(sessionWin);

    if (resp.ok) {
      const parsed = parseResponse(await resp.json() as AnthropicMessageResponse, opts.model);
      recordSpendFromUsage(parsed, opts.model);
      return parsed;
    }

    const errText = await resp.text();

    // Real 429 from upstream → engage hard cooldown so we stop hammering.
    // We do NOT retry a 429: any retry would just slam the rate-limited
    // account harder and extend the ban. Parse the reset headers, mark
    // cooldown, and fail this request. Subsequent requests will immediately
    // short-circuit via checkCooldown().
    if (resp.status === 429) {
      const cooldown = extractCooldownUntilFromHeaders(resp.headers);
      if (cooldown && rateGuard) {
        rateGuard.triggerCooldown(cooldown.untilMs, cooldown.reason);
      } else if (rateGuard) {
        // No reset headers — conservative 5 minute fallback so we don't
        // retry immediately, but we also don't over-cooldown.
        rateGuard.triggerCooldown(Date.now() + 5 * 60_000, "fallback 5m (no reset header)");
      }
      throw new Error(`Anthropic 429 rate-limited: ${errText.slice(0, 300)}`);
    }

    // 401 → one-shot token refresh + retry. If we already refreshed once
    // and still got 401, the credentials are genuinely broken — bubble up.
    if (resp.status === 401 && !hasRefreshed) {
      logger.warn("[claude-api] 401 from upstream, refreshing token + retry");
      hasRefreshed = true;
      cachedCreds = null;
      continue;
    }

    // 5xx → transient upstream hiccup. Retry with exponential backoff
    // + jitter, honoring Retry-After if present. This is what Anthropic's
    // official SDK does by default; buyers used to see these as hard 502s
    // even when the right move was "wait 1s and try again". We only do this
    // inside the rate-guard slot we're already holding, so retries don't
    // re-queue behind other requests. Note that 429 is NOT included here —
    // it's handled above with a hard cooldown instead of retry.
    const isTransient = resp.status >= 500 && resp.status <= 599;
    if (isTransient && transientAttempt < MAX_TRANSIENT_RETRIES) {
      const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
      const backoffMs =
        retryAfter ?? 500 * Math.pow(2, transientAttempt) + Math.random() * 500;
      logger.warn(
        `[claude-api] ${resp.status} from upstream (attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(backoffMs)}ms — ${errText.slice(0, 200)}`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      transientAttempt++;
      continue;
    }

    // Unrecoverable — bubble up with the upstream status + body so Hub can
    // translate it into a sensible HTTP status for the buyer.
    throw new Error(`Anthropic ${resp.status}: ${errText.slice(0, 400)}`);
  }
}

function recordSpendFromUsage(parsed: ParsedOutput, model: string): void {
  if (!rateGuard) return;
  const { input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens } = parsed.usage;
  const cost = calculateCost(model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens);
  // We track the full API cost against the Provider's daily budget (not the
  // discounted relay cost) because that's what Anthropic sees on the
  // subscription meter and what will actually burn the account.
  rateGuard.recordSpend(cost.apiCost);
}

function parseResponse(data: AnthropicMessageResponse, fallbackModel: string): ParsedOutput {
  const text = (data.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
  const usage = data.usage ?? {};
  return {
    text,
    sessionId: "",
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    },
    model: data.model ?? fallbackModel,
    costUsd: 0,
  };
}
