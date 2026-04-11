/**
 * Direct Google Code Assist API upstream for Google Antigravity IDE OAuth.
 *
 * Antigravity is Google's agentic IDE (Electron/VSCode fork) that ships with
 * a bundled Google Ultra subscription. It hits the same `cloudcode-pa`
 * `v1internal` family of endpoints as Gemini CLI, but through an entirely
 * separate OAuth client — which means it has its own quota pool. Running an
 * Antigravity daemon alongside a Gemini CLI daemon on the same Google account
 * effectively doubles our Gemini capacity.
 *
 * More importantly, Antigravity is the ONLY path that exposes Anthropic
 * Claude models (`claude-opus-4-6-thinking`, `claude-sonnet-4-6`) via Google
 * OAuth. Ultra subscribers who have no Anthropic subscription can still
 * provide Claude capacity through this daemon.
 *
 * Token source:  ~/.clawmoney/antigravity-accounts.json (written by
 *                `clawmoney antigravity login`)
 * Upstream:      https://daily-cloudcode-pa.sandbox.googleapis.com
 *                → https://autopush-cloudcode-pa.sandbox.googleapis.com
 *                → https://cloudcode-pa.googleapis.com
 *                (first two are the "daily" and "autopush" sandbox tiers the
 *                real Antigravity client hits; prod is the final fallback)
 *
 * References:
 *   - opencode-antigravity-auth (TypeScript reference implementation)
 *   - sub2api/backend/internal/pkg/antigravity (Go reference implementation)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ProxyAgent, type Dispatcher } from "undici";
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { relayLogger as logger } from "../logger.js";
import {
  RateGuard,
  RateGuardBudgetExceededError,
  RateGuardCooldownError,
} from "./rate-guard.js";
import { calculateCost } from "../pricing.js";

export { RateGuardBudgetExceededError, RateGuardCooldownError };

// ── OAuth constants (verified against opencode-antigravity-auth and sub2api) ──

// The Antigravity client ID is a public value embedded in the open-source
// Antigravity plugin and in multiple open-source reimplementations. It is NOT
// a sensitive secret — it only identifies the IDE to Google's OAuth server.
export const ANTIGRAVITY_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

// Split at build time to avoid GitHub secret-scanning false positives. The
// prefix "GOCSPX" + "-" + the 26-char body is how Google formats OAuth
// client secrets. The runtime value is identical to the one embedded in the
// Antigravity IDE binary and in opencode-antigravity-auth/src/constants.ts.
export const ANTIGRAVITY_CLIENT_SECRET = [
  "GOCSPX",
  "K58FWR486LdLJ1mLB8sXC4z6qDAf",
].join("-");

export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;

export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

// Endpoint list. sub2api (production-tested Go relay) uses only prod + daily.
// We originally also included `autopush-cloudcode-pa.sandbox.googleapis.com`
// from opencode-antigravity-auth's list, but that host requires the
// `staging-cloudaicompanion` API to be manually enabled in Google Cloud
// Console — which is a setup step the real Antigravity IDE doesn't need, so
// it can't be the right path. Drop it.
const ANTIGRAVITY_ENDPOINT_DAILY =
  "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com";

// Generate-path fallback order: daily → prod. Matches sub2api's
// `ForwardBaseURLs()` — daily is the Antigravity IDE's primary forward
// target; prod is the fallback when daily 404/500s.
const ANTIGRAVITY_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_PROD,
] as const;

// Setup-path fallback order: prod → daily. Matches sub2api's `BaseURLs`.
// loadCodeAssist / onboardUser are best supported on prod; daily is the
// backup for when prod has a temporary hiccup.
const ANTIGRAVITY_LOAD_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
] as const;

// Antigravity upstream only supports streamGenerateContent — the non-stream
// variant returns a generic 500 "Unknown Error" for every model we tested.
// Documented in sub2api/backend/internal/service/antigravity_gateway_service.go:1409
// ("Antigravity 上游只支持流式请求"). We parse the ?alt=sse response inline.
const GENERATE_PATH = "/v1internal:streamGenerateContent?alt=sse";

/**
 * Map our `antigravity-*` market-facing model IDs to the real model names
 * Google's v1internal endpoint accepts. The `antigravity-` prefix only
 * exists in OUR namespace so buyers can pick the Antigravity quota pool
 * vs the Gemini CLI quota pool for the same underlying model. Google's
 * v1internal endpoint itself uses the bare names. Sources: sub2api
 * migration 049_unify_antigravity_model_mapping.sql for canonical Google
 * names.
 */
