/**
 * Grok Build (xAI SuperGrok / xAI OIDC) relay adapter.
 *
 * Source of truth (2026-08-14, xai-org/grok-build HEAD):
 *   crates/codegen/xai-grok-env/src/lib.rs
 *     PRODUCTION cli_chat_proxy_base_url = https://cli-chat-proxy.grok.com/v1
 *   crates/codegen/xai-grok-sampler/src/client.rs
 *     POST {base}/chat/completions  (OpenAI-compat SSE)
 *     headers: Authorization Bearer, User-Agent grok-shell/{ver} ({os}; {arch}),
 *              x-grok-client-version, x-grok-client-identifier=grok-shell,
 *              x-grok-conv-id / req-id / model-override / session-id / agent-id
 *   crates/codegen/xai-grok-http/src/lib.rs
 *     x-grok-client-mode = interactive | headless
 *   crates/codegen/xai-grok-shell/src/auth/oidc/protocol.rs
 *     discover {issuer}/.well-known/openid-configuration
 *     POST token_endpoint grant_type=refresh_token + client_id
 *     access_token persisted as the `key` field in ~/.grok/auth.json
 *
 * Do NOT send SuperGrok traffic to api.x.ai — that is the pay-per-token
 * API. Grok Build's official CLI talks to cli-chat-proxy.grok.com.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fetch, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { relayLogger as logger } from "../logger.js";
import {
  RateGuard,
  RateGuardBudgetExceededError,
  RateGuardCooldownError,
} from "./rate-guard.js";
import { calculateCost } from "../pricing.js";

export { RateGuardBudgetExceededError, RateGuardCooldownError };

const GROK_HOME = join(homedir(), ".grok");
const GROK_AUTH_FILE = join(GROK_HOME, "auth.json");
const GROK_AGENT_ID_FILE = join(GROK_HOME, "agent_id");
const GROK_VERSION_FILE = join(GROK_HOME, "version.json");
const CLI_CHAT_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";
const DEFAULT_ISSUER = "https://auth.x.ai";
const DEFAULT_CLI_VERSION = "1.0.3";
const AGENT_PRODUCT = "grok-shell";
const REFRESH_SKEW_MS = 5 * 60 * 1000;

interface GrokAuthEntry {
  key?: string;
  auth_mode?: string;
  refresh_token?: string;
  expires_at?: string | number;
  oidc_issuer?: string;
  oidc_client_id?: string;
  principal_type?: string;
  principal_id?: string;
  user_id?: string;
  [k: string]: unknown;
}

interface LoadedGrokCreds {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  issuer: string;
  clientId: string;
  principalType?: string;
  principalId?: string;
  userId?: string;
  entryKey: string;
  raw: Record<string, GrokAuthEntry>;
}

let dispatcherConfigured = false;
function configureDispatcher(): void {
  if (dispatcherConfigured) return;
  const proxyUrl =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl) as unknown as Dispatcher);
    logger.info(`[grok] upstream proxy ${proxyUrl}`);
  }
  dispatcherConfigured = true;
}

function grokCliVersion(): string {
  try {
    if (existsSync(GROK_VERSION_FILE)) {
      const raw = JSON.parse(readFileSync(GROK_VERSION_FILE, "utf-8")) as {
        version?: string;
      };
      if (raw.version && raw.version.trim()) return raw.version.trim();
    }
  } catch {
    /* fall through */
  }
  return process.env.GROK_CLIENT_VERSION ?? DEFAULT_CLI_VERSION;
}

function grokAgentId(): string {
  try {
    if (existsSync(GROK_AGENT_ID_FILE)) {
      const id = readFileSync(GROK_AGENT_ID_FILE, "utf-8").trim();
      if (id) return id;
    }
  } catch {
    /* fall through */
  }
  return randomUUID();
}

function grokUserAgent(): string {
  const os = process.platform === "darwin" ? "macos" : process.platform;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch;
  return `${AGENT_PRODUCT}/${grokCliVersion()} (${os}; ${arch})`;
}

