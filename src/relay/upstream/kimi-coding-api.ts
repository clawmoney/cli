/**
 * Kimi Code (Moonshot Kimi Coding Plan) adapter.
 *
 * Supports three credential sources, in order of preference:
 *
 *   1. kimi-cli's native OAuth store at ~/.kimi/credentials/kimi-code.json
 *      (populated by `kimi login`; refreshed against auth.kimi.com).
 *   2. An OpenClaw api_key profile (provider="kimi") — static Bearer from
 *      `openclaw onboard --auth-choice kimi-code-api-key`.
 *   3. `KIMI_API_KEY` env var — static Bearer for providers who want to
 *      ship their own key without involving kimi-cli or openclaw.
 *
 * Wire is OpenAI-compatible (/chat/completions + SSE), just like the
 * moonshot / openai / zai passthrough specs. The wrinkles on top of
 * vanilla passthrough are OAuth-specific:
 *
 *   - Token auto-refresh against https://auth.kimi.com/api/oauth/token
 *     (standard OAuth2 refresh_token grant, client_id
 *     17e5f671-d194-4dfb-9706-5516cb48c098 — same value the kimi-cli
 *     public binary ships with).
 *   - Refreshed tokens written back to the same file kimi-cli reads, so
 *     our relay daemon and a concurrent `kimi` TUI on the same machine
 *     stay in sync instead of fighting over token state.
 *   - Moonshot-flavored fingerprint headers (X-Msh-Platform, -Version,
 *     -Device-Id, etc.) — matches what a real kimi-cli sends so upstream
 *     fraud detection doesn't flag relay traffic as unknown-client.
 *     Device id is read from ~/.kimi/device_id; if the operator hasn't
 *     run kimi-cli locally we synthesize one and persist it (same thing
 *     kimi-cli does on first launch).
 *
 * Source of truth for all the above is
 * https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/auth/oauth.py.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, hostname, platform as osPlatform, release as osRelease, arch as osArch, type as osType } from "node:os";
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
import { readOpenclawApiKeyProfile } from "./openclaw-creds.js";

export { RateGuardBudgetExceededError, RateGuardCooldownError };

// ── Constants sourced from kimi-cli's auth/oauth.py ──────────────────────

const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_COD_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_SHARE_DIR = join(homedir(), ".kimi");
const KIMI_CREDENTIALS_FILE = join(KIMI_SHARE_DIR, "credentials", "kimi-code.json");
const KIMI_DEVICE_ID_FILE = join(KIMI_SHARE_DIR, "device_id");

// Refresh proactively when within 5 minutes of expiry, matching kimi-cli's
// MIN_REFRESH_THRESHOLD_SECONDS = 300.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Shape of ~/.kimi/credentials/kimi-code.json. Matches
 * kimi_cli.auth.oauth.OAuthToken.to_dict(). `expires_at` is unix seconds,
 * not milliseconds — we convert to ms internally.
 */
interface KimiOAuthFile {
  access_token: string;
  refresh_token: string;
  expires_at: number;   // unix SECONDS
  scope?: string;
  token_type?: string;
  expires_in?: number;
}

type CredsSource = "kimi-cli-file" | "openclaw-apikey" | "env";

interface LoadedCreds {
  source: CredsSource;
  accessToken: string;
  /** Only set when source === "kimi-cli-file" (static keys have no refresh). */
  refreshToken?: string;
  /** Unix ms. Infinity for static keys. */
  expiresAt: number;
  /** Full raw file contents so refresh can preserve scope/token_type on rewrite. */
  _rawFile?: KimiOAuthFile;
}

// ── Dispatcher (HTTPS_PROXY support, same pattern as other adapters) ────

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
    logger.info(`[kimi-coding] upstream proxy ${proxyUrl}`);
  }
  dispatcherConfigured = true;
}

// ── Device id (~/.kimi/device_id) ────────────────────────────────────────

