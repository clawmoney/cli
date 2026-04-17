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

// Headers that real Claude Code emits on every /v1/messages call. The
// Anthropic SDK would inject these automatically; since we bypass the SDK
// and hand-roll the fetch call we have to include them verbatim.
//
// Note the deliberate omissions:
//   - `anthropic-beta` is NOT static — it is per-request and derived from
//     the model via pickClaudeBetasForModel(). Real Claude Code passes
//     the list via the SDK's `betas: [...]` body param and the SDK then
//     emits it as a comma-joined `anthropic-beta` header. We do the same
//     thing by building the header inline in doCallClaudeApi so Haiku
//     requests drop `claude-code-20250219` like the real CLI.
//   - `accept` is overridden per-request to `text/event-stream` when we
//     set stream:true (see doCallClaudeApi). Leaving it out of the static
//     set so we can pick the right value at call time.
const STATIC_CLAUDE_CODE_HEADERS: Record<string, string> = {
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
};

// System prompt captured from real Claude Code ≥ 2.1.x. The first marker line
// matches claudeCodeSystemPrompts template #2 in sub2api's validator
// (hasClaudeCodeSystemPrompt → dice coefficient ≥ 0.5).
const CLAUDE_CODE_SYSTEM_PROMPT_LEAD =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

// Template-mode instructions ONLY — not used in passthrough mode.
// In passthrough, the buyer's Claude Code sends its own tool definitions
// and expects full agentic behavior; injecting "do not use tools" here
// would break WebSearch / Bash / Edit / all other tools, producing
// "current mode can't use tools" responses from the model.
const RELAY_INSTRUCTIONS_TEMPLATE =
  "You are operating in pure-LLM relay mode. Respond to the user's message with plain text only. Do not use tools. Do not ask clarifying questions. Be concise.";

// Passthrough-mode marker — just the CC identity lead, no tool-suppression.
// The buyer controls tool behavior via the body's `tools` array and
// their own system prompt.
const RELAY_INSTRUCTIONS_PASSTHROUGH = "";

// Short-name → fully qualified ID mapping required by the Claude OAuth API.
const MODEL_ID_OVERRIDES: Record<string, string> = {
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus-4-5": "claude-opus-4-5-20251101",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
};

function normalizeModel(model: string): string {
  return MODEL_ID_OVERRIDES[model] ?? model;
}

// ── Per-model thinking + betas selection (mirrors real Claude Code) ──
//
// Real Claude Code ALWAYS sends a `thinking` body field for Claude 4+
// models, and the shape depends on whether the model supports adaptive
// thinking. Source: claude-code-best/src/utils/thinking.ts:
//   - modelSupportsThinking() → any canonical name NOT matching "claude-3-"
//   - modelSupportsAdaptiveThinking() → only canonical names containing
//     "opus-4-6" or "sonnet-4-6"
//
// If we send requests to Anthropic without this field but with Claude 4+
// models, the per-account traffic pattern is "zero thinking on every
// message" which is a clear relay-farm fingerprint (real users on these
// tiers get adaptive thinking automatically and have no way to turn it
// off short of setting alwaysThinkingEnabled=false).

function modelSupportsThinking(model: string): boolean {
  return !normalizeModel(model).includes("claude-3-");
}

function modelSupportsAdaptiveThinking(model: string): boolean {
  const m = normalizeModel(model);
  return m.includes("opus-4-6") || m.includes("sonnet-4-6");
}

type ClaudeThinkingParam =
  | { type: "adaptive" }
  | { type: "enabled"; budget_tokens: number };

// Anthropic's /v1/messages rejects thinking.enabled.budget_tokens < 1024.
const CLAUDE_MIN_THINKING_BUDGET = 1024;

function pickClaudeThinkingConfig(
  model: string,
  maxTokens: number
): { config: ClaudeThinkingParam | undefined; adjustedMaxTokens: number } {
  if (!modelSupportsThinking(model)) {
    return { config: undefined, adjustedMaxTokens: maxTokens };
  }
  if (modelSupportsAdaptiveThinking(model)) {
    // Adaptive has no fixed budget — the API internally picks. Don't
    // inflate max_tokens; keep caller's cap.
    return { config: { type: "adaptive" }, adjustedMaxTokens: maxTokens };
  }
  // Budget thinking (4-5 / haiku-4-5): budget_tokens must be >= 1024 AND
  // strictly less than max_tokens. If caller's max_tokens is too low to
  // fit the 1024 floor + 1, bump max_tokens so we can send a valid
  // thinking block. Real Claude Code uses `getMaxThinkingTokensForModel
  // = getModelMaxOutputTokens(model).upperLimit - 1` which is usually
  // many thousands, but for a relay we want to respect the caller's cap
  // unless it would force an invalid request.
  const requiredMax = CLAUDE_MIN_THINKING_BUDGET + 1;
  const adjustedMaxTokens = Math.max(maxTokens, requiredMax);
  const budget = Math.max(CLAUDE_MIN_THINKING_BUDGET, adjustedMaxTokens - 1);
  return {
    config: { type: "enabled", budget_tokens: budget },
    adjustedMaxTokens,
  };
}

