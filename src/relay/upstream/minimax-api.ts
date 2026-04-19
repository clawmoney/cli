/**
 * MiniMax adapter — OAuth Coding Plan + API-key.
 *
 * Unlike the static-key passthrough adapters in passthrough-api.ts, MiniMax
 * supports an OAuth-flavored "Coding Plan" subscription that openclaw
 * captures under provider="minimax-portal". Tokens there have refresh tokens
 * and expiry timestamps — we honor them the same way codex-api.ts honors
 * ChatGPT OAuth.
 *
 * Endpoint shape is OpenAI-compatible (`/v1/chat/completions`), so we reuse
 * the OpenAI SSE wire without the Anthropic /v1/messages complexity — the
 * `/anthropic` route on the same host is available but needs Anthropic-style
 * SSE parsing which is out of scope for MVP. Setting
 * `MINIMAX_USE_ANTHROPIC_PATH=1` is reserved for a future switch.
 *
 * Credential source order:
 *   1. OpenClaw oauth profile provider="minimax-portal"
 *   2. Openclaw api_key profile provider="minimax"
 *   3. Env var MINIMAX_API_KEY
 *
 * Refresh: best-effort standard OAuth2 refresh against `{baseUrl}/oauth/token`
 * with grant_type=refresh_token. If refresh fails we throw a clear error
 * telling the operator to re-run `openclaw onboard --auth-choice minimax-*-oauth`.
 */

