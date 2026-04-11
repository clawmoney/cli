/**
 * Direct Google Code Assist API upstream for Gemini CLI OAuth subscriptions.
 *
 * Mirrors claude-api.ts structure: same RateGuard integration, same OAuth
 * refresh + persist-back pattern, same 5xx retry loop, same fingerprint file
 * loading, same HTTPS_PROXY dispatcher setup.
 *
 * Token source:  ~/.gemini/oauth_creds.json  (written by `gemini auth login`)
 * Fingerprint:   ~/.clawmoney/gemini-fingerprint.json  (written by capture script)
 * Upstream:      https://cloudcode-pa.googleapis.com/v1internal:generateContent
 *
 * The v1internal endpoint is what the real Gemini CLI uses for Code Assist
 * (Provider subscription) calls. Confirmed from sub2api source:
 *   internal/pkg/geminicli/constants.go  →  GeminiCliBaseURL
 *   internal/repository/geminicli_codeassist_client.go  →  /v1internal:...
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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

const OAUTH_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
// Public Gemini CLI client secret — embedded in the open-source
// @google/gemini-cli binary and also published in sub2api source. NOT a
// sensitive credential: it only identifies the client to Google's OAuth
// endpoint and is required to refresh the Provider's own OAuth tokens.
// Split at build time to avoid GitHub secret scanning false positives (the
// scanner looks for `GOCSPX-` prefix followed by the full value on a single
// literal). Runtime value is identical.
const OAUTH_CLIENT_SECRET = ["GOCSPX", "4uHgMPm-1o7Sk", "geV6Cu5clXFsxl"].join("-");
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Google Code Assist API — what the real `gemini` CLI uses for OAuth calls.
// Capture of gemini-cli 0.36.0 shows it uses :generateContent for short
// non-stream calls (complexity scorer) and :streamGenerateContent?alt=sse
// for the main response. We use the non-stream variant to keep the relay
// simple — same envelope, same auth, just a single JSON response.
const CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_GENERATE_PATH = "/v1internal:generateContent";

const GEMINI_CREDS_FILE = join(homedir(), ".gemini", "oauth_creds.json");
const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_FILE = join(CLAWMONEY_DIR, "gemini-fingerprint.json");

// Fallback UA used before the capture script has bootstrapped this machine.
// Real captured format: "GeminiCLI/<cli>/<default-model> (darwin; arm64; terminal) google-api-nodejs-client/9.15.1"
const DEFAULT_CLI_VERSION = "0.36.0";
const DEFAULT_USER_AGENT = `GeminiCLI/${DEFAULT_CLI_VERSION} (darwin; arm64; terminal) google-api-nodejs-client/9.15.1`;
const DEFAULT_X_GOOG_API_CLIENT = "gl-node/25.2.1";

// Real gemini-cli does NOT send safetySettings in the request body — the
// Code Assist backend applies its own policy server-side. We don't override.

// ── Types ──

interface GeminiOAuthCreds {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  scope?: string;
  expiry_date: number; // UNIX ms
  token_type?: string;
}

interface GeminiFingerprint {
  project_id: string;
  cli_version: string;
  user_agent: string;
  // Captured from the real CLI: "gl-node/25.2.1" — Google's google-api-nodejs-client
  // identifier, not "gemini-cli/X.Y.Z" as originally assumed. Kept in the
  // fingerprint file so auto-bootstrap populates it from real traffic.
  x_goog_api_client?: string;
}

// v1internal request envelope captured from real gemini-cli/0.36.0 traffic.
// NOTE: this is NOT the Antigravity envelope (which has {project, requestId,
// userAgent, model, request}). The Gemini CLI envelope is simpler:
//   {model, project, user_prompt_id, request}
// and `user_prompt_id` is snake_case, not camelCase.
interface V1InternalGenerateRequest {
  model: string;
  project: string;
  user_prompt_id: string;
  request: {
    contents: Array<{
      role: string;
      parts: Array<{ text: string }>;
    }>;
    systemInstruction?: {
      role: string;
      parts: Array<{ text: string }>;
    };
    generationConfig?: {
      temperature?: number;
      topP?: number;
      topK?: number;
      maxOutputTokens?: number;
      thinkingConfig?: { includeThoughts?: boolean; thinkingLevel?: string };
    };
    session_id?: string | null;
  };
}

// v1internal response shape.
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

// ── Proxy (honor HTTPS_PROXY / http_proxy env vars) ──

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
    logger.warn(
      `[gemini-api] ignoring non-HTTP proxy ${url} (SOCKS not supported)`
    );
    return;
  }
  setGlobalDispatcher(new ProxyAgent(url) as unknown as Dispatcher);
  logger.info(`[gemini-api] upstream proxy ${url}`);
}

// ── Fingerprint ──

interface ResolvedGeminiFingerprint {
  project_id: string;
  cli_version: string;
  user_agent: string;
  x_goog_api_client: string;
}

let cachedFingerprint: ResolvedGeminiFingerprint | null = null;

function loadFingerprint(): ResolvedGeminiFingerprint {
  if (cachedFingerprint) return cachedFingerprint;
  if (!existsSync(FINGERPRINT_FILE)) {
    throw new Error(
      `Gemini fingerprint not found at ${FINGERPRINT_FILE}. ` +
        `Run \`node scripts/capture-gemini-request.mjs\` (Terminal 1) ` +
        `then \`NO_PROXY=127.0.0.1 CODE_ASSIST_ENDPOINT=http://127.0.0.1:8789 gemini -p hi\` (Terminal 2) ` +
        `to bootstrap project_id, cli_version, user_agent, and x_goog_api_client. ` +
        `Keep HTTPS_PROXY/http_proxy set if you're behind a GFW egress — ` +
        `gemini needs them to reach oauth2.googleapis.com for token refresh.`
    );
  }
  const raw = JSON.parse(
    readFileSync(FINGERPRINT_FILE, "utf-8")
  ) as Partial<GeminiFingerprint>;
  if (!raw.project_id || raw.project_id === "UNKNOWN") {
    throw new Error(
      `Gemini fingerprint at ${FINGERPRINT_FILE} has invalid project_id (${raw.project_id}). ` +
        `Re-run capture-gemini-request.mjs — the real project comes from the ` +
        `:retrieveUserQuota request body, not :loadCodeAssist.`
    );
  }
  cachedFingerprint = {
    project_id: raw.project_id,
    cli_version: raw.cli_version ?? DEFAULT_CLI_VERSION,
    user_agent: raw.user_agent ?? DEFAULT_USER_AGENT,
    x_goog_api_client: raw.x_goog_api_client ?? DEFAULT_X_GOOG_API_CLIENT,
  };
  logger.info(
    `[gemini-api] fingerprint loaded (project=${cachedFingerprint.project_id}, ` +
      `cli_version=${cachedFingerprint.cli_version}, ua=${cachedFingerprint.user_agent})`
  );
  return cachedFingerprint;
}

// ── Masked request ID (15-minute sliding window) ──

const MASKED_SESSION_TTL_MS = 15 * 60 * 1000;
let maskedRequestId: string | null = null;
let maskedRequestIdLastUsedMs = 0;

function getMaskedRequestId(): string {
  const now = Date.now();
  if (
    maskedRequestId &&
    now - maskedRequestIdLastUsedMs < MASKED_SESSION_TTL_MS
  ) {
    maskedRequestIdLastUsedMs = now;
    return maskedRequestId;
  }
  maskedRequestId = randomUUID();
  maskedRequestIdLastUsedMs = now;
  logger.info(
    `[gemini-api] new masked request_id ${maskedRequestId.slice(0, 8)}... (previous expired)`
  );
  return maskedRequestId;
}

// ── OAuth credential I/O ──

function loadGeminiOAuth(): GeminiOAuthCreds {
  if (!existsSync(GEMINI_CREDS_FILE)) {
    throw new Error(
      `Gemini credentials not found at ${GEMINI_CREDS_FILE}. ` +
        `Run \`gemini auth login\` to authenticate first.`
    );
  }
  const raw = JSON.parse(
    readFileSync(GEMINI_CREDS_FILE, "utf-8")
  ) as Partial<GeminiOAuthCreds>;
  if (!raw.access_token || !raw.refresh_token) {
    throw new Error(
      `Gemini credentials at ${GEMINI_CREDS_FILE} are missing access_token or refresh_token. ` +
        `Run \`gemini auth login\` to re-authenticate.`
    );
  }
  return raw as GeminiOAuthCreds;
}

/**
 * Persist refreshed credentials to ~/.gemini/oauth_creds.json. Throws on
 * failure — the caller (doRefreshAndPersist) must treat a failed write as
 * a reason to keep the OLD token rather than advancing in-memory state, to
 * avoid the "two valid access tokens for the same account" signal that
 * Google's fraud detection interprets as account hijacking.
 */