/**
 * Assemble the `betas` array that goes into the /v1/messages body. Real
 * Claude Code constructs this dynamically per-request from
 * getAllModelBetas() — the key branches are:
 *   1. non-haiku → push `claude-code-20250219`
 *   2. OAuth subscriber → push `oauth-2025-04-20`
 *   3. model supports interleaved-source-processing (ISP, i.e. any 4+) →
 *      push `interleaved-thinking-2025-05-14`
 * Source: claude-code-best/src/utils/betas.ts:233-261 (getAllModelBetas).
 *
 * The Anthropic SDK later materializes this array into the
 * `anthropic-beta` HTTP header as a comma-separated list. Sending it via
 * the body instead of a static header is indistinguishable from the SDK
 * wire format (we are literally doing the same thing the SDK does), but
 * making it dynamic per-model avoids the Haiku mismatch where real CLI
 * drops `claude-code-20250219` but our old static header always sent it.
 */
function pickClaudeBetasForModel(model: string): string[] {
  const m = normalizeModel(model);
  const isHaiku = m.includes("haiku");
  const betas: string[] = [];

  // claude-code-20250219 — required for non-haiku models, Anthropic uses
  // it to identify legitimate Claude Code requests (missing → "non-CC"
  // classification → Extra usage required for long context etc).
  if (!isHaiku) betas.push("claude-code-20250219");

  // oauth-2025-04-20 — required for OAuth (Max subscription) tokens.
  betas.push("oauth-2025-04-20");

  // interleaved-thinking-2025-05-14 — all Claude 4+ models support it.
  if (modelSupportsThinking(model)) {
    betas.push("interleaved-thinking-2025-05-14");
  }

  // Below: betas that real Claude Code always sends. Missing any of these
  // causes Anthropic to treat the request as "not quite Claude Code",
  // which silently disables tool use and may force Extra usage billing
  // on long context. Cross-referenced against auth2api and real CC wire
  // capture (2026-04 versions).
  //
  // - redact-thinking-2026-02-12: hides thinking blocks in response
  // - context-management-2025-06-27: enables tool_result context windows
  // - prompt-caching-scope-2026-01-05: global prompt cache scope
  // - advanced-tool-use-2025-11-20: enables tool_use for non-haiku (CRITICAL)
  // - effort-2025-11-24: adaptive thinking effort levels
  betas.push("redact-thinking-2026-02-12");
  betas.push("context-management-2025-06-27");
  betas.push("prompt-caching-scope-2026-01-05");
  if (!isHaiku) {
    betas.push("advanced-tool-use-2025-11-20");
    betas.push("effort-2025-11-24");
  }

  return betas;
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

// ── Auth-broken circuit breaker ─────────────────────────────────────────
//
// If Anthropic's OAuth refresh endpoint rejects our refresh_token as
// invalid (400 invalid_grant, 401, 403 "Request not allowed", etc.),
// that's a persistent condition — the token is not going to start
// working again on its own. Every subsequent buyer request would burn
// another refresh attempt on Anthropic, which looks like brute-forcing
// from their anti-abuse side and risks getting the provider's account
// flagged.
//
// Cache the "broken" state for AUTH_BROKEN_CACHE_MS. During that window
// ALL calls to getFreshCreds() short-circuit with the cached error
// WITHOUT hitting Anthropic. After the window expires we allow exactly
// one probe refresh — if it succeeds, we're unbroken; if it fails
// again, the window is extended by another interval.
//
// Transient 5xx responses are NOT cached — those are "maybe the server
// is having a moment" and worth retrying. Only 4xx "no, really, the
// token is bad" responses trip the breaker.
const AUTH_BROKEN_CACHE_MS = 5 * 60 * 1000;
let authBrokenUntilMs = 0;
let authBrokenError: Error | null = null;

function isAuthBrokenError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  // Matches messages produced by refreshUpstreamToken:
  //   "Token refresh failed: 400 ...invalid_grant..."
  //   "Token refresh failed: 401 ..."
  //   "Token refresh failed: 403 ...Request not allowed..."
  return (
    msg.includes("invalid_grant") ||
    msg.includes("request not allowed") ||
    /token refresh failed:\s*40[0134]/.test(msg)
  );
}

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
  // Circuit breaker: if the OAuth endpoint is known-broken for this
  // daemon, throw the cached error immediately without touching
  // Anthropic again. This is what keeps a retry storm from burning
  // one refresh attempt per buyer request and getting the account
  // flagged.
  if (authBrokenUntilMs && Date.now() < authBrokenUntilMs && authBrokenError) {
    throw authBrokenError;
  }

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
  try {
    cachedCreds = await refreshInflight;
  } catch (err) {
    const e = err as Error;
    if (isAuthBrokenError(e)) {
      authBrokenUntilMs = Date.now() + AUTH_BROKEN_CACHE_MS;
      authBrokenError = e;
      logger.error(
        `[claude-api] OAuth refresh rejected by Anthropic — caching auth-broken state for ${AUTH_BROKEN_CACHE_MS / 1000}s. Subsequent requests will fail fast without hitting the OAuth endpoint. Fix: re-login with 'claude /login' and restart the daemon. Root cause: ${e.message.slice(0, 200)}`
      );
    }
    throw err;
  }
  // Successful refresh — clear any cached broken state.
  if (authBrokenUntilMs) {
    authBrokenUntilMs = 0;
    authBrokenError = null;
    logger.info("[claude-api] OAuth refresh recovered — auth-broken cache cleared");
  }
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
        maxRelayUtilization: config.max_relay_utilization,
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