import { fetch, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { relayLogger as logger } from "../logger.js";
import {
  RateGuard,
  RateGuardBudgetExceededError,
  RateGuardCooldownError,
} from "./rate-guard.js";
import { calculateCost } from "../pricing.js";
import {
  readOpenclawOAuthProfile,
  readOpenclawApiKeyProfile,
  persistOpenclawOAuthProfile,
  type OpenclawOAuthProfile,
} from "./openclaw-creds.js";

export { RateGuardBudgetExceededError, RateGuardCooldownError };

// MiniMax OAuth uses a single public client_id across both regions; see
// openclaw dist/oauth-Cu6Z5hHM.js:MINIMAX_OAUTH_CONFIG. Not a secret — the
// whole device-code flow is PKCE-protected so leaking the client_id is fine.
const MINIMAX_OAUTH_CLIENT_ID = "78257093-7e40-4613-99e0-527b14b39113";

// Refresh proactively when within 3 minutes of expiry. Matches claude-api
// and codex-api REFRESH_SKEW_MS for consistency.
const REFRESH_SKEW_MS = 3 * 60 * 1000;

type CredsSource = "openclaw-oauth" | "openclaw-apikey" | "env";

interface LoadedCreds {
  source: CredsSource;
  /** Bearer token we send upstream. */
  accessToken: string;
  /** Present only when source === "openclaw-oauth". */
  refreshToken?: string;
  /** Expiry (ms since epoch) when known; Infinity for static keys. */
  expiresAt: number;
  /**
   * When the openclaw oauth profile carried a resource_url we prefer it as
   * the upstream base (same host the OAuth token was minted against). Falls
   * back to the region default otherwise.
   */
  baseUrl: string;
  /** OAuth profile handle for writeback; populated when source === "openclaw-oauth". */
  openclawProfile?: OpenclawOAuthProfile;
}

// ── Base URL resolution ──────────────────────────────────────────────────

const MINIMAX_GLOBAL = "https://api.minimax.io";
const MINIMAX_CN = "https://api.minimaxi.com";

function resolveRegionBaseUrl(): string {
  const override = process.env.MINIMAX_BASE_URL;
  if (override && override.length > 0) return override.replace(/\/+$/, "");
  const region = (process.env.MINIMAX_REGION ?? "global").toLowerCase();
  return region === "cn" ? MINIMAX_CN : MINIMAX_GLOBAL;
}

/**
 * Strip a trailing `/oauth`, `/anthropic`, `/v1` etc. — the resource_url
 * returned by the oauth endpoint points at the API root but some older
 * openclaw versions may have stored a path-qualified variant. Keep callers
 * free to append their own path suffixes.
 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/(oauth|anthropic|v1)\/?$/, "").replace(/\/+$/, "");
}

// ── Dispatcher ───────────────────────────────────────────────────────────

let dispatcherConfigured = false;
function configureDispatcher(): void {
  if (dispatcherConfigured) return;
  const proxyUrl =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl) as unknown as Dispatcher);
    logger.info(`[minimax-api] upstream proxy ${proxyUrl}`);
  }
  dispatcherConfigured = true;
}

// ── Credential I/O ───────────────────────────────────────────────────────

function loadCreds(): LoadedCreds {
  const oauthProfile = readOpenclawOAuthProfile("minimax-portal");
  if (oauthProfile) {
    logger.info(
      `[minimax-api] using OpenClaw OAuth fallback (profile=${oauthProfile.profileKey}, store=${oauthProfile.storePath})`
    );
    return {
      source: "openclaw-oauth",
      accessToken: oauthProfile.access,
      refreshToken: oauthProfile.refresh,
      expiresAt: oauthProfile.expires,
      baseUrl: oauthProfile.resourceUrl
        ? normalizeBaseUrl(oauthProfile.resourceUrl)
        : resolveRegionBaseUrl(),
      openclawProfile: oauthProfile,
    };
  }

  const apiKeyProfile = readOpenclawApiKeyProfile("minimax");
  if (apiKeyProfile) {
    logger.info(
      `[minimax-api] using OpenClaw api_key fallback (profile=${apiKeyProfile.profileKey})`
    );
    return {
      source: "openclaw-apikey",
      accessToken: apiKeyProfile.key,
      expiresAt: Infinity,
      baseUrl: resolveRegionBaseUrl(),
    };
  }

  const envKey = process.env.MINIMAX_API_KEY;
  if (envKey && envKey.length > 0) {
    return {
      source: "env",
      accessToken: envKey,
      expiresAt: Infinity,
      baseUrl: resolveRegionBaseUrl(),
    };
  }

  throw new Error(
    "MiniMax credentials not found (checked openclaw minimax-portal OAuth + minimax api_key + env MINIMAX_API_KEY). " +
      "Run `openclaw onboard --auth-choice minimax-global-oauth` or `export MINIMAX_API_KEY=...`."
  );
}

interface RefreshedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  resourceUrl?: string;
}

async function refreshUpstreamToken(
  baseUrl: string,
  refreshToken: string
): Promise<RefreshedToken> {
  const url = `${normalizeBaseUrl(baseUrl)}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: MINIMAX_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MiniMax token refresh failed: ${resp.status} ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    // MiniMax docs use `expired_in` (sic) in the original OAuth flow; we
    // accept either `expires_in` (RFC 6749 standard) or `expired_in` to
    // be robust.
    expires_in?: number;
    expired_in?: number;
    resource_url?: string;
  };
  if (!data.access_token) {
    throw new Error("MiniMax refresh response missing access_token");
  }
  const expiresIn = data.expires_in ?? data.expired_in ?? 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    // MiniMax's `expired_in` has been observed in two forms:
    //   - a RFC 6749 TTL in seconds (small number, e.g. 3600)
    //   - a unix timestamp in ms (huge number)
    // Heuristic: if the value exceeds 10^10 treat it as ms-since-epoch,
    // otherwise as a TTL in seconds.
    expiresAt: expiresIn > 1e10 ? expiresIn : Date.now() + expiresIn * 1000,
    resourceUrl: data.resource_url,
  };
}

let cachedCreds: LoadedCreds | null = null;
let refreshInflight: Promise<LoadedCreds> | null = null;

async function doRefreshAndPersist(current: LoadedCreds): Promise<LoadedCreds> {
  if (current.source !== "openclaw-oauth" || !current.refreshToken || !current.openclawProfile) {
    // Static key — nothing to refresh.
    return current;
  }
  logger.info(`[minimax-api] refreshing OAuth token (source=${current.source})...`);
  const fresh = await refreshUpstreamToken(current.baseUrl, current.refreshToken);

  try {
    persistOpenclawOAuthProfile(current.openclawProfile, {
      access: fresh.accessToken,
      refresh: fresh.refreshToken,
      expires: fresh.expiresAt,
      resourceUrl: fresh.resourceUrl,
    });
    logger.info(
      `[minimax-api] OpenClaw profile ${current.openclawProfile.profileKey} updated (${current.openclawProfile.storePath})`
    );
  } catch (err) {
    logger.error(
      `[minimax-api] CRITICAL: openclaw persist failed — keeping old token to avoid account-hijack detection signal: ${(err as Error).message}`
    );
    return current;
  }

  const nextBaseUrl = fresh.resourceUrl
    ? normalizeBaseUrl(fresh.resourceUrl)
    : current.baseUrl;
  return {
    ...current,
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    expiresAt: fresh.expiresAt,
    baseUrl: nextBaseUrl,
    openclawProfile: {
      ...current.openclawProfile,
      access: fresh.accessToken,
      refresh: fresh.refreshToken,
      expires: fresh.expiresAt,
      resourceUrl: fresh.resourceUrl ?? current.openclawProfile.resourceUrl,
    },
  };
}

async function getFreshCreds(): Promise<LoadedCreds> {
  if (!cachedCreds) {
    cachedCreds = loadCreds();
  }
  if (cachedCreds.source !== "openclaw-oauth") {
    return cachedCreds;
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

// ── Rate guard ───────────────────────────────────────────────────────────

let rateGuard: RateGuard | null = null;

export function configureMinimaxRateGuard(config?: RelayRateGuardConfig): void {
  rateGuard = new RateGuard(
    config
      ? {
          maxConcurrency: config.max_concurrency,
          quietHoursMaxConcurrency: config.quiet_hours_max_concurrency,
          quietHours: config.quiet_hours,
          minRequestGapMs: config.min_request_gap_ms,
          jitterMs: config.jitter_ms,
          dailyBudgetUsd: config.daily_budget_usd,
          maxRelayUtilization: config.max_relay_utilization,
        }
      : {}
  );
}

export function getMinimaxRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null {
  return rateGuard ? rateGuard.currentLoad() : null;
}

// ── Preflight ────────────────────────────────────────────────────────────

export async function preflightMinimaxApi(config?: RelayRateGuardConfig): Promise<void> {
  configureDispatcher();
  if (!rateGuard) configureMinimaxRateGuard(config);
  const creds = await getFreshCreds();
  const expLabel =
    creds.expiresAt === Infinity
      ? "never"
      : `${Math.floor((creds.expiresAt - Date.now()) / 1000)}s`;
  logger.info(
    `[minimax-api] preflight OK (source=${creds.source}, baseUrl=${creds.baseUrl}, expires_in=${expLabel})`
  );
}

// ── API call (OpenAI-compatible) ─────────────────────────────────────────

export interface CallMinimaxApiOptions {
  prompt?: string;
  passthroughBody?: Record<string, unknown>;
  model: string;
  maxTokens?: number;
  onRawEvent?: (rawFrame: string) => void;
}

export async function callMinimaxApi(opts: CallMinimaxApiOptions): Promise<ParsedOutput> {
  configureDispatcher();
  if (!rateGuard) configureMinimaxRateGuard();
  return rateGuard!.run(() => doCall(opts));
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

async function doCall(opts: CallMinimaxApiOptions): Promise<ParsedOutput> {
  const creds = await getFreshCreds();
  const body: Record<string, unknown> = opts.passthroughBody
    ? { ...opts.passthroughBody, model: opts.model, stream: true }
    : {
        model: opts.model,
        stream: true,
        messages: [{ role: "user", content: opts.prompt ?? "" }],
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      };

  const url = `${creds.baseUrl}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${creds.accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`minimax upstream ${resp.status}: ${text.slice(0, 500)}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("minimax upstream returned empty body");

  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";
  let usage: OpenAIUsage | undefined;
  let modelUsed = opts.model;
  let sessionId = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let sepIdx: number;
    while ((sepIdx = buffered.indexOf("\n\n")) !== -1) {
      const frame = buffered.slice(0, sepIdx);
      buffered = buffered.slice(sepIdx + 2);
      if (!frame.trim()) continue;
      if (opts.onRawEvent) opts.onRawEvent(`${frame}\n\n`);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const parsed = JSON.parse(payload) as {
            model?: string;
            id?: string;
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
            usage?: OpenAIUsage;
          };
          if (parsed.model && !modelUsed) modelUsed = parsed.model;
          if (parsed.id && !sessionId) sessionId = parsed.id;
          for (const ch of parsed.choices ?? []) {
            const delta = ch.delta?.content ?? ch.message?.content;
            if (typeof delta === "string") text += delta;
          }
          if (parsed.usage) usage = parsed.usage;
        } catch {
          // ignore non-JSON frames
        }
      }
    }
  }

  const inputTokens = usage?.prompt_tokens ?? 0;
  const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;

  const breakdown = calculateCost(
    modelUsed || opts.model,
    Math.max(0, inputTokens - cacheReadTokens),
    outputTokens,
    0,
    cacheReadTokens
  );

  return {
    text,
    sessionId,
    usage: {
      input_tokens: Math.max(0, inputTokens - cacheReadTokens),
      output_tokens: outputTokens,
      cache_creation_tokens: 0,
      cache_read_tokens: cacheReadTokens,
    },
    model: modelUsed || opts.model,
    costUsd: breakdown.apiCost,
  };
}