let cachedDeviceId: string | null = null;
function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    if (existsSync(KIMI_DEVICE_ID_FILE)) {
      const raw = readFileSync(KIMI_DEVICE_ID_FILE, "utf-8").trim();
      if (raw) {
        cachedDeviceId = raw;
        return raw;
      }
    }
  } catch (err) {
    logger.warn(`[kimi-coding] failed to read device_id: ${(err as Error).message}`);
  }
  // First launch on this host — synthesize and persist the same way kimi-cli does.
  const fresh = randomUUID().replace(/-/g, "");
  try {
    mkdirSync(KIMI_SHARE_DIR, { recursive: true });
    writeFileSync(KIMI_DEVICE_ID_FILE, fresh, { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    logger.warn(`[kimi-coding] failed to persist device_id: ${(err as Error).message}`);
  }
  cachedDeviceId = fresh;
  return fresh;
}

// ── X-Msh-* fingerprint headers ──────────────────────────────────────────

function asciiHeaderValue(value: string): string {
  // Node's undici rejects non-ASCII header values; kimi-cli falls back to a
  // filtered substring too (see _ascii_header_value in oauth.py).
  const ascii = value.replace(/[^\x20-\x7e]/g, "").trim();
  return ascii || "unknown";
}

function commonMshHeaders(): Record<string, string> {
  let deviceModel = osType();
  if (osPlatform() === "darwin") {
    deviceModel = `macOS ${osRelease()} ${osArch()}`;
  } else if (osPlatform() === "win32") {
    deviceModel = `Windows ${osRelease()} ${osArch()}`;
  } else {
    deviceModel = `${osType()} ${osRelease()} ${osArch()}`;
  }
  return {
    "X-Msh-Platform": "kimi_cli",
    "X-Msh-Version": asciiHeaderValue(process.env.KIMI_CLI_VERSION ?? "0.1.0"),
    "X-Msh-Device-Name": asciiHeaderValue(hostname()),
    "X-Msh-Device-Model": asciiHeaderValue(deviceModel),
    "X-Msh-Os-Version": asciiHeaderValue(osRelease()),
    "X-Msh-Device-Id": getDeviceId(),
  };
}

// ── Credential I/O ───────────────────────────────────────────────────────

function readCredentialsFile(): KimiOAuthFile | null {
  if (!existsSync(KIMI_CREDENTIALS_FILE)) return null;
  try {
    const parsed = JSON.parse(readFileSync(KIMI_CREDENTIALS_FILE, "utf-8")) as Partial<KimiOAuthFile>;
    if (!parsed.access_token || !parsed.refresh_token) return null;
    return parsed as KimiOAuthFile;
  } catch (err) {
    logger.warn(`[kimi-coding] failed to parse ${KIMI_CREDENTIALS_FILE}: ${(err as Error).message}`);
    return null;
  }
}

function writeCredentialsFile(file: KimiOAuthFile): void {
  mkdirSync(join(KIMI_SHARE_DIR, "credentials"), { recursive: true });
  const tmp = `${KIMI_CREDENTIALS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, KIMI_CREDENTIALS_FILE);
}

function loadCreds(): LoadedCreds {
  // Preferred: ~/.kimi/credentials/kimi-code.json (OAuth).
  const file = readCredentialsFile();
  if (file) {
    return {
      source: "kimi-cli-file",
      accessToken: file.access_token,
      refreshToken: file.refresh_token,
      expiresAt: file.expires_at * 1000, // s → ms
      _rawFile: file,
    };
  }

  // Fall back: OpenClaw api_key profile.
  const apiKeyProfile = readOpenclawApiKeyProfile("kimi");
  if (apiKeyProfile) {
    logger.info(
      `[kimi-coding] using OpenClaw api_key fallback (profile=${apiKeyProfile.profileKey})`
    );
    return {
      source: "openclaw-apikey",
      accessToken: apiKeyProfile.key,
      expiresAt: Infinity,
    };
  }

  // Last resort: env var.
  const envKey = process.env.KIMI_API_KEY;
  if (envKey && envKey.length > 0) {
    return {
      source: "env",
      accessToken: envKey,
      expiresAt: Infinity,
    };
  }

  throw new Error(
    `Kimi Coding credentials not found (checked ${KIMI_CREDENTIALS_FILE}, ` +
      `openclaw kimi api_key profile, and env KIMI_API_KEY). ` +
      `Run \`kimi login\` (installs kimi-cli from pypi), \`openclaw onboard --auth-choice kimi-code-api-key\`, ` +
      `or \`export KIMI_API_KEY=sk-...\`.`
  );
}

// ── OAuth refresh ────────────────────────────────────────────────────────

interface RefreshedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms
  scope?: string;
  tokenType?: string;
  expiresIn?: number;
}