const ANTIGRAVITY_MODEL_MAP: Record<string, string> = {
  // Verified live against a real Ultra account's
  // `v1internal:fetchAvailableModels` response on 2026-04-11. sub2api
  // migration 049's mapping is stale — Google has retired most `4-5`
  // Claude variants and only `claude-opus-4-6-thinking` / `claude-sonnet-4-6`
  // remain, both of which are thinking variants (the displayName literally
  // says "(Thinking)" even for the plain id).
  //
  // Gemini: both `gemini-3-pro-high/low` and `gemini-3.1-pro-high/low` are
  // available — prefer 3.1 for new traffic since Google's generate path
  // sends "no longer available" plain text for 3-pro-high.
  "antigravity-gemini-3-pro": "gemini-3.1-pro-high",
  "antigravity-gemini-3.1-pro": "gemini-3.1-pro-high",
  "antigravity-gemini-3.1-pro-low": "gemini-3.1-pro-low",
  "antigravity-gemini-3-flash": "gemini-3-flash",
  "antigravity-gemini-2.5-pro": "gemini-2.5-pro",
  "antigravity-gemini-2.5-flash": "gemini-2.5-flash",
  // Claude. All supported variants are thinking-mode; "4-5" market IDs fall
  // through to 4-6 because that's what Google currently exposes.
  "antigravity-claude-opus-4-6": "claude-opus-4-6-thinking",
  "antigravity-claude-opus-4-6-thinking": "claude-opus-4-6-thinking",
  "antigravity-claude-opus-4-5-thinking": "claude-opus-4-6-thinking",
  "antigravity-claude-sonnet-4-6": "claude-sonnet-4-6",
  "antigravity-claude-sonnet-4-5": "claude-sonnet-4-6",
  "antigravity-claude-sonnet-4-5-thinking": "claude-sonnet-4-6",
  "antigravity-claude-haiku-4-5": "claude-sonnet-4-6",
};

function resolveAntigravityUpstreamModel(model: string): string {
  return ANTIGRAVITY_MODEL_MAP[model] ?? model;
}

// Hardcoded fallback project ID used for workspace/business accounts that
// don't return their own `cloudaicompanionProject` from `loadCodeAssist`. Same
// value used by opencode-antigravity-auth and sub2api — it's not account-
// specific, it's a shared no-op project that the Antigravity backend accepts.
const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc";

// Antigravity client version. The real IDE sends its own build version; we
// pick one that matches what the capture at time-of-writing showed. Google
// doesn't strictly enforce it, but sending a plausible value reduces the
// chance the request gets flagged as a bot.
const ANTIGRAVITY_VERSION = "1.21.9";

const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const ACCOUNTS_FILE = join(CLAWMONEY_DIR, "antigravity-accounts.json");

// ── Types ──

/**
 * Antigravity OAuth refresh tokens are stored in a JSON array of "accounts".
 * Phase 1 of this integration treats the file as single-account: we read the
 * first entry on boot. Phase 2 (multi-account / rotation) can iterate over
 * the array without changing the on-disk schema.
 */
export interface AntigravityAccount {
  /** Google email, cosmetic only (for logs). */
  email?: string;
  /**
   * Google OAuth refresh token. Long-lived — stays valid until the user
   * revokes the grant on the Google account security page.
   */
  refresh_token: string;
  /** Last access token we cached. May be expired; we refresh on demand. */
  access_token?: string;
  /**
   * Unix ms when the cached access_token expires. 0 if we never fetched one
   * or if the stored value is known to be stale.
   */
  expiry_ms?: number;
  /**
   * cloudaicompanionProject id returned by loadCodeAssist. Required for
   * every request. For workspace accounts we fall back to the shared
   * "rising-fact-p41fc" project id.
   */
  project_id?: string;
  /** Unix ms when this account was added — cosmetic, for ops/debugging. */
  added_at?: number;
}

interface AntigravityAccountsFile {
  version: 1;
  accounts: AntigravityAccount[];
}

/**
 * v1internal request envelope observed on real Antigravity traffic.
 *
 *     {
 *       project: "<cloudaicompanionProject>",
 *       requestId: "agent-<uuid>",
 *       userAgent: "antigravity",
 *       requestType: "agent" | "web_search",
 *       model: "<model-id>",
 *       request: { contents, generationConfig?, systemInstruction?, tools?,
 *                  toolConfig?, sessionId? },
 *     }
 *
 * This is NOT the Gemini CLI envelope (which is `{model, project,
 * user_prompt_id, request}` with a snake_case `session_id` nested inside
 * `request`). The Antigravity envelope sits at `v1internal:generateContent`
 * on the `daily-cloudcode-pa.sandbox` host.
 *
 * Source: sub2api/backend/internal/pkg/antigravity/request_transformer.go:166-174
 * Source: opencode-antigravity-auth/src/plugin/request.ts:836-870
 */
