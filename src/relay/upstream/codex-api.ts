/**
 * Direct chatgpt.com upstream for Codex (ChatGPT Plus/Pro) OAuth subscriptions.
 *
 * Mirrors claude-api.ts structure exactly: same export shape, same error types,
 * same RateGuard integration, same OAuth refresh + persist-back pattern, same
 * fingerprint file loading, same 5xx retry path, same preflight function.
 *
 * Key differences from claude-api.ts:
 *  - Token source: ~/.codex/auth.json (written by the Codex CLI)
 *  - Upstream: https://chatgpt.com/backend-api/codex/responses (Responses API)
 *  - Request body is OpenAI Responses API shape (input[], instructions, model, store, stream)
 *  - Response is always SSE; we consume it internally and return ParsedOutput
 *  - Session headers: session_id + conversation_id (not x-claude-code-session-id)
 *  - Rate-limit headers: x-codex-primary-* / x-codex-secondary-*
 *  - No per-request device_id/account_uuid metadata — chatgpt-account-id header instead
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { relayLogger as logger } from "../logger.js";
import {
  RateGuard,
  RateGuardBudgetExceededError,
  RateGuardCooldownError,
} from "./rate-guard.js";
import { calculateCost } from "../pricing.js";

export { RateGuardBudgetExceededError, RateGuardCooldownError };

// ── Constants ──

const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

const CODEX_AUTH_FILE = join(homedir(), ".codex", "auth.json");
const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_FILE = join(CLAWMONEY_DIR, "codex-fingerprint.json");

// Codex CLI version hardcoded from sub2api (openai_gateway_service.go:codexCLIVersion).
// Auto-bumped at runtime from local `codex --version` if newer.
const DEFAULT_CLI_VERSION = "0.104.0";
const DEFAULT_USER_AGENT = `codex_cli_rs/${DEFAULT_CLI_VERSION}`;
// originator must match CodexOfficialClientOriginatorPrefixes (codex_ prefix).
const DEFAULT_ORIGINATOR = "codex_cli_rs";

// OpenAI Responses API requires this beta flag for OAuth (ChatGPT) accounts.
const OPENAI_BETA_HEADER = "responses=experimental";

const REFRESH_SKEW_MS = 3 * 60 * 1000;
const MASKED_SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_TRANSIENT_RETRIES = 2;

// Default relay instructions for Codex. Upstream treats `instructions` as
// the system prompt. Keep minimal so the buyer's prompt gets full focus.
const RELAY_INSTRUCTIONS =
  "You are a helpful AI assistant operating in relay mode. Respond to the user's message with plain text only. Be concise.";

// ── Types ──

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens: {
    id_token?: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh?: string;
}

interface LoadedCreds {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  expiresAt: number;
  _rawFile: CodexAuthFile;
}

interface CodexFingerprint {
  user_agent: string;
  cli_version: string;
  originator: string;
}

interface ResolvedFingerprint {
  user_agent: string;
  cli_version: string;
  originator: string;
}

// ── Proxy ──

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
    logger.warn(`[codex-api] ignoring non-HTTP proxy ${url} (SOCKS not supported)`);
    return;
  }
  setGlobalDispatcher(new ProxyAgent(url) as unknown as Dispatcher);
  logger.info(`[codex-api] upstream proxy ${url}`);
}

// ── Fingerprint ──

let cachedFingerprint: ResolvedFingerprint | null = null;

function loadCodexFingerprint(): ResolvedFingerprint {
  if (cachedFingerprint) return cachedFingerprint;
  if (!existsSync(FINGERPRINT_FILE)) {
    logger.warn(
      `[codex-api] fingerprint not found at ${FINGERPRINT_FILE} — using defaults. ` +
      `Run \`node scripts/capture-codex-request.mjs\` then ` +
      `\`OPENAI_BASE_URL=http://127.0.0.1:8788/v1 codex exec "hi"\` to bootstrap.`
    );
    cachedFingerprint = {
      user_agent: DEFAULT_USER_AGENT,
      cli_version: DEFAULT_CLI_VERSION,
      originator: DEFAULT_ORIGINATOR,
    };
    return cachedFingerprint;
  }
  const raw = JSON.parse(readFileSync(FINGERPRINT_FILE, "utf-8")) as Partial<CodexFingerprint>;
  cachedFingerprint = {
    user_agent: raw.user_agent ?? DEFAULT_USER_AGENT,
    cli_version: raw.cli_version ?? DEFAULT_CLI_VERSION,
    originator: raw.originator ?? DEFAULT_ORIGINATOR,
  };
  logger.info(
    `[codex-api] fingerprint loaded (ua=${cachedFingerprint.user_agent}, originator=${cachedFingerprint.originator})`
  );
  return cachedFingerprint;
}

// ── JWT exp decode ──
//
// Codex auth.json has no explicit expiresAt field — expiry is embedded in
// the access_token JWT. We decode the payload (no signature validation;
// we only need the exp timestamp for cache invalidation). Falls back to
// Date.now() + 1h if decoding fails so we don't refuse to serve.

function decodeJwtExp(jwt: string): number {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return Date.now() + 3600 * 1000;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "==".slice((payload.length + 3) % 4);
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as {
      exp?: number;
    };
    if (typeof decoded.exp === "number" && decoded.exp > 0) {
      return decoded.exp * 1000;
    }
  } catch {
    // fall through
  }
  return Date.now() + 3600 * 1000;
}

// ── Credential I/O ──

function loadCodexAuth(): LoadedCreds {
  if (!existsSync(CODEX_AUTH_FILE)) {
    throw new Error(
      `Codex auth not found at ${CODEX_AUTH_FILE}. Log in with \`codex login\` first.`
    );
  }
  const raw = JSON.parse(readFileSync(CODEX_AUTH_FILE, "utf-8")) as CodexAuthFile;
  const tok = raw?.tokens;
  if (!tok?.access_token || !tok?.refresh_token || !tok?.account_id) {
    throw new Error(
      `Codex auth.json missing required fields (tokens.access_token / tokens.refresh_token / tokens.account_id)`
    );
  }
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    accountId: tok.account_id,
    expiresAt: decodeJwtExp(tok.access_token),
    _rawFile: raw,
  };
}

function writeCodexAuth(file: CodexAuthFile): void {
  writeFileSync(CODEX_AUTH_FILE, JSON.stringify(file, null, 2), "utf-8");
}

// ── OAuth refresh ──

interface RefreshedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function refreshUpstreamToken(refreshToken: string): Promise<RefreshedToken> {
  // OpenAI refresh uses form-encoded body (see sub2api openai/pkg/oauth.go).
  // Scope: "openid profile email" (drops offline_access on refresh).
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: "openid profile email",
  });
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": DEFAULT_USER_AGENT,
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Codex token refresh failed: ${resp.status} ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const newAt = data.access_token;
  return {
    accessToken: newAt,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : decodeJwtExp(newAt),
  };
}

// ── Token cache ──

let cachedCreds: LoadedCreds | null = null;
let refreshInflight: Promise<LoadedCreds> | null = null;

async function doRefreshAndPersist(current: LoadedCreds): Promise<LoadedCreds> {
  logger.info("[codex-api] refreshing OAuth token...");
  const fresh = await refreshUpstreamToken(current.refreshToken);
  const updatedFile: CodexAuthFile = {
    ...current._rawFile,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...current._rawFile.tokens,
      access_token: fresh.accessToken,
      refresh_token: fresh.refreshToken,
    },
  };
  try {
    writeCodexAuth(updatedFile);
    logger.info("[codex-api] ~/.codex/auth.json updated");
  } catch (err) {
    logger.warn(`[codex-api] failed to persist refreshed token: ${(err as Error).message}`);
  }
  return {
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    accountId: current.accountId,
    expiresAt: fresh.expiresAt,
    _rawFile: updatedFile,
  };
}

async function getFreshCreds(): Promise<LoadedCreds> {
  if (!cachedCreds) {
    cachedCreds = loadCodexAuth();
  }
  if (Date.now() < cachedCreds.expiresAt - REFRESH_SKEW_MS) {
    return cachedCreds;
  }
  if (!refreshInflight) {
    const prior = cachedCreds;
    refreshInflight = doRefreshAndPersist(prior).finally(() => {
      refreshInflight = null;
    });
  }
  cachedCreds = await refreshInflight;
  return cachedCreds;
}

// ── Masked session id (15-minute sliding window) ──

let maskedSessionId: string | null = null;
let maskedSessionLastUsedMs = 0;

function getMaskedSessionId(): string {
  const now = Date.now();
  if (maskedSessionId && now - maskedSessionLastUsedMs < MASKED_SESSION_TTL_MS) {
    maskedSessionLastUsedMs = now;
    return maskedSessionId;
  }
  maskedSessionId = randomUUID();
  maskedSessionLastUsedMs = now;
  logger.info(
    `[codex-api] new masked session_id ${maskedSessionId.slice(0, 8)}... (previous expired)`
  );
  return maskedSessionId;
}

// ── Rate-limit header parsing ──
//
// ChatGPT Codex rate limit headers:
//   x-codex-primary-used-percent / x-codex-primary-reset-after-seconds
//   x-codex-secondary-used-percent / x-codex-secondary-reset-after-seconds
// Pick the nearest real reset time to drive rate-guard cooldown.

function parseCodexRateLimitHeaders(headers: Headers): {
  ms: number;
  reason: string;
} | null {
  function getMs(resetAfterSecondsHeader: string): number | null {
    const raw = headers.get(resetAfterSecondsHeader);
    if (!raw) return null;
    const secs = Number(raw);
    if (!Number.isFinite(secs) || secs <= 0) return null;
    return Date.now() + secs * 1000;
  }
  const primary = getMs("x-codex-primary-reset-after-seconds");
  const secondary = getMs("x-codex-secondary-reset-after-seconds");
  const retryAfterRaw = headers.get("retry-after");
  let retryAfterMs: number | null = null;
  if (retryAfterRaw) {
    const s = Number(retryAfterRaw);
    retryAfterMs = Number.isFinite(s) && s >= 0 ? Date.now() + s * 1000 : null;
  }
  const candidates: Array<{ ms: number; reason: string }> = [];
  if (primary) candidates.push({ ms: primary, reason: "codex primary window" });
  if (secondary) candidates.push({ ms: secondary, reason: "codex secondary window" });
  if (retryAfterMs) candidates.push({ ms: retryAfterMs, reason: "retry-after" });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.ms - b.ms);
  return candidates[0];
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
  const cleaned = Object.fromEntries(
    Object.entries(mapped).filter(([, v]) => v !== undefined)
  );
  rateGuard = new RateGuard(cleaned);
  const cfg = (rateGuard as unknown as { cfg: { maxConcurrency: number; quietHoursMaxConcurrency: number; dailyBudgetUsd: number } }).cfg;
  logger.info(
    `[codex-api] rate-guard active (concurrency_active=${cfg.maxConcurrency}, quiet=${cfg.quietHoursMaxConcurrency}, daily_budget=$${cfg.dailyBudgetUsd})`
  );
}

export function getRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null {
  return rateGuard?.currentLoad() ?? null;
}

export async function preflightCodexApi(config?: RelayRateGuardConfig): Promise<void> {
  configureDispatcher();
  configureRateGuard(config);
  loadCodexFingerprint();
  await getFreshCreds();
  logger.info(
    `[codex-api] preflight OK (account_id=***${cachedCreds?.accountId?.slice(-6) ?? "?"}, expires=${new Date(cachedCreds?.expiresAt ?? 0).toISOString()})`
  );
}

// ── Responses API request builder ──

function buildRequestBody(prompt: string, model: string, _maxTokens?: number): object {
  const body: Record<string, unknown> = {
    model,
    input: [
      {
        type: "message",
        role: "user",
        content: prompt,
      },
    ],
    instructions: RELAY_INSTRUCTIONS,
    // OAuth → ChatGPT internal API requires store=false.
    store: false,
    // Internal endpoint always returns SSE; we consume it internally.
    stream: true,
  };
  // max_output_tokens is stripped by the Codex transform layer upstream —
  // deliberately omitted to avoid 400s.
  return body;
}

// ── SSE parser ──
//
// Upstream always returns text/event-stream. We accumulate deltas and pull
// the terminal `response.done` (or `response.completed`) event for usage
// and the final output[] text.

interface ParsedSSEResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  model: string;
}

function parseCodexSSE(sseBody: string, fallbackModel: string): ParsedSSEResult {
  const lines = sseBody.split("\n");
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let model = fallbackModel;
  const deltaTexts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = evt["type"] as string | undefined;

    if (type === "response.output_text.delta") {
      const delta = evt["delta"] as string | undefined;
      if (delta) deltaTexts.push(delta);
    }

    if (type === "response.done" || type === "response.completed") {
      const resp = evt["response"] as Record<string, unknown> | undefined;
      if (!resp) continue;

      if (typeof resp["model"] === "string") {
        model = resp["model"];
      }

      const usage = resp["usage"] as Record<string, unknown> | undefined;
      if (usage) {
        inputTokens = Number(usage["input_tokens"] ?? 0);
        outputTokens = Number(usage["output_tokens"] ?? 0);
        const details = usage["input_tokens_details"] as Record<string, unknown> | undefined;
        if (details) {
          cacheReadTokens = Number(details["cached_tokens"] ?? 0);
        }
      }

      const output = resp["output"] as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(output) && output.length > 0) {
        const parts: string[] = [];
        for (const item of output) {
          const content = item["content"] as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(content)) continue;
          for (const part of content) {
            if (part["type"] === "output_text" && typeof part["text"] === "string") {
              parts.push(part["text"] as string);
            }
          }
        }
        if (parts.length > 0) {
          text = parts.join("");
        }
      }
    }
  }

  if (!text && deltaTexts.length > 0) {
    text = deltaTexts.join("");
  }

  return { text, inputTokens, outputTokens, cacheReadTokens, model };
}

// ── Retry-After helper ──

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

// ── Core API call ──

export interface CallCodexApiOptions {
  prompt: string;
  model: string;
  maxTokens?: number;
}

export async function callCodexApi(opts: CallCodexApiOptions): Promise<ParsedOutput> {
  configureDispatcher();
  if (!rateGuard) configureRateGuard();
  return rateGuard!.run(() => doCallCodexApi(opts));
}

async function doCallCodexApi(opts: CallCodexApiOptions): Promise<ParsedOutput> {
  const prompt = (opts.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Empty prompt");
  }

  const fingerprint = loadCodexFingerprint();
  const sessionId = getMaskedSessionId();
  const requestBody = buildRequestBody(prompt, opts.model, opts.maxTokens);
  const bodyJson = JSON.stringify(requestBody);

  let transientAttempt = 0;
  let hasRefreshed = false;

  while (true) {
    const creds = await getFreshCreds();

    const resp = await fetch(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: {
        "accept": "text/event-stream",
        "content-type": "application/json",
        "authorization": `Bearer ${creds.accessToken}`,
        "user-agent": fingerprint.user_agent,
        "originator": fingerprint.originator,
        "openai-beta": OPENAI_BETA_HEADER,
        // Required for ChatGPT internal API — identifies the subscription account.
        "chatgpt-account-id": creds.accountId,
        // Masked session identifiers — same value for 15 min so upstream
        // sees a persistent session, not one-shot bot-like sessions.
        "session_id": sessionId,
        "conversation_id": sessionId,
      },
      body: bodyJson,
    });

    if (resp.ok) {
      const sseBody = await resp.text();
      const parsed = parseCodexSSE(sseBody, opts.model);
      const result: ParsedOutput = {
        text: parsed.text,
        sessionId,
        usage: {
          input_tokens: parsed.inputTokens,
          output_tokens: parsed.outputTokens,
          cache_creation_tokens: 0,
          cache_read_tokens: parsed.cacheReadTokens,
        },
        model: parsed.model,
        costUsd: 0,
      };
      if (rateGuard) {
        const cost = calculateCost(
          opts.model,
          result.usage.input_tokens,
          result.usage.output_tokens,
          result.usage.cache_creation_tokens,
          result.usage.cache_read_tokens,
        );
        rateGuard.recordSpend(cost.apiCost);
        result.costUsd = cost.apiCost;
      }
      logger.info(
        `[codex-api] OK model=${parsed.model} in=${parsed.inputTokens} out=${parsed.outputTokens} cache_read=${parsed.cacheReadTokens}`
      );
      return result;
    }

    const errText = await resp.text();

    if (resp.status === 429) {
      const cooldown = parseCodexRateLimitHeaders(resp.headers);
      if (cooldown && rateGuard) {
        rateGuard.triggerCooldown(cooldown.ms, cooldown.reason);
      } else if (rateGuard) {
        rateGuard.triggerCooldown(Date.now() + 5 * 60_000, "fallback 5m (no reset header)");
      }
      throw new Error(`Codex 429 rate-limited: ${errText.slice(0, 300)}`);
    }

    if (resp.status === 401 && !hasRefreshed) {
      logger.warn("[codex-api] 401 from upstream, refreshing token + retry");
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
        `[codex-api] ${resp.status} from upstream (attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(backoffMs)}ms — ${errText.slice(0, 200)}`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      transientAttempt++;
      continue;
    }

    throw new Error(`Codex ${resp.status}: ${errText.slice(0, 400)}`);
  }
}