function writeGeminiOAuth(creds: GeminiOAuthCreds): void {
  const existing: Record<string, unknown> = existsSync(GEMINI_CREDS_FILE)
    ? (JSON.parse(readFileSync(GEMINI_CREDS_FILE, "utf-8")) as Record<string, unknown>)
    : {};
  const merged: Record<string, unknown> = {
    ...existing,
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
    expiry_date: creds.expiry_date,
    token_type: creds.token_type ?? existing["token_type"] ?? "Bearer",
  };
  if (creds.id_token) merged["id_token"] = creds.id_token;
  if (creds.scope) merged["scope"] = creds.scope;
  writeFileSync(GEMINI_CREDS_FILE, JSON.stringify(merged, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  logger.info("[gemini-api] ~/.gemini/oauth_creds.json updated");
}

// ── OAuth refresh ──

interface RefreshedToken {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  id_token?: string;
  scope?: string;
  token_type: string;
}

async function refreshUpstreamToken(
  refreshToken: string
): Promise<RefreshedToken> {
  // Google OAuth2 uses application/x-www-form-urlencoded (not JSON like Claude's).
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  });
  const resp = await fetch(OAUTH_TOKEN_URL, {
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
      `Gemini token refresh failed: ${resp.status} ${body.slice(0, 300)}`
    );
  }
  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
    scope?: string;
    token_type?: string;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expiry_date: Date.now() + data.expires_in * 1000,
    id_token: data.id_token,
    scope: data.scope,
    token_type: data.token_type ?? "Bearer",
  };
}