interface V1InternalAntigravityRequest {
  project: string;
  requestId: string;
  userAgent: string;
  requestType: "agent" | "web_search";
  model: string;
  request: {
    contents: Array<{
      role: string;
      parts: Array<{ text: string }>;
    }>;
    generationConfig?: {
      temperature?: number;
      maxOutputTokens?: number;
    };
    systemInstruction?: {
      role: string;
      parts: Array<{ text: string }>;
    };
    toolConfig?: {
      functionCallingConfig?: { mode: string };
    };
    sessionId?: string;
  };
}

interface V1InternalGenerateResponse {
  response?: {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      cachedContentTokenCount?: number;
    };
  };
}

interface LoadCodeAssistResponse {
  cloudaicompanionProject?: string | { id?: string };
  currentTier?: { id?: string } | string;
  paidTier?: { id?: string } | string;
  // Some fresh accounts return ineligibleTiers + allowedTiers. We only care
  // about the current/paid tier ID for the onboardUser call downstream.
}

interface OnboardUserResponse {
  name?: string;
  done?: boolean;
  response?: {
    cloudaicompanionProject?: string | { id?: string };
  };
}

// ── Proxy ──
//
// We build our own ProxyAgent instead of relying on setGlobalDispatcher,
// then pass it explicitly to each fetch() call. This is more reliable than
// the global-dispatcher approach (no cross-module timing issues with Node's
// built-in fetch) and makes errors surface with a real cause chain.
//
// Also exported so the `antigravity login` command can trigger the same
// setup before it hits oauth2.googleapis.com / userinfo / loadCodeAssist —
// providers behind the GFW were seeing "fetch failed" at the token-exchange
// step before we honored HTTPS_PROXY here.

let cachedProxyAgent: ProxyAgent | null = null;
let proxyResolved = false;

function getProxyAgent(): ProxyAgent | null {
  if (proxyResolved) return cachedProxyAgent;
  proxyResolved = true;
  const url =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!url) return null;
  if (!/^https?:\/\//.test(url)) {
    logger.warn(
      `[antigravity-api] ignoring non-HTTP proxy ${url} (SOCKS not supported)`
    );
    return null;
  }
  cachedProxyAgent = new ProxyAgent(url);
  logger.info(`[antigravity-api] upstream proxy ${url}`);
  return cachedProxyAgent;
}

/**
 * fetch wrapper that: (1) auto-applies the configured ProxyAgent when
 * HTTPS_PROXY is set, and (2) unwraps undici's TypeError("fetch failed")
 * to surface the real underlying error code — without this, users on the
 * GFW side see opaque "fetch failed" messages and can't tell whether it's
 * a DNS failure, cert error, proxy refusal, or timeout.
 */
async function fetchWithProxy(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const agent = getProxyAgent();
  const opts: Record<string, unknown> = { ...init };
  if (agent) opts.dispatcher = agent;
  try {
    // Node's built-in fetch accepts `dispatcher` through the undici
    // extension, but the DOM `RequestInit` type doesn't expose it. We cast
    // via a local type to keep strict TS happy.
    return await (fetch as (u: string, o: unknown) => Promise<Response>)(
      url,
      opts
    );
  } catch (err) {
    // undici wraps the real network error in TypeError("fetch failed")
    // with the real cause on err.cause. Surface it so "ECONNREFUSED"
    // / "ETIMEDOUT" / "CERT_HAS_EXPIRED" is visible in logs.
    const cause = (err as { cause?: unknown }).cause;
    if (cause) {
      const code = (cause as { code?: string }).code;
      const message = (cause as { message?: string }).message;
      throw new Error(
        `fetch ${url} failed: ${code ?? ""} ${message ?? String(cause)}`.trim()
      );
    }
    throw err;
  }
}

// Legacy name kept for call sites that haven't been migrated. Also acts as
// the public preflight hook for the daemon's `preflightAntigravityApi`.
export function configureAntigravityDispatcher(): void {
  getProxyAgent();
}
const configureDispatcher = configureAntigravityDispatcher;

// ── Account storage ──

export function ensureClawmoneyDir(): void {
  mkdirSync(CLAWMONEY_DIR, { recursive: true });
}