export interface CallClaudeApiOptions {
  prompt: string;
  model: string;
  maxTokens?: number;
  // If set, called once per SSE frame from Anthropic as the stream progresses.
  // The frame is the raw SSE block (`event: X\ndata: Y\n\n`), suitable for
  // direct forwarding to an upstream SSE consumer. Aggregation into
  // ParsedOutput still happens in parallel so the non-streaming return
  // shape is unchanged.
  onRawEvent?: (rawFrame: string) => void;
}

export async function callClaudeApi(opts: CallClaudeApiOptions): Promise<ParsedOutput> {
  configureDispatcher();
  // Lazy-init rate-guard with defaults if preflight wasn't called (e.g. unit tests).
  if (!rateGuard) configureRateGuard();
  return rateGuard!.run(() => doCallClaudeApi(opts));
}

// ── Passthrough mode ──────────────────────────────────────────────────────
//
// For drop-in ANTHROPIC_BASE_URL replacement use cases (e.g. Claude Code
// pointed at spareapi.ai), the buyer's real request body needs to reach
// Anthropic with all of its tools, multi-turn messages, thinking config,
// system prompts, context_management, etc. intact. The template path above
// (doCallClaudeApi) strips all of that and replaces it with a single
// synthetic user message — useful for text-chat relay, useless for real
// agentic workflows.
//
// The passthrough path mirrors sub2api's gateway forwarding strategy
// (backend/internal/service/gateway_service.go:5540-5704) — the buyer's
// body is preserved almost verbatim, with surgical rewrites on the fields
// that Anthropic uses for account-level fingerprinting:
//
//   - metadata.user_id           → rebuilt from our fingerprint + masked
//                                  session id so Anthropic sees stable
//                                  identity per OAuth account regardless
//                                  of which buyer is behind the request.
//   - model                      → normalized to the canonical long form
//                                  (claude-sonnet-4-5 → claude-sonnet-4-5-20250929).
//   - system billing header      → cc_version synced to OUR fingerprint's
//                                  CLI version (not the buyer's), FP3
//                                  recomputed against the actual first
//                                  user message in the passthrough body.
//   - system text blocks         → OpenCode-style third-party identity
//                                  sentences swapped for the Claude Code
//                                  banner (same reason as template mode).
//   - temperature, tool_choice   → stripped, sub2api drops these for OAuth
//                                  (gateway_service.go:1082-1092).
//   - stream                     → forced true (daemon always needs the
//                                  SSE wire format to drive parseClaudeSseResponse).
//   - thinking.budget_tokens     → clamped to >= CLAUDE_MIN_THINKING_BUDGET
//                                  so Anthropic's minimum rule doesn't
//                                  400-reject a buyer-chosen small budget.
//
// Everything else (messages, tools, context_management, output_config,
// stop_sequences, max_tokens, …) is forwarded verbatim. The outbound
// headers are built from our cached fingerprint file (pinned UA and
// x-stainless-* per OAuth account), merged with the buyer's
// anthropic-beta flags so new CC versions can still request recent betas
// that our fingerprint file doesn't know about yet.

export interface CallClaudeApiPassthroughOptions {
  // Full buyer request body as parsed JSON. Must contain `model` and
  // `messages` at minimum. Every other Anthropic /v1/messages field is
  // forwarded verbatim except for the surgical rewrites documented above.
  clientBody: Record<string, unknown>;
  // Used for routing/rate-guard + model normalization. Must equal
  // clientBody.model; passed separately so callers don't have to reach
  // into the body.
  model: string;
  // Buyer's `anthropic-beta` header value (comma-joined). Merged with our
  // required betas list — missing values are added, extra values from the
  // buyer are preserved.
  clientBeta?: string;
  // Same callback as template mode — forward each raw SSE frame as it
  // arrives so the Hub can stream tokens in real time.
  onRawEvent?: (rawFrame: string) => void;
}