function parseExpiresAt(value: string | number | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function loadAuthFile(): Record<string, GrokAuthEntry> {
  if (!existsSync(GROK_AUTH_FILE)) {
    throw new Error(
      `Grok credentials not found at ${GROK_AUTH_FILE}. Run \`grok login\` first.`
    );
  }
  const parsed = JSON.parse(readFileSync(GROK_AUTH_FILE, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${GROK_AUTH_FILE} is not a JSON object`);
  }
  return parsed as Record<string, GrokAuthEntry>;
}

function pickAuthEntry(
  store: Record<string, GrokAuthEntry>
): { entryKey: string; entry: GrokAuthEntry } {
  const top = store as GrokAuthEntry & Record<string, GrokAuthEntry>;
  if (typeof top.key === "string" && top.key.trim()) {
    return { entryKey: "", entry: top };
  }
  for (const [entryKey, entry] of Object.entries(store)) {
    if (entry && typeof entry === "object" && typeof entry.key === "string" && entry.key.trim()) {
      return { entryKey, entry };
    }
  }
  throw new Error(
    `${GROK_AUTH_FILE} has no usable key. Run \`grok login\` and confirm the file has an OIDC entry.`
  );
}

function loadCredsFromDisk(): LoadedGrokCreds {
  const envKey = process.env.GROK_API_KEY ?? process.env.XAI_API_KEY;
  if (envKey && envKey.trim()) {
    return {
      accessToken: envKey.trim(),
      expiresAt: Infinity,
      issuer: DEFAULT_ISSUER,
      clientId: "",
      entryKey: "",
      raw: {},
    };
  }
  const raw = loadAuthFile();
  const { entryKey, entry } = pickAuthEntry(raw);
  return {
    accessToken: String(entry.key).trim(),
    refreshToken: entry.refresh_token,
    expiresAt: parseExpiresAt(entry.expires_at),
    issuer: (entry.oidc_issuer || DEFAULT_ISSUER).replace(/\/+$/, ""),
    clientId: entry.oidc_client_id || "",
    principalType: entry.principal_type,
    principalId: entry.principal_id,
    userId: entry.user_id,
    entryKey,
    raw,
  };
}

function persistCreds(creds: LoadedGrokCreds): void {
  if (!creds.entryKey || creds.expiresAt === Infinity) return;
  const next = { ...creds.raw };
  const prev = next[creds.entryKey] ?? {};
  next[creds.entryKey] = {
    ...prev,
    key: creds.accessToken,
    refresh_token: creds.refreshToken ?? prev.refresh_token,
    expires_at: new Date(creds.expiresAt).toISOString(),
  };
  mkdirSync(GROK_HOME, { recursive: true });
  const tmp = `${GROK_AUTH_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, GROK_AUTH_FILE);
}

async function discoverTokenEndpoint(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const resp = await fetch(url, { headers: { accept: "application/json" } });
  if (!resp.ok) {
    throw new Error(`Grok OIDC discovery failed: ${resp.status} from ${url}`);
  }
  const doc = (await resp.json()) as { token_endpoint?: string };
  if (!doc.token_endpoint) {
    throw new Error(`Grok OIDC discovery missing token_endpoint (${url})`);
  }
  return doc.token_endpoint;
}

async function refreshGrokToken(current: LoadedGrokCreds): Promise<LoadedGrokCreds> {
  if (!current.refreshToken || !current.clientId) {
    throw new Error("Grok OIDC refresh requires refresh_token and oidc_client_id");
  }
  const tokenEndpoint = await discoverTokenEndpoint(current.issuer);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
    client_id: current.clientId,
  });
  if (current.principalType) body.set("principal_type", current.principalType);
  if (current.principalId) body.set("principal_id", current.principalId);
  const resp = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Grok token refresh failed: ${resp.status} ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error("Grok refresh response missing access_token");
  }
  const expiresIn = data.expires_in ?? 3600;
  const next: LoadedGrokCreds = {
    ...current,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  try {
    persistCreds(next);
    logger.info("[grok] refreshed OIDC token and wrote ~/.grok/auth.json");
  } catch (err) {
    logger.warn(`[grok] persist after refresh failed: ${(err as Error).message}`);
  }
  return next;
}

let cachedCreds: LoadedGrokCreds | null = null;
let refreshInflight: Promise<LoadedGrokCreds> | null = null;

async function getFreshCreds(): Promise<LoadedGrokCreds> {
  if (!cachedCreds) cachedCreds = loadCredsFromDisk();
  if (cachedCreds.expiresAt === Infinity) return cachedCreds;
  if (cachedCreds.expiresAt - Date.now() > REFRESH_SKEW_MS) return cachedCreds;
  if (!cachedCreds.refreshToken) {
    logger.warn("[grok] access token near expiry but no refresh_token — sending as-is");
    return cachedCreds;
  }
  if (!refreshInflight) {
    refreshInflight = refreshGrokToken(cachedCreds)
      .then((fresh) => {
        cachedCreds = fresh;
        return fresh;
      })
      .finally(() => {
        refreshInflight = null;
      });
  }
  return refreshInflight;
}

let rateGuard: RateGuard | null = null;

export function configureGrokRateGuard(config?: RelayRateGuardConfig): void {
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

export function getGrokRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null {
  return rateGuard ? rateGuard.currentLoad() : null;
}

export async function preflightGrokApi(config?: RelayRateGuardConfig): Promise<void> {
  configureDispatcher();
  if (!rateGuard) configureGrokRateGuard(config);
  const creds = await getFreshCreds();
  const expLabel =
    creds.expiresAt === Infinity
      ? "never"
      : `${Math.floor((creds.expiresAt - Date.now()) / 1000)}s`;
  logger.info(`[grok] preflight OK (expires_in=${expLabel}, issuer=${creds.issuer})`);
}

export interface CallGrokApiOptions {
  prompt?: string;
  passthroughBody?: Record<string, unknown>;
  model: string;
  maxTokens?: number;
  onRawEvent?: (rawFrame: string) => void;
  sessionKey?: string;
}

export async function callGrokApi(opts: CallGrokApiOptions): Promise<ParsedOutput> {
  configureDispatcher();
  if (!rateGuard) configureGrokRateGuard();
  return rateGuard!.run(() => doCall(opts));
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function grokIdentityHeaders(opts: {
  model: string;
  sessionId: string;
  reqId: string;
  userId?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": grokUserAgent(),
    "x-grok-client-version": grokCliVersion(),
    "x-grok-client-identifier": AGENT_PRODUCT,
    "x-grok-client-mode": "interactive",
    "x-grok-conv-id": opts.sessionId,
    "x-grok-req-id": opts.reqId,
    "x-grok-model-override": opts.model,
    "x-grok-session-id": opts.sessionId,
    "x-grok-agent-id": grokAgentId(),
  };
  if (opts.userId) headers["x-grok-user-id"] = opts.userId;
  return headers;
}

async function doCall(opts: CallGrokApiOptions): Promise<ParsedOutput> {
  const creds = await getFreshCreds();
  const baseUrl = (process.env.GROK_CLI_CHAT_PROXY_BASE_URL ?? CLI_CHAT_PROXY_BASE).replace(
    /\/+$/,
    ""
  );
  const sessionId = opts.sessionKey || randomUUID();
  const reqId = randomUUID();

  const body: Record<string, unknown> = opts.passthroughBody
    ? { ...opts.passthroughBody, model: opts.model, stream: true, stream_options: { include_usage: true } }
    : {
        model: opts.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: opts.prompt ?? "" }],
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      };

  const url = `${baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${creds.accessToken}`,
      ...grokIdentityHeaders({
        model: opts.model,
        sessionId,
        reqId,
        userId: creds.userId,
      }),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`grok upstream ${resp.status}: ${text.slice(0, 500)}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("grok upstream returned empty body");

  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";
  let usage: OpenAIUsage | undefined;
  let modelUsed = opts.model;
  let upstreamId = sessionId;

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
          if (parsed.model) modelUsed = parsed.model;
          if (parsed.id) upstreamId = parsed.id;
          for (const ch of parsed.choices ?? []) {
            const delta = ch.delta?.content ?? ch.message?.content;
            if (typeof delta === "string") text += delta;
          }
          if (parsed.usage) usage = parsed.usage;
        } catch {
          /* heartbeat / non-JSON */
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
    sessionId: upstreamId,
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