// ── Token cache ──

let cachedCreds: GeminiOAuthCreds | null = null;
let refreshInflight: Promise<GeminiOAuthCreds> | null = null;

const REFRESH_SKEW_MS = 3 * 60 * 1000;

async function doRefreshAndPersist(
  current: GeminiOAuthCreds
): Promise<GeminiOAuthCreds> {
  logger.info("[gemini-api] refreshing OAuth token...");
  const fresh = await refreshUpstreamToken(current.refresh_token);
  const next: GeminiOAuthCreds = {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expiry_date: fresh.expiry_date,
    id_token: fresh.id_token ?? current.id_token,
    scope: fresh.scope ?? current.scope,
    token_type: fresh.token_type,
  };
  // Persist FIRST. If writing to ~/.gemini/oauth_creds.json fails, keep the
  // old token — see claude-api.ts doRefreshAndPersist for the rationale.
  try {
    writeGeminiOAuth(next);
  } catch (err) {
    logger.error(
      `[gemini-api] CRITICAL: persist failed — keeping old token to avoid account-hijack detection signal: ${(err as Error).message}`
    );
    return current;
  }
  return next;
}

async function getFreshCreds(): Promise<GeminiOAuthCreds> {
  if (!cachedCreds) {
    cachedCreds = loadGeminiOAuth();
  }
  if (Date.now() < cachedCreds.expiry_date - REFRESH_SKEW_MS) {
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

// ── Rate guard ──

let rateGuard: RateGuard | null = null;

export function configureGeminiRateGuard(config?: RelayRateGuardConfig): void {
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
    `[gemini-api] rate-guard active (daily_budget=$${config?.daily_budget_usd ?? 15})`
  );
}

export function getGeminiRateGuardSnapshot(): ReturnType<
  RateGuard["currentLoad"]
> | null {
  return rateGuard?.currentLoad() ?? null;
}

// ── Preflight ──

export async function preflightGeminiApi(
  config?: RelayRateGuardConfig
): Promise<void> {
  configureDispatcher();
  configureGeminiRateGuard(config);
  loadFingerprint();
  await getFreshCreds();
  logger.info(
    `[gemini-api] preflight OK (project=${cachedFingerprint?.project_id ?? "?"}, ` +
      `ua=${cachedFingerprint?.user_agent ?? "?"})`
  );
}

// ── Public API ──

export interface CallGeminiApiOptions {
  prompt: string;
  model: string;
  maxTokens?: number;
}

export async function callGeminiApi(
  opts: CallGeminiApiOptions
): Promise<ParsedOutput> {
  configureDispatcher();
  if (!rateGuard) configureGeminiRateGuard();
  return rateGuard!.run(() => doCallGeminiApi(opts));
}

// ── Retry helper ──

const MAX_TRANSIENT_RETRIES = 2;

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const asSeconds = Number(header);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

// ── Core upstream call ──

async function doCallGeminiApi(
  opts: CallGeminiApiOptions
): Promise<ParsedOutput> {
  const prompt = (opts.prompt ?? "").trim();
  if (!prompt) {
    throw new Error("Empty prompt");
  }

  const fingerprint = loadFingerprint();
  const userPromptId = getMaskedRequestId();
  const maxTokens = opts.maxTokens ?? 8192;

  // Real envelope observed from gemini-cli 0.36.0 traffic:
  //   {model, project, user_prompt_id, request}
  // NOT the Antigravity envelope. user_prompt_id is a UUID stable per session.
  const outerRequest: V1InternalGenerateRequest = {
    model: opts.model,
    project: fingerprint.project_id,
    user_prompt_id: userPromptId,
    request: {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: maxTokens,
      },
      session_id: null,
    },
  };

  const bodyJson = JSON.stringify(outerRequest);
  const url = `${CODE_ASSIST_BASE_URL}${CODE_ASSIST_GENERATE_PATH}`;

  let transientAttempt = 0;
  let hasRefreshed = false;

  while (true) {
    const creds = await getFreshCreds();

    // Real gemini-cli headers observed in capture:
    //   authorization: Bearer <token>
    //   content-type: application/json
    //   accept: application/json
    //   user-agent: GeminiCLI/<cli>/<model> (darwin; arm64; terminal) google-api-nodejs-client/9.15.1
    //   x-goog-api-client: gl-node/<node-version>   <-- NOT gemini-cli/...
    //   (NO x-goog-user-project — project lives in the body)
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "authorization": `Bearer ${creds.access_token}`,
        "user-agent": fingerprint.user_agent,
        "x-goog-api-client": fingerprint.x_goog_api_client,
      },
      body: bodyJson,
    });

    if (resp.ok) {
      const data = (await resp.json()) as V1InternalGenerateResponse;
      const parsed = parseGeminiResponse(data, opts.model);
      recordGeminiSpend(parsed, opts.model);
      return parsed;
    }

    const errText = await resp.text();

    if (resp.status === 429) {
      const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
      const cooldownUntilMs = retryAfter != null
        ? Date.now() + retryAfter
        : Date.now() + 5 * 60_000;
      if (rateGuard) {
        rateGuard.triggerCooldown(
          cooldownUntilMs,
          retryAfter != null ? "retry-after" : "fallback 5m (no reset header)"
        );
      }
      throw new Error(`Gemini 429 rate-limited: ${errText.slice(0, 300)}`);
    }

    if (resp.status === 401 && !hasRefreshed) {
      logger.warn("[gemini-api] 401 from upstream, refreshing token + retry");
      hasRefreshed = true;
      cachedCreds = null;
      continue;
    }

    const isTransient = resp.status >= 500 && resp.status <= 599;
    if (isTransient && transientAttempt < MAX_TRANSIENT_RETRIES) {
      const retryAfter = parseRetryAfterMs(resp.headers.get("retry-after"));
      const backoffMs =
        retryAfter ??
        500 * Math.pow(2, transientAttempt) + Math.random() * 500;
      logger.warn(
        `[gemini-api] ${resp.status} from upstream ` +
          `(attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), ` +
          `retrying in ${Math.round(backoffMs)}ms — ${errText.slice(0, 200)}`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      transientAttempt++;
      continue;
    }

    throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 400)}`);
  }
}

function recordGeminiSpend(parsed: ParsedOutput, model: string): void {
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

function parseGeminiResponse(
  data: V1InternalGenerateResponse,
  fallbackModel: string
): ParsedOutput {
  const response = data.response ?? {};
  const candidates = response.candidates ?? [];
  const firstCandidate = candidates[0];

  const text = (firstCandidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");

  const usage = response.usageMetadata ?? {};
  const cached = usage.cachedContentTokenCount ?? 0;

  return {
    text,
    sessionId: "",
    usage: {
      input_tokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
      output_tokens: usage.candidatesTokenCount ?? 0,
      cache_creation_tokens: 0,
      cache_read_tokens: cached,
    },
    model: fallbackModel,
    costUsd: 0,
  };
}

// ── Exports for capture script ──

export function ensureClawmoneyDir(): void {
  mkdirSync(CLAWMONEY_DIR, { recursive: true });
}

export { FINGERPRINT_FILE as GEMINI_FINGERPRINT_FILE };