export async function callClaudeApiPassthrough(
  opts: CallClaudeApiPassthroughOptions
): Promise<ParsedOutput> {
  configureDispatcher();
  if (!rateGuard) configureRateGuard();
  return rateGuard!.run(() => doCallClaudeApiPassthrough(opts));
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

  // Per-request betas + thinking config, picked from the real CLI's
  // per-model logic (see pickClaudeBetasForModel / pickClaudeThinkingConfig).
  // These are two of the strongest fingerprint signals Anthropic could use
  // to distinguish relay traffic from genuine CLI traffic.
  const betasForRequest = pickClaudeBetasForModel(opts.model);
  const { config: thinkingConfig, adjustedMaxTokens } = pickClaudeThinkingConfig(
    opts.model,
    maxTokens
  );

  const body: Record<string, unknown> = {
    model: normalizeModel(opts.model),
    max_tokens: adjustedMaxTokens,
    system: [
      {
        type: "text",
        text: attributionHeader,
      },
      {
        type: "text",
        text: `${CLAUDE_CODE_SYSTEM_PROMPT_LEAD}\n\n${RELAY_INSTRUCTIONS_TEMPLATE}`,
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
    // Real Claude Code ALWAYS sends stream:true on its main path
    // (claude-code-sourcemap/src/services/api/claude.ts:1824 —
    // `{ ...params, stream: true }`). The non-stream call at line 864 is
    // only the fallback path triggered when the stream fails mid-response.
    // Sending stream:false on every request is a statistical signal that
    // Anthropic could use to identify relay clients vs real CLI — the
    // entire account's traffic would be the opposite polarity of what the
    // CLI ever emits. Switch to streaming to match.
    stream: true,
    // NOTE: `betas` is a client-side SDK-only param — the Anthropic SDK
    // strips it out of the body and emits it as the `anthropic-beta`
    // HTTP header. Anthropic's API rejects requests that carry `betas`
    // in the wire body with `betas: Extra inputs are not permitted`.
    // The header is set on the fetch call below, so don't put it here.
  };
  // `thinking` is always set on Claude 4+ models by real CLI. Omitting it
  // would be an account-wide zero-thinking anomaly. Adaptive for 4-6
  // models, enabled+budget for 4-5 / haiku.
  if (thinkingConfig) {
    body.thinking = thinkingConfig;
  }
  const bodyJson = JSON.stringify(body);

  let transientAttempt = 0;
  let hasRefreshed = false;

  while (true) {
    const creds = await getFreshCreds();
    const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        ...STATIC_CLAUDE_CODE_HEADERS,
        // SSE streaming — Anthropic returns event-stream body when
        // stream:true is set in the body. The SDK default sets an accept
        // that includes text/event-stream; we match that exactly.
        "accept": "application/json, text/event-stream",
        // `anthropic-beta` is what the Anthropic SDK generates from the
        // body's `betas` array. We could leave body.betas and drop this
        // header, but some Anthropic deploys check header presence too,
        // so we send both for safety. The values must match.
        "anthropic-beta": betasForRequest.join(","),
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
      // Stream parser — real Claude Code's main path uses stream:true; see
      // body construction above. parseClaudeSseResponse aggregates text
      // deltas + usage until message_stop, matching SDK semantics.
      // When opts.onRawEvent is set, each SSE frame is also forwarded
      // verbatim so the Hub can stream it through to the end client in
      // real time instead of waiting for the whole response.
      const parsed = await parseClaudeSseResponse(resp, opts.model, opts.onRawEvent);
      recordSpendFromUsage(parsed, opts.model);
      return parsed;
    }

    const errText = await resp.text();

    // Real 429 from upstream → engage hard cooldown so we stop hammering.
    // We do NOT retry a 429: any retry would just slam the rate-limited
    // account harder and extend the ban. Parse the reset headers, mark
    // cooldown, and fail this request. Subsequent requests will immediately
    // short-circuit via checkCooldown().
    //
    // Exception: "Extra usage is required" is NOT a rate limit — it's a
    // billing/feature gate (e.g. Sonnet 1M context requires Extra usage
    // credits on Claude Max). Triggering a global 5-minute cooldown for
    // this would block ALL subsequent requests (including Opus, Haiku,
    // non-1M Sonnet) even though they don't need Extra usage. Instead,
    // fail only this request and let others through.
    if (resp.status === 429) {
      const isExtraUsage = errText.toLowerCase().includes("extra usage");
      if (isExtraUsage) {
        logger.warn("[claude-api] 429 Extra usage required — skipping cooldown (not a rate limit)");
        throw new Error(`Anthropic 429 extra-usage-required: ${errText.slice(0, 300)}`);
      }
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

// ── Passthrough helpers ──────────────────────────────────────────────────

// Extract the first user message's text content, regardless of whether
// content is a plain string (OpenAI-style) or an array of content blocks
// (real Anthropic shape). Used for computing the attribution header FP3.
function extractFirstUserMessageText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text" &&
          typeof (block as { text?: string }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
      }
    }
    return "";
  }
  return "";
}

// Merge the fingerprint-required betas with the buyer's anthropic-beta
// list. Required betas (oauth, claude-code, interleaved-thinking) are
// non-negotiable — they must be present for an OAuth token to work. The
// buyer's extras (context-management, advisor-tool, etc.) are appended so
// newer Claude Code versions can request features our fingerprint file
// doesn't know about yet. Deduplicates and preserves order.
function mergeBetas(required: string[], clientBeta: string | undefined): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of required) {
    const t = b.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  if (clientBeta) {
    for (const b of clientBeta.split(",")) {
      const t = b.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out.join(",");
}

// Scan a passthrough body for any `cache_control: {type: "ephemeral",
// ttl: "1h"}` block across tools / system / messages. The presence of
// even one 1h block forces us to upgrade our own injected CC marker in
// system to 1h too, because Anthropic rejects requests where a 1h
// block appears after any 5m block in the global tools→system→messages
// ordering (see long comment in ensureClaudeCodeShell).
//
// Returns true on the first 1h block found — this is a detect-only
// walk, not a rewrite. Safe on malformed bodies (returns false).
function bodyHasExtendedCacheBlock(body: Record<string, unknown>): boolean {
  const isExtendedBlock = (block: unknown): boolean => {
    if (!block || typeof block !== "object") return false;
    const cc = (block as { cache_control?: { ttl?: string } })
      .cache_control;
    if (!cc || typeof cc !== "object") return false;
    return cc.ttl === "1h";
  };

  if (Array.isArray(body.tools)) {
    for (const t of body.tools) {
      if (isExtendedBlock(t)) return true;
    }
  }

  if (Array.isArray(body.system)) {
    for (const b of body.system) {
      if (isExtendedBlock(b)) return true;
    }
  }

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      const content = (m as { content?: unknown }).content;
      // Anthropic messages can carry content either as a string (no
      // cache_control possible) or as an array of content blocks
      // (each of which can carry cache_control). Only the array form
      // matters for this check.
      if (Array.isArray(content)) {
        for (const c of content) {
          if (isExtendedBlock(c)) return true;
        }
      }
    }
  }

  return false;
}