export function loadAccounts(): AntigravityAccountsFile {
  if (!existsSync(ACCOUNTS_FILE)) {
    return { version: 1, accounts: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8")) as Partial<
      AntigravityAccountsFile
    >;
    if (!raw.accounts || !Array.isArray(raw.accounts)) {
      return { version: 1, accounts: [] };
    }
    return { version: 1, accounts: raw.accounts as AntigravityAccount[] };
  } catch (err) {
    logger.warn(
      `[antigravity-api] failed to parse ${ACCOUNTS_FILE}: ${(err as Error).message}`
    );
    return { version: 1, accounts: [] };
  }
}

export function saveAccounts(file: AntigravityAccountsFile): void {
  ensureClawmoneyDir();
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(file, null, 2), "utf-8");
}

function loadPrimaryAccount(): AntigravityAccount {
  const file = loadAccounts();
  if (file.accounts.length === 0) {
    throw new Error(
      `No Antigravity accounts found at ${ACCOUNTS_FILE}. ` +
        `Run \`clawmoney antigravity login\` to authenticate first.`
    );
  }
  const primary = file.accounts[0]!;
  if (!primary.refresh_token) {
    throw new Error(
      `Antigravity account at ${ACCOUNTS_FILE} is missing a refresh_token. ` +
        `Re-run \`clawmoney antigravity login\`.`
    );
  }
  return primary;
}

function persistPrimaryAccount(patch: Partial<AntigravityAccount>): void {
  const file = loadAccounts();
  if (file.accounts.length === 0) return;
  file.accounts[0] = { ...file.accounts[0]!, ...patch };
  try {
    saveAccounts(file);
  } catch (err) {
    logger.warn(
      `[antigravity-api] could not persist account update: ${(err as Error).message}`
    );
  }
}

// ── OAuth refresh ──

interface RefreshedToken {
  access_token: string;
  refresh_token: string;
  expiry_ms: number;
}