async function refreshUpstreamToken(refreshToken: string): Promise<RefreshedToken> {
  const url = `${KIMI_OAUTH_HOST}/api/oauth/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: KIMI_CODE_CLIENT_ID,
    refresh_token: refreshToken,
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...commonMshHeaders(),
    },
    body: body.toString(),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Kimi token refresh failed: ${resp.status} ${text.slice(0, 300)}`);
  }
  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
  if (!data.access_token || !data.refresh_token) {
    throw new Error("Kimi refresh response missing access_token / refresh_token");
  }
  const expiresIn = data.expires_in ?? 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: data.scope,
    tokenType: data.token_type,
    expiresIn,
  };
}

let cachedCreds: LoadedCreds | null = null;
let refreshInflight: Promise<LoadedCreds> | null = null;

async function doRefreshAndPersist(current: LoadedCreds): Promise<LoadedCreds> {
  if (current.source !== "kimi-cli-file" || !current.refreshToken || !current._rawFile) {
    // Static-key sources don't refresh.
    return current;
  }
  logger.info("[kimi-coding] refreshing OAuth token...");
  const fresh = await refreshUpstreamToken(current.refreshToken);

  // Persist first; see claude-api / codex-api rationale for
  // "write-before-advance" to avoid two-tokens-in-flight hijack signal.
  const updatedFile: KimiOAuthFile = {
    access_token: fresh.accessToken,
    refresh_token: fresh.refreshToken,
    expires_at: Math.floor(fresh.expiresAt / 1000), // ms → s to match kimi-cli
    scope: fresh.scope ?? current._rawFile.scope,
    token_type: fresh.tokenType ?? current._rawFile.token_type ?? "Bearer",
    expires_in: fresh.expiresIn ?? current._rawFile.expires_in,
  };
  try {
    writeCredentialsFile(updatedFile);
    logger.info(`[kimi-coding] ${KIMI_CREDENTIALS_FILE} updated`);
  } catch (err) {
    logger.error(
      `[kimi-coding] CRITICAL: persist failed — keeping old token: ${(err as Error).message}`
    );
    return current;
  }
  return {
    source: "kimi-cli-file",
    accessToken: fresh.accessToken,
    refreshToken: fresh.refreshToken,
    expiresAt: fresh.expiresAt,
    _rawFile: updatedFile,
  };
}

async function getFreshCreds(): Promise<LoadedCreds> {
  if (!cachedCreds) {
    cachedCreds = loadCreds();
  }
  if (cachedCreds.source !== "kimi-cli-file") {
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

export function configureKimiCodingRateGuard(config?: RelayRateGuardConfig): void {
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

export function getKimiCodingRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null {
  return rateGuard ? rateGuard.currentLoad() : null;
}

// ── Preflight ────────────────────────────────────────────────────────────

export async function preflightKimiCodingApi(config?: RelayRateGuardConfig): Promise<void> {
  configureDispatcher();
  if (!rateGuard) configureKimiCodingRateGuard(config);
  const creds = await getFreshCreds();
  const expLabel =
    creds.expiresAt === Infinity
      ? "never"
      : `${Math.floor((creds.expiresAt - Date.now()) / 1000)}s`;
  logger.info(
    `[kimi-coding] preflight OK (source=${creds.source}, expires_in=${expLabel})`
  );
}

// ── API call ─────────────────────────────────────────────────────────────

export interface CallKimiCodingApiOptions {
  prompt?: string;
  passthroughBody?: Record<string, unknown>;
  model: string;
  maxTokens?: number;
  onRawEvent?: (rawFrame: string) => void;
}

export async function callKimiCodingApi(opts: CallKimiCodingApiOptions): Promise<ParsedOutput> {
  configureDispatcher();
  if (!rateGuard) configureKimiCodingRateGuard();
  return rateGuard!.run(() => doCall(opts));
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

async function doCall(opts: CallKimiCodingApiOptions): Promise<ParsedOutput> {
  const creds = await getFreshCreds();
  const baseUrl = (process.env.KIMI_CODE_BASE_URL ?? KIMI_COD_BASE_URL).replace(/\/+$/, "");

  const body: Record<string, unknown> = opts.passthroughBody
    ? { ...opts.passthroughBody, model: opts.model, stream: true }
    : {
        model: opts.model,
        stream: true,
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
      ...commonMshHeaders(),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`kimi-coding upstream ${resp.status}: ${text.slice(0, 500)}`);
  }

  const reader = resp.body?.getReader();
  if (!reader) throw new Error("kimi-coding upstream returned empty body");

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
          // ignore non-JSON / heartbeat frames
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