// Ensure a passthrough body carries the full Claude Code fingerprint
// shell that Anthropic's OAuth-endpoint validator expects. Called from
// doCallClaudeApiPassthrough as the last body-munging step before the
// HTTP request goes out.
//
// The three fingerprint-sensitive fields that MUST be present on every
// real Claude Code /v1/messages request:
//
//   1. system[0] = {type:"text", text:"x-anthropic-billing-header: ..."}
//      — always the FIRST block. Contains cc_version.<FP3> where FP3 is
//      SHA256(SALT + chars_from_first_user_msg + cli_version).hex[:3].
//   2. system[i] = {type:"text", text:"You are a Claude agent, built on
//      Anthropic's Claude Agent SDK..."} with cache_control ephemeral.
//      — the template-mode "CC identity marker" that passes the dice-
//      coefficient validator.
//   3. thinking: {type, budget_tokens?} — on Claude 4+ models real CLI
//      always sends this; zero-thinking accounts stand out.
//   4. tools: array (empty [] is fine) — real CLI always sends the
//      field, missing means the request shape doesn't match.
//
// For real Claude Code / anthropic SDK clients that already send a full
// body (via /v1/messages passthrough path), every check here no-ops —
// the body is already in CC shape and we don't touch it.
//
// For OpenAI-SDK-style clients going through /v1/chat/completions (the
// Hub's chat→anthropic converter produces a minimal body), we augment
// with the missing shell fields so the outbound request is
// indistinguishable from a real CC request that happens to have a
// user-provided system prompt and no local tools.
//
// All buyer content (messages, their own system text, their own tools,
// thinking config if they sent one) is preserved.
function ensureClaudeCodeShell(
  body: Record<string, unknown>,
  fingerprint: ResolvedFingerprint
): void {
  // ── Normalize system to an array of content blocks ──
  if (!Array.isArray(body.system)) {
    if (typeof body.system === "string" && body.system.length > 0) {
      // String-shaped system (anthropic SDK convenience form) →
      // wrap in a single text block so we can prepend.
      body.system = [{ type: "text", text: body.system }];
    } else {
      body.system = [];
    }
  }
  const system = body.system as Array<{ type?: string; text?: string; cache_control?: unknown }>;

  // ── Detect CC identity marker anywhere in system ──
  const hasCcMarker = system.some(
    (b) =>
      b &&
      typeof b === "object" &&
      b.type === "text" &&
      typeof b.text === "string" &&
      b.text.includes(CLAUDE_CODE_SYSTEM_PROMPT_LEAD)
  );

  // ── Detect billing header in system[0] ──
  const firstBlock = system[0];
  const hasBillingHeaderFirst =
    !!firstBlock &&
    typeof firstBlock === "object" &&
    firstBlock.type === "text" &&
    typeof firstBlock.text === "string" &&
    firstBlock.text.startsWith("x-anthropic-billing-header:");

  // ── Build the attribution header (always recompute so cc_version + FP3
  // match OUR fingerprint and the buyer's actual first user message) ──
  const firstUserMsg = extractFirstUserMessageText(body.messages);
  const freshHeader = buildClaudeAttributionHeader(
    firstUserMsg,
    fingerprint.cc_version,
    fingerprint.cc_entrypoint
  );

  // ── Inject CC marker if missing ──
  //
  // Anthropic has a hard GLOBAL ordering rule across the whole request:
  // within the linear processing order `tools → system → messages`,
  // any block with `cache_control.ttl="1h"` MUST come before any block
  // with `ttl="5m"`. Not just within one section — globally. A 5m block
  // in system comes before any 1h block in messages and that's a 400.
  //
  // Our injected CC marker lives in system. Its default TTL is 5m
  // (what real Claude Code uses). When a buyer request carries any 1h
  // cache_control block ANYWHERE (their own system, or inside any
  // message content block, or in tools), naively injecting a 5m marker
  // in system causes:
  //   system.N.cache_control.ttl   — when the 1h is in system below us
  //   messages.N.content.M.cache_control.ttl  — when the 1h is in messages
  // Anthropic 400s with:
  //   a ttl='1h' cache_control block must not come after a ttl='5m'
  //   cache_control block. Note that blocks are processed in the
  //   following order: `tools`, `system`, `messages`.
  //
  // Fix: detect whether the buyer's body touches 1h cache anywhere.
  // If yes, upgrade our marker's TTL to 1h too — then the whole request
  // is uniformly 1h from our side, no 1h-after-5m violation possible.
  // If no, keep the default 5m (matches real Claude Code fingerprint).
  //
  // The 1h TTL won't actually materialise extra cost for our marker
  // because our system block is < 1024 tokens and below Anthropic's
  // minimum cache token threshold, so neither 5m nor 1h actually
  // produces a cache write or read. The TTL label is purely a shape
  // marker that unblocks the ordering validator.
  if (!hasCcMarker) {
    const buyerUsesExtendedCache = bodyHasExtendedCacheBlock(body);
    // Passthrough mode: inject ONLY the CC identity lead, no tool
    // suppression. The buyer's Claude Code drives tool use via its own
    // tools array + system prompt. Appending "Do not use tools" here
    // would break WebSearch / Bash / Edit / every other tool.
    const markerBlock = {
      type: "text",
      text: CLAUDE_CODE_SYSTEM_PROMPT_LEAD,
      cache_control: buyerUsesExtendedCache
        ? ({ type: "ephemeral", ttl: "1h" } as const)
        : ({ type: "ephemeral" } as const),
    };
    // Insert position inside system:
    //   - If our marker is 5m: put it AFTER any existing 1h block in
    //     system so system-internal ordering holds (1h-before-5m).
    //   - If our marker is 1h: put it BEFORE any existing 5m block in
    //     system for the same reason (1h-before-5m). No 5m block →
    //     default slot.
    let insertAt = hasBillingHeaderFirst ? 1 : 0;
    if (buyerUsesExtendedCache) {
      for (let i = 0; i < system.length; i++) {
        const cc = (system[i] as { cache_control?: { ttl?: string } })
          ?.cache_control;
        if (cc && typeof cc === "object" && (cc.ttl ?? "5m") === "5m") {
          insertAt = i;
          break;
        }
      }
    } else {
      for (let i = system.length - 1; i >= 0; i--) {
        const cc = (system[i] as { cache_control?: { ttl?: string } })
          ?.cache_control;
        if (cc && typeof cc === "object" && cc.ttl === "1h") {
          insertAt = i + 1;
          break;
        }
      }
    }
    system.splice(insertAt, 0, markerBlock);
  }

  // ── Update or inject billing header at index 0 ──
  if (hasBillingHeaderFirst) {
    // Rewrite in place so cc_version reflects OUR fingerprint, not the
    // buyer's original (which might have been from a different CLI
    // version than our pinned fingerprint).
    (firstBlock as { text: string }).text = freshHeader;
  } else {
    system.unshift({ type: "text", text: freshHeader });
  }

  // ── Ensure tools array exists ──
  if (!Array.isArray(body.tools)) {
    body.tools = [];
  }

  // ── Inject thinking config if missing ──
  // Real CLI always sends this for Claude 4+ models; zero-thinking
  // accounts are a relay-farm tell. pickClaudeThinkingConfig picks the
  // right shape (adaptive for 4-6, enabled-with-budget for 4-5/haiku).
  if (!body.thinking || typeof body.thinking !== "object") {
    const rawMaxTokens =
      typeof body.max_tokens === "number" && body.max_tokens > 0
        ? (body.max_tokens as number)
        : 4096;
    const { config, adjustedMaxTokens } = pickClaudeThinkingConfig(
      (body.model as string) ?? "",
      rawMaxTokens
    );
    if (config) {
      body.thinking = config;
      body.max_tokens = adjustedMaxTokens;
    }
  }
}