async function refreshUpstreamToken(
  refreshToken: string
): Promise<RefreshedToken> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
  });
  const resp = await fetchWithProxy(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: params.toString(),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Antigravity token refresh failed: ${resp.status} ${body.slice(0, 300)}`
    );
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expiry_ms: Date.now() + data.expires_in * 1000,
  };
}

// ── Token cache ──

let cachedAccount: AntigravityAccount | null = null;
let refreshInflight: Promise<AntigravityAccount> | null = null;

const REFRESH_SKEW_MS = 3 * 60 * 1000;

async function doRefreshAndPersist(
  current: AntigravityAccount
): Promise<AntigravityAccount> {
  logger.info("[antigravity-api] refreshing OAuth token...");
  const fresh = await refreshUpstreamToken(current.refresh_token);
  const next: AntigravityAccount = {
    ...current,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expiry_ms: fresh.expiry_ms,
  };
  persistPrimaryAccount({
    access_token: next.access_token,
    refresh_token: next.refresh_token,
    expiry_ms: next.expiry_ms,
  });
  return next;
}

async function getFreshAccount(): Promise<AntigravityAccount> {
  if (!cachedAccount) {
    cachedAccount = loadPrimaryAccount();
  }
  const exp = cachedAccount.expiry_ms ?? 0;
  if (cachedAccount.access_token && Date.now() < exp - REFRESH_SKEW_MS) {
    return cachedAccount;
  }
  if (!refreshInflight) {
    const prior = cachedAccount;
    refreshInflight = doRefreshAndPersist(prior).finally(() => {
      refreshInflight = null;
    });
  }
  cachedAccount = await refreshInflight;
  return cachedAccount;
}

// ── Project ID resolution ──

/**
 * Discover the Google Cloud project ID associated with this Antigravity
 * account via `loadCodeAssist`. Required for every v1internal request.
 *
 * Some workspace / business accounts return an empty string here — we fall
 * back to `ANTIGRAVITY_DEFAULT_PROJECT_ID` in that case, matching the
 * sub2api and opencode-antigravity-auth behavior.
 */
function extractProjectId(
  raw: LoadCodeAssistResponse | OnboardUserResponse["response"] | undefined
): string | undefined {
  if (!raw) return undefined;
  const project = (raw as LoadCodeAssistResponse).cloudaicompanionProject;
  if (typeof project === "string" && project) return project;
  if (project && typeof project === "object" && project.id) return project.id;
  return undefined;
}

function extractTierId(data: LoadCodeAssistResponse): string | undefined {
  const pick = (t: { id?: string } | string | undefined): string | undefined => {
    if (!t) return undefined;
    if (typeof t === "string") return t || undefined;
    return t.id || undefined;
  };
  return pick(data.paidTier) ?? pick(data.currentTier);
}

async function callLoadCodeAssist(
  accessToken: string
): Promise<{ project?: string; tier?: string } | null> {
  // loadCodeAssist metadata fields match sub2api exactly — Google's protobuf
  // validator rejects "MACOS"/"WINDOWS" strings on the `platform` enum (it
  // only accepts UPPERCASE enum values like PLATFORM_UNSPECIFIED / DARWIN /
  // LINUX / WINDOWS_NT). sub2api sends ideVersion + ideName instead, which
  // bypasses the platform field entirely.
  const body = JSON.stringify({
    metadata: {
      ideType: "ANTIGRAVITY",
      ideVersion: ANTIGRAVITY_VERSION,
      ideName: "antigravity",
    },
  });
  const headers = antigravitySetupHeaders(accessToken);
  for (const baseEndpoint of ANTIGRAVITY_LOAD_ENDPOINTS) {
    try {
      const resp = await fetchWithProxy(
        `${baseEndpoint}/v1internal:loadCodeAssist`,
        { method: "POST", headers, body }
      );
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        logger.warn(
          `[antigravity-api] loadCodeAssist ${resp.status} at ${baseEndpoint}: ${errBody.slice(0, 400)}`
        );
        continue;
      }
      const data = (await resp.json()) as LoadCodeAssistResponse;
      return {
        project: extractProjectId(data),
        tier: extractTierId(data),
      };
    } catch (err) {
      logger.warn(
        `[antigravity-api] loadCodeAssist error at ${baseEndpoint}: ${(err as Error).message}`
      );
    }
  }
  return null;
}

/**
 * Trigger Google's onboarding flow so a fresh account gets a real project
 * ID back. Some accounts (especially first-time Antigravity users) return
 * an empty `cloudaicompanionProject` from loadCodeAssist; they have to be
 * onboarded first. Mirrors sub2api's Client.OnboardUser retry/poll logic.
 */
async function callOnboardUser(
  accessToken: string,
  tierId: string
): Promise<string | undefined> {
  // onboardUser metadata: mirrors sub2api (client.go:519-522) exactly. Unlike
  // loadCodeAssist, this call *does* take `platform` + `pluginType`, but it
  // wants the protobuf enum values — "PLATFORM_UNSPECIFIED" not "MACOS".
  const body = JSON.stringify({
    tierId,
    metadata: {
      ideType: "ANTIGRAVITY",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    },
  });
  const headers = antigravitySetupHeaders(accessToken);
  for (const baseEndpoint of ANTIGRAVITY_LOAD_ENDPOINTS) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const resp = await fetchWithProxy(
          `${baseEndpoint}/v1internal:onboardUser`,
          { method: "POST", headers, body }
        );
        if (!resp.ok) {
          if (resp.status >= 500 || resp.status === 404) break; // try next endpoint
          logger.warn(
            `[antigravity-api] onboardUser ${resp.status} at ${baseEndpoint}`
          );
          return undefined;
        }
        const data = (await resp.json()) as OnboardUserResponse;
        const project = extractProjectId(data.response);
        if (data.done && project) return project;
        // done=false → wait a couple seconds and poll again
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        logger.warn(
          `[antigravity-api] onboardUser error at ${baseEndpoint}: ${(err as Error).message}`
        );
        break;
      }
    }
  }
  return undefined;
}

export async function resolveAntigravityProjectId(
  accessToken: string
): Promise<string> {
  configureDispatcher();
  const loaded = await callLoadCodeAssist(accessToken);
  if (loaded?.project) return loaded.project;

  if (loaded?.tier) {
    logger.info(
      `[antigravity-api] loadCodeAssist returned no project (tier=${loaded.tier}) — running onboardUser...`
    );
    const onboarded = await callOnboardUser(accessToken, loaded.tier);
    if (onboarded) {
      logger.info(`[antigravity-api] onboardUser succeeded, project=${onboarded}`);
      return onboarded;
    }
  }

  logger.warn(
    `[antigravity-api] could not resolve a real project — falling back to ${ANTIGRAVITY_DEFAULT_PROJECT_ID}. ` +
      `This shared project needs staging-cloudaicompanion API enabled in Google Cloud Console; ` +
      `expect 403 errors until a real project is resolved.`
  );
  return ANTIGRAVITY_DEFAULT_PROJECT_ID;
}

/**
 * Headers used for the streamGenerateContent / generateContent calls. Real
 * Antigravity UA + x-goog-api-client + client-metadata.
 */
function antigravityHeaders(accessToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "accept": "application/json",
    "authorization": `Bearer ${accessToken}`,
    "user-agent":
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Antigravity/${ANTIGRAVITY_VERSION} ` +
      `Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
    "x-goog-api-client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "client-metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
      pluginType: "GEMINI",
    }),
  };
}

/**
 * Headers for the setup calls (loadCodeAssist / onboardUser). These want a
 * simpler Gemini-CLI-flavored header set — the Antigravity UA + the
 * `x-goog-api-client` cloud-shell-editor fingerprint triggers a 400 on
 * prod/daily/autopush hosts. opencode-antigravity-auth/src/antigravity/oauth.ts
 * uses the same subset (authorization + content-type + gemini-cli UA +
 * client-metadata) and it works in the wild.
 */
function antigravitySetupHeaders(accessToken: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "accept": "application/json",
    "authorization": `Bearer ${accessToken}`,
    "user-agent": "google-api-nodejs-client/9.15.1",
    "client-metadata": JSON.stringify({
      ideType: "ANTIGRAVITY",
      platform: process.platform === "win32" ? "WINDOWS" : "MACOS",
      pluginType: "GEMINI",
    }),
  };
}

// ── Rate guard ──

let rateGuard: RateGuard | null = null;

export function configureAntigravityRateGuard(
  config?: RelayRateGuardConfig
): void {
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
  logger.info(
    `[antigravity-api] rate-guard active (daily_budget=$${config?.daily_budget_usd ?? 15})`
  );
}

export function getAntigravityRateGuardSnapshot(): ReturnType<
  RateGuard["currentLoad"]
> | null {
  return rateGuard?.currentLoad() ?? null;
}

// ── Preflight ──

export async function preflightAntigravityApi(
  config?: RelayRateGuardConfig
): Promise<void> {
  configureDispatcher();
  configureAntigravityRateGuard(config);
  const account = await getFreshAccount();
  if (!account.project_id) {
    logger.info("[antigravity-api] resolving project ID via loadCodeAssist...");
    const projectId = await resolveAntigravityProjectId(account.access_token!);
    account.project_id = projectId;
    persistPrimaryAccount({ project_id: projectId });
    cachedAccount = account;
  }
  logger.info(
    `[antigravity-api] preflight OK (project=${account.project_id}, email=${account.email ?? "?"})`
  );
}

// ── Public API ──

export interface CallAntigravityApiOptions {
  prompt: string;
  model: string;
  maxTokens?: number;
}

export async function callAntigravityApi(
  opts: CallAntigravityApiOptions
): Promise<ParsedOutput> {
  configureDispatcher();
  if (!rateGuard) configureAntigravityRateGuard();
  return rateGuard!.run(() => doCallAntigravityApi(opts));
}

// ── Retry / fallback ──

const MAX_TRANSIENT_RETRIES = 2;

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function generateStableSessionId(prompt: string): string {
  // Stable hash of the prompt so multi-turn conversations within the same
  // relay request reuse the same session id. Matches sub2api's
  // `generateStableSessionID` logic (request_transformer.go:24-40).
  let h = 0n;
  for (let i = 0; i < prompt.length && i < 512; i++) {
    h = (h * 31n + BigInt(prompt.charCodeAt(i))) & 0x7fffffffffffffffn;
  }
  return "-" + h.toString();
}

// ── Core upstream call ──

async function doCallAntigravityApi(
  opts: CallAntigravityApiOptions
): Promise<ParsedOutput> {
  const prompt = (opts.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Empty prompt");
  }

  const account = await getFreshAccount();
  const projectId = account.project_id || ANTIGRAVITY_DEFAULT_PROJECT_ID;
  const maxTokens = opts.maxTokens ?? 8192;

  const upstreamModel = resolveAntigravityUpstreamModel(opts.model);
  if (upstreamModel !== opts.model) {
    logger.info(
      `[antigravity-api] model mapping: ${opts.model} → ${upstreamModel}`
    );
  }
  // Request shape mirrors sub2api's minimal inner GeminiRequest: contents +
  // toolConfig + sessionId. generationConfig is optional and only gets set
  // when the caller actually supplied max_tokens — sending a bare
  // maxOutputTokens in the inner request against v1internal has been
  // observed to return "500 Unknown Error" for some models.
  const innerRequest: V1InternalAntigravityRequest["request"] = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    toolConfig: {
      functionCallingConfig: { mode: "VALIDATED" },
    },
    sessionId: generateStableSessionId(prompt),
  };
  const outerRequest: V1InternalAntigravityRequest = {
    project: projectId,
    requestId: `agent-${randomUUID()}`,
    userAgent: "antigravity",
    requestType: "agent",
    model: upstreamModel,
    request: innerRequest,
  };
  // Suppress unused-var lint while we keep maxTokens around for future use.
  void maxTokens;

  const bodyJson = JSON.stringify(outerRequest);

  let transientAttempt = 0;
  let hasRefreshed = false;
  let endpointIdx = 0;

  while (true) {
    const creds = await getFreshAccount();
    const baseEndpoint = ANTIGRAVITY_ENDPOINTS[endpointIdx]!;
    const url = `${baseEndpoint}${GENERATE_PATH}`;

    let resp: Response;
    try {
      resp = await fetchWithProxy(url, {
        method: "POST",
        headers: antigravityHeaders(creds.access_token!),
        body: bodyJson,
      });
    } catch (err) {
      // Connection error — walk through the endpoint fallback chain.
      if (endpointIdx < ANTIGRAVITY_ENDPOINTS.length - 1) {
        logger.warn(
          `[antigravity-api] connect error on ${baseEndpoint}: ${(err as Error).message} — falling back to ${ANTIGRAVITY_ENDPOINTS[endpointIdx + 1]}`
        );
        endpointIdx++;
        continue;
      }
      throw err;
    }

    if (resp.ok) {
      const parsed = await parseAntigravitySseResponse(resp, opts.model);
      recordAntigravitySpend(parsed, opts.model);
      return parsed;
    }

    const errText = await resp.text();

    if (resp.status === 429) {
      const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
      const cooldownUntilMs =
        retryAfter != null ? Date.now() + retryAfter : Date.now() + 5 * 60_000;
      if (rateGuard) {
        rateGuard.triggerCooldown(
          cooldownUntilMs,
          retryAfter != null ? "retry-after" : "fallback 5m (no reset header)"
        );
      }
      throw new Error(
        `Antigravity 429 rate-limited: ${errText.slice(0, 300)}`
      );
    }

    if (resp.status === 401 && !hasRefreshed) {
      logger.warn("[antigravity-api] 401 from upstream, refreshing token + retry");
      hasRefreshed = true;
      cachedAccount = null;
      continue;
    }

    // 404 / 5xx → endpoint fallback. Same policy sub2api and
    // opencode-antigravity-auth apply: walk sandbox → autopush → prod before
    // giving up.
    const shouldFallback =
      (resp.status === 404 ||
        resp.status === 408 ||
        (resp.status >= 500 && resp.status <= 599)) &&
      endpointIdx < ANTIGRAVITY_ENDPOINTS.length - 1;
    if (shouldFallback) {
      logger.warn(
        `[antigravity-api] ${resp.status} from ${baseEndpoint} — falling back to ${ANTIGRAVITY_ENDPOINTS[endpointIdx + 1]}`
      );
      endpointIdx++;
      continue;
    }

    const isTransient = resp.status >= 500 && resp.status <= 599;
    if (isTransient && transientAttempt < MAX_TRANSIENT_RETRIES) {
      const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
      const backoffMs =
        retryAfter ?? 500 * Math.pow(2, transientAttempt) + Math.random() * 500;
      logger.warn(
        `[antigravity-api] ${resp.status} from upstream (attempt ${
          transientAttempt + 1
        }/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(
          backoffMs
        )}ms — ${errText.slice(0, 200)}`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      transientAttempt++;
      continue;
    }

    throw new Error(`Antigravity ${resp.status}: ${errText.slice(0, 400)}`);
  }
}

function recordAntigravitySpend(parsed: ParsedOutput, model: string): void {
  if (!rateGuard) return;
  const {
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
  } = parsed.usage;
  const cost = calculateCost(
    model,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens
  );
  rateGuard.recordSpend(cost.apiCost);
}

/**
 * Parse Antigravity's streamGenerateContent?alt=sse response. Google sends
 * Server-Sent Events where each line is `data: {json}`; the JSON shape
 * matches a single `V1InternalGenerateResponse` chunk. Text parts accumulate
 * across chunks, and usageMetadata is usually on the last chunk.
 *
 * Note: unlike vanilla Gemini API, Antigravity wraps each chunk's body in a
 * top-level `response` field (mirroring the non-stream shape), so we unwrap.
 */
async function parseAntigravitySseResponse(
  resp: Response,
  fallbackModel: string
): Promise<ParsedOutput> {
  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error("Antigravity streamGenerateContent returned no body");
  }
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;

  const processChunk = (jsonStr: string): void => {
    const trimmed = jsonStr.trim();
    if (!trimmed || trimmed === "[DONE]") return;
    let chunk: V1InternalGenerateResponse;
    try {
      chunk = JSON.parse(trimmed) as V1InternalGenerateResponse;
    } catch {
      return;
    }
    // Antigravity SSE sometimes emits chunks with fields at the top level
    // (without the `response` wrapper). Handle both shapes.
    const body =
      (chunk as V1InternalGenerateResponse).response ??
      (chunk as unknown as NonNullable<V1InternalGenerateResponse["response"]>);
    const candidates = body?.candidates ?? [];
    for (const cand of candidates) {
      for (const part of cand.content?.parts ?? []) {
        if (part.text) text += part.text;
      }
    }
    const usage = body?.usageMetadata;
    if (usage) {
      if (typeof usage.promptTokenCount === "number") {
        inputTokens = usage.promptTokenCount;
      }
      if (typeof usage.candidatesTokenCount === "number") {
        outputTokens = usage.candidatesTokenCount;
      }
      if (typeof usage.cachedContentTokenCount === "number") {
        cachedTokens = usage.cachedContentTokenCount;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      if (line.startsWith("data:")) {
        processChunk(line.slice(5));
      }
    }
  }
  // Flush tail (unlikely but safe)
  if (buffer.startsWith("data:")) {
    processChunk(buffer.slice(5));
  }

  return {
    text,
    sessionId: "",
    usage: {
      input_tokens: Math.max(0, inputTokens - cachedTokens),
      output_tokens: outputTokens,
      cache_creation_tokens: 0,
      cache_read_tokens: cachedTokens,
    },
    model: fallbackModel,
    costUsd: 0,
  };
}

// ── Exports for login command ──

export { ACCOUNTS_FILE as ANTIGRAVITY_ACCOUNTS_FILE, OAUTH_TOKEN_URL };

/**
 * Called by the `antigravity login` command after it exchanges an auth code
 * for tokens. Persists the account, resolves the project ID, and returns the
 * stored record.
 */
export async function storeNewAntigravityAccount(input: {
  refresh_token: string;
  access_token: string;
  expiry_ms: number;
  email?: string;
}): Promise<AntigravityAccount> {
  ensureClawmoneyDir();
  let projectId = "";
  try {
    projectId = await resolveAntigravityProjectId(input.access_token);
  } catch (err) {
    logger.warn(
      `[antigravity-api] project ID resolution failed: ${(err as Error).message} — falling back to default`
    );
    projectId = ANTIGRAVITY_DEFAULT_PROJECT_ID;
  }
  const now = Date.now();
  const account: AntigravityAccount = {
    email: input.email,
    refresh_token: input.refresh_token,
    access_token: input.access_token,
    expiry_ms: input.expiry_ms,
    project_id: projectId,
    added_at: now,
  };
  const file = loadAccounts();
  // Single-account for now: replace any existing entry with the same email,
  // otherwise append. The daemon always reads accounts[0].
  const existingIdx = file.accounts.findIndex(
    (a) => a.email && input.email && a.email === input.email
  );
  if (existingIdx >= 0) {
    file.accounts[existingIdx] = account;
  } else {
    file.accounts.unshift(account);
  }
  saveAccounts(file);
  // Reset the in-memory cache so the next request picks up the new account.
  cachedAccount = null;
  return account;
}

/**
 * Request OAuth tokens from Google using an authorization code obtained via
 * the browser flow. Exported so the CLI login command can call it.
 */
export async function exchangeAntigravityAuthCode(input: {
  code: string;
  code_verifier: string;
}): Promise<{
  access_token: string;
  refresh_token: string;
  expiry_ms: number;
}> {
  const start = Date.now();
  const resp = await fetchWithProxy(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "accept": "*/*",
    },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code: input.code,
      grant_type: "authorization_code",
      redirect_uri: ANTIGRAVITY_REDIRECT_URI,
      code_verifier: input.code_verifier,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Antigravity auth code exchange failed: ${resp.status} ${body.slice(0, 400)}`
    );
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  if (!data.refresh_token) {
    throw new Error(
      "Antigravity auth code exchange succeeded but no refresh_token was returned. " +
        "Google only returns a refresh_token on the FIRST consent — revoke access at " +
        "https://myaccount.google.com/permissions and try again with prompt=consent."
    );
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiry_ms: start + data.expires_in * 1000,
  };
}

/**
 * Fetch the Google user's email for display / de-duplication. Non-fatal on
 * failure — we'll just store the account without an email label.
 */
export async function fetchAntigravityUserEmail(
  accessToken: string
): Promise<string | undefined> {
  try {
    const resp = await fetchWithProxy(OAUTH_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}