// Walk system text blocks and rewrite third-party identity sentences
// (OpenCode, etc.) to the Claude Code banner. sub2api does the same thing
// in gateway_service.go:sanitizeSystemText — without it Anthropic's
// system-prompt dice-coefficient validator will 403 the request because
// the system prompt doesn't score high enough against the known real
// Claude Code templates.
function sanitizePassthroughSystemArray(body: Record<string, unknown>): void {
  if (!Array.isArray(body.system)) return;
  for (const block of body.system) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: string }).text === "string"
    ) {
      (block as { text: string }).text = sanitizePrompt((block as { text: string }).text);
    }
  }
}

async function doCallClaudeApiPassthrough(
  opts: CallClaudeApiPassthroughOptions
): Promise<ParsedOutput> {
  const fingerprint = loadFingerprint();
  autoBumpFingerprintUaVersion();
  // Fresh read after any autobump, since it mutates cachedFingerprint in place.
  const fp = loadFingerprint();

  const sessionId = getMaskedSessionId();

  // Shallow clone so we don't mutate the buyer's dict on the way back out
  // of provider.ts — defensive against the Hub reusing the same dict for
  // multiple dispatch attempts.
  const body: Record<string, unknown> = { ...opts.clientBody };

  // Normalize model to canonical long-form. Anthropic OAuth rejects the
  // short form for some versions (e.g. claude-sonnet-4-5 → must be
  // claude-sonnet-4-5-20250929).
  body.model = normalizeModel(opts.model);

  // Force stream:true. Daemon always needs SSE wire format to drive
  // parseClaudeSseResponse, regardless of what the buyer asked for.
  body.stream = true;

  // sub2api drops these on OAuth (gateway_service.go:1082-1092). Keeping
  // them in the body risks Anthropic flagging the request shape as
  // non-Claude-Code, since real CC never sends them.
  delete body.temperature;
  delete body.tool_choice;

  // Rewrite metadata.user_id with our masked-session-bound fingerprint
  // identity. All other metadata fields are preserved.
  const metadata =
    body.metadata && typeof body.metadata === "object"
      ? (body.metadata as Record<string, unknown>)
      : {};
  body.metadata = {
    ...metadata,
    user_id: buildMetadataUserID(fp, sessionId),
  };

  // Sanitize system: replace third-party identity sentences + sync
  // billing header cc_version to match our pinned CLI version.
  sanitizePassthroughSystemArray(body);
  ensureClaudeCodeShell(body, fp);

  // Clamp thinking.budget_tokens to Anthropic's minimum so buyer-chosen
  // small budgets don't 400. If max_tokens < budget_tokens + 1, bump
  // max_tokens too so the request stays valid.
  const thinking = body.thinking;
  if (thinking && typeof thinking === "object") {
    const t = thinking as { type?: string; budget_tokens?: number };
    if (t.type === "enabled" && typeof t.budget_tokens === "number") {
      if (t.budget_tokens < CLAUDE_MIN_THINKING_BUDGET) {
        t.budget_tokens = CLAUDE_MIN_THINKING_BUDGET;
      }
      if (
        typeof body.max_tokens === "number" &&
        (body.max_tokens as number) <= t.budget_tokens
      ) {
        body.max_tokens = t.budget_tokens + 1;
      }
    }
  }

  // Ensure tools is at least an empty array so request shape matches real
  // CC (which always sends tools even if empty).
  if (!Array.isArray(body.tools)) {
    body.tools = [];
  }

  const bodyJson = JSON.stringify(body);

  // Merge required betas with buyer's betas for the header.
  const requiredBetas = pickClaudeBetasForModel(opts.model);
  const mergedBetas = mergeBetas(requiredBetas, opts.clientBeta);

  let transientAttempt = 0;
  let hasRefreshed = false;

  while (true) {
    const creds = await getFreshCreds();
    const resp = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        ...STATIC_CLAUDE_CODE_HEADERS,
        "accept": "application/json, text/event-stream",
        "anthropic-beta": mergedBetas,
        "user-agent": fp.user_agent,
        "authorization": `Bearer ${creds.accessToken}`,
        "x-claude-code-session-id": sessionId,
      },
      body: bodyJson,
    });

    const sessionWin = extractSessionWindowFromHeaders(resp.headers);
    if (sessionWin) rateGuard?.setSessionWindow(sessionWin);

    if (resp.ok) {
      const parsed = await parseClaudeSseResponse(resp, opts.model, opts.onRawEvent);
      recordSpendFromUsage(parsed, opts.model);
      return parsed;
    }

    const errText = await resp.text();

    if (resp.status === 429) {
      const isExtraUsage = errText.toLowerCase().includes("extra usage");
      if (isExtraUsage) {
        logger.warn("[claude-api] 429 Extra usage required (passthrough) — skipping cooldown");
        throw new Error(`Anthropic 429 extra-usage-required: ${errText.slice(0, 300)}`);
      }
      const cooldown = extractCooldownUntilFromHeaders(resp.headers);
      if (cooldown && rateGuard) {
        rateGuard.triggerCooldown(cooldown.untilMs, cooldown.reason);
      } else if (rateGuard) {
        rateGuard.triggerCooldown(Date.now() + 5 * 60_000, "fallback 5m (no reset header)");
      }
      throw new Error(`Anthropic 429 rate-limited: ${errText.slice(0, 300)}`);
    }

    if (resp.status === 401 && !hasRefreshed) {
      logger.warn("[claude-api] 401 from upstream (passthrough), refreshing token + retry");
      hasRefreshed = true;
      cachedCreds = null;
      continue;
    }

    const isTransient = resp.status >= 500 && resp.status <= 599;
    if (isTransient && transientAttempt < MAX_TRANSIENT_RETRIES) {
      const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
      const backoffMs =
        retryAfter ?? 500 * Math.pow(2, transientAttempt) + Math.random() * 500;
      logger.warn(
        `[claude-api] ${resp.status} from upstream (passthrough attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(backoffMs)}ms — ${errText.slice(0, 200)}`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      transientAttempt++;
      continue;
    }

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

/**
 * Parse an Anthropic SSE `/v1/messages` stream response into a ParsedOutput.
 *
 * Wire format (Anthropic docs — beta.messages.create({stream: true})):
 *
 *   event: message_start
 *   data: {"type":"message_start","message":{"id":"...","model":"...","usage":{"input_tokens":10,...}}}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *
 *   ... more deltas ...
 *
 *   event: content_block_stop
 *   data: {"type":"content_block_stop","index":0}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 *   event: ping            (keepalive — ignore)
 *
 *   event: error           (upstream error — throw)
 *   data: {"type":"error","error":{"type":"overloaded_error","message":"..."}}
 */
async function parseClaudeSseResponse(
  resp: Response,
  fallbackModel: string,
  onRawFrame?: (rawFrame: string) => void
): Promise<ParsedOutput> {
  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error("Claude streamGenerateContent returned no body");
  }
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let text = "";
  let model = fallbackModel;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;
  let streamError: { type?: string; message?: string } | undefined;
  // Accumulates one SSE frame (everything between blank lines) so we can
  // emit the full `event: X\ndata: Y\n\n` block via onRawFrame. SSE frames
  // are terminated by an empty line per the spec.
  let frameLines: string[] = [];

  const processChunk = (jsonStr: string): void => {
    const trimmed = jsonStr.trim();
    if (!trimmed) return;
    type Chunk = {
      type?: string;
      message?: {
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
      delta?: { type?: string; text?: string };
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      error?: { type?: string; message?: string };
    };
    let chunk: Chunk;
    try {
      chunk = JSON.parse(trimmed) as Chunk;
    } catch {
      return;
    }
    switch (chunk.type) {
      case "message_start": {
        if (chunk.message?.model) model = chunk.message.model;
        const u = chunk.message?.usage;
        if (u) {
          if (typeof u.input_tokens === "number") inputTokens = u.input_tokens;
          if (typeof u.output_tokens === "number") outputTokens = u.output_tokens;
          if (typeof u.cache_creation_input_tokens === "number") {
            cacheCreation = u.cache_creation_input_tokens;
          }
          if (typeof u.cache_read_input_tokens === "number") {
            cacheRead = u.cache_read_input_tokens;
          }
        }
        break;
      }
      case "content_block_delta": {
        // We only accumulate text_delta. input_json_delta is for tool calls,
        // which we don't surface from the relay path (the buyer gets the
        // model's final text response, not in-flight tool plumbing).
        if (chunk.delta?.type === "text_delta" && typeof chunk.delta.text === "string") {
          text += chunk.delta.text;
        }
        break;
      }
      case "message_delta": {
        // message_delta carries the final output_tokens count and
        // potentially an updated usage (e.g. cache hits applied late).
        const u = chunk.usage;
        if (u) {
          if (typeof u.output_tokens === "number") outputTokens = u.output_tokens;
          if (typeof u.input_tokens === "number") inputTokens = u.input_tokens;
          if (typeof u.cache_creation_input_tokens === "number") {
            cacheCreation = u.cache_creation_input_tokens;
          }
          if (typeof u.cache_read_input_tokens === "number") {
            cacheRead = u.cache_read_input_tokens;
          }
        }
        break;
      }
      case "error": {
        streamError = chunk.error;
        break;
      }
      // message_stop / content_block_start / content_block_stop / ping —
      // structural, nothing to accumulate.
      default:
        break;
    }
  };

  const flushFrame = (): void => {
    if (frameLines.length === 0) return;
    // Forward the raw SSE frame verbatim so consumers see it exactly as
    // Anthropic emitted it (including the event: name line, which Claude
    // Code's SDK parser uses as the dispatch key).
    if (onRawFrame) {
      onRawFrame(frameLines.join("\n") + "\n\n");
    }
    for (const line of frameLines) {
      if (line.startsWith("data:")) {
        processChunk(line.slice(5));
      }
    }
    frameLines = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
      buffer = buffer.slice(newlineIdx + 1);
      if (line === "") {
        // Blank line = end of SSE frame.
        flushFrame();
      } else {
        frameLines.push(line);
      }
    }
  }
  // Flush any trailing frame without a final blank line. Rare, but SSE
  // allows a stream to end without a terminating \n\n.
  flushFrame();

  if (streamError) {
    throw new Error(
      `Anthropic stream error: ${streamError.type ?? "unknown"} — ${streamError.message ?? ""}`
    );
  }

  return {
    text,
    sessionId: "",
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_tokens: cacheCreation,
      cache_read_tokens: cacheRead,
    },
    model,
    costUsd: 0,
  };
}
