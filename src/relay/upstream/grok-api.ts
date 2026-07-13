/**
 * Grok Build subscription upstream.
 *
 * Authentication remains owned by the official Grok CLI. We only read the
 * cached access key from ~/.grok/auth.json. When it is near expiry, or the
 * Responses proxy returns 401, we run `grok models` and then re-read the
 * cache. In particular, this module never exchanges or persists the
 * refresh_token itself.
 */

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  fetch,
  ProxyAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

import { calculateCost } from "../pricing.js";
import { relayLogger as logger } from "../logger.js";
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard, type RateGuardConfig } from "./rate-guard.js";

const DEFAULT_MODEL = "grok-4.5";
const AUTH_REFRESH_SKEW_MS = 60_000;
const CLI_REFRESH_TIMEOUT_MS = 45_000;
const PREFLIGHT_REQUEST_TIMEOUT_MS = 30_000;
const RESPONSES_REQUEST_TIMEOUT_MS = 10 * 60_000;
const OFFICIAL_GROK_PROXY_HOST = "cli-chat-proxy.grok.com";

interface GrokCredentials {
  accessKey: string;
  expiresAt: number;
  sourceKey: string;
}

interface GrokModelEndpoint {
  baseUrl: string;
  responsesUrl: string;
  modelsUrl: string;
}

type FetchLike = typeof fetch;

interface GrokApiTestHooks {
  fetch?: FetchLike;
  runModels?: (binaryPath: string) => Promise<void>;
  grokHome?: string;
  now?: () => number;
}

let testHooks: GrokApiTestHooks = {};

/** Test-only dependency injection. Production callers must not use this. */
export function __setGrokApiTestHooks(hooks: GrokApiTestHooks): void {
  testHooks = { ...hooks };
}

/** Reset module state between mock tests. */
export function __resetGrokApiForTests(): void {
  testHooks = {};
  refreshInflight = null;
  rateGuard = null;
}

function nowMs(): number {
  return testHooks.now?.() ?? Date.now();
}

function grokHome(): string {
  return (
    testHooks.grokHome ??
    (process.env.SPAREAI_GROK_HOME ?? process.env.CLAWMONEY_GROK_HOME) ??
    join(homedir(), ".grok")
  );
}

function authFile(): string {
  return join(grokHome(), "auth.json");
}

function modelsCacheFile(): string {
  return join(grokHome(), "models_cache.json");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readJsonRecord(path: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `Grok ${label} could not be read at ${path}: ${(err as Error).message}`
    );
  }
  const record = asRecord(parsed);
  if (!record) throw new Error(`Grok ${label} at ${path} is not a JSON object`);
  return record;
}

function parseExpiry(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string" || !value.trim()) return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readGrokCredentials(): GrokCredentials {
  const path = authFile();
  if (!existsSync(path)) {
    throw new Error(
      `Grok OAuth authentication missing at ${path}. Run \`grok login\` first.`
    );
  }

  const root = readJsonRecord(path, "auth cache");
  const candidates: Array<{ sourceKey: string; value: Record<string, unknown> }> = [];

  // Current Grok Build format is a map keyed by `${issuer}::${account_id}`.
  // Older builds used a flat object, so keep the root itself as a candidate.
  if (typeof root.key === "string") {
    candidates.push({ sourceKey: "root", value: root });
  }
  for (const [sourceKey, raw] of Object.entries(root)) {
    const value = asRecord(raw);
    if (value && typeof value.key === "string") {
      candidates.push({ sourceKey, value });
    }
  }

  const usable = candidates
    .map(({ sourceKey, value }) => ({
      sourceKey,
      accessKey: typeof value.key === "string" ? value.key.trim() : "",
      expiresAt: parseExpiry(value.expires_at ?? value.expiresAt ?? value.expiry),
    }))
    .filter((entry) => entry.accessKey.length > 0)
    .sort((a, b) => b.expiresAt - a.expiresAt);

  const selected = usable[0];
  if (!selected) {
    throw new Error(
      `Grok OAuth authentication at ${path} has no cached access key. Run \`grok login\` first.`
    );
  }
  return selected;
}

function modelIdentity(value: Record<string, unknown>): string | null {
  for (const key of ["model", "id", "name"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

function unwrapModelInfo(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  return asRecord(record.info) ?? record;
}

function findModelInfo(
  root: Record<string, unknown>,
  model: string
): Record<string, unknown> | null {
  const models = root.models;
  if (Array.isArray(models)) {
    for (const entry of models) {
      const info = unwrapModelInfo(entry);
      if (info && modelIdentity(info) === model) return info;
    }
  } else {
    const modelMap = asRecord(models);
    if (modelMap) {
      const direct = unwrapModelInfo(modelMap[model]);
      if (direct) return direct;
      for (const raw of Object.values(modelMap)) {
        const info = unwrapModelInfo(raw);
        if (info && modelIdentity(info) === model) return info;
      }
    }
  }

  // Compatibility with early/hand-written caches: `{ "grok-4.5": ... }`
  // or a single flat `{ model, base_url }` record.
  const keyed = unwrapModelInfo(root[model]);
  if (keyed) return keyed;
  const rootInfo = unwrapModelInfo(root.info);
  if (rootInfo && (!modelIdentity(rootInfo) || modelIdentity(rootInfo) === model)) {
    return rootInfo;
  }
  if (
    typeof (root.base_url ?? root.baseUrl) === "string" &&
    (!modelIdentity(root) || modelIdentity(root) === model)
  ) {
    return root;
  }
  return null;
}

function resolveModelEndpoint(model: string): GrokModelEndpoint {
  const path = modelsCacheFile();
  if (!existsSync(path)) {
    throw new Error(
      `Grok model cache missing at ${path}. Run \`grok models\` first.`
    );
  }
  const root = readJsonRecord(path, "model cache");
  const info = findModelInfo(root, model);
  if (!info) {
    throw new Error(
      `Grok model ${JSON.stringify(model)} is not present in ${path}. Run \`grok models\` to refresh the catalog.`
    );
  }

  const backend = info.api_backend ?? info.apiBackend;
  if (typeof backend === "string" && backend.toLowerCase() !== "responses") {
    throw new Error(
      `Grok model ${JSON.stringify(model)} uses unsupported api_backend=${JSON.stringify(backend)} (Responses required)`
    );
  }
  const authScheme = info.auth_scheme ?? info.authScheme;
  if (
    typeof authScheme === "string" &&
    authScheme.toLowerCase() !== "bearer"
  ) {
    throw new Error(
      `Grok model ${JSON.stringify(model)} uses unsupported auth_scheme=${JSON.stringify(authScheme)} (Bearer required)`
    );
  }
  if (info.supported_in_api === false) {
    throw new Error(`Grok model ${JSON.stringify(model)} is not enabled for API use`);
  }

  const rawBase = info.base_url ?? info.baseUrl ?? info.api_base_url;
  if (typeof rawBase !== "string" || !rawBase.trim()) {
    throw new Error(
      `Grok model ${JSON.stringify(model)} has no Responses base_url in ${path}`
    );
  }
  const normalized = rawBase.trim().replace(/\/+$/, "");
  const baseUrl = normalized.endsWith("/responses")
    ? normalized.slice(0, -"/responses".length)
    : normalized;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Grok model cache contains invalid base_url=${JSON.stringify(rawBase)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Grok Responses base_url must use HTTPS (got ${parsed.protocol})`);
  }
  if (
    parsed.host !== OFFICIAL_GROK_PROXY_HOST ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/v1" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `Grok Responses base_url must be exactly https://${OFFICIAL_GROK_PROXY_HOST}/v1`
    );
  }

  return {
    baseUrl,
    responsesUrl: `${baseUrl}/responses`,
    modelsUrl: `${baseUrl}/models`,
  };
}

function isRefreshableModelCacheError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Grok model cache missing") ||
    message.includes("Grok model cache could not be read") ||
    message.includes("is not present in")
  );
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePathBinary(name: string): string | null {
  if (name.startsWith("~/") || name.startsWith("~\\")) {
    name = join(homedir(), name.slice(2));
  }
  if (name.includes("/") || name.includes("\\")) {
    return isExecutable(name) ? name : null;
  }
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve the official CLI even in Finder/launchd's minimal PATH. */
export function findGrokBinary(): string | null {
  const override = process.env.GROK_BIN;
  if (override) {
    const resolved = resolvePathBinary(override);
    if (resolved) return resolved;
  }
  const bundled = join(grokHome(), "bin", process.platform === "win32" ? "grok.exe" : "grok");
  if (isExecutable(bundled)) return bundled;
  return resolvePathBinary("grok");
}

export interface GrokLocalState {
  available: boolean;
  binaryPath: string | null;
  authPresent: boolean;
  authFresh: boolean;
  modelCacheValid: boolean;
  expiresAt?: number;
  hint: string;
}

/** Synchronous setup-wizard probe; it never invokes the CLI or the network. */
export function inspectGrokLocalState(model = DEFAULT_MODEL): GrokLocalState {
  const binaryPath = findGrokBinary();
  let authPresent = false;
  let authFresh = false;
  let modelCacheValid = false;
  let modelCacheRefreshable = false;
  let expiresAt: number | undefined;
  let authProblem = "cached OAuth access key missing";
  let cacheProblem = "model cache missing";

  try {
    const creds = readGrokCredentials();
    authPresent = true;
    expiresAt = creds.expiresAt;
    authFresh = creds.expiresAt > nowMs() + AUTH_REFRESH_SKEW_MS;
    if (!authFresh) authProblem = "cached OAuth access key expired or near expiry";
  } catch (err) {
    authProblem = (err as Error).message;
  }
  try {
    resolveModelEndpoint(model);
    modelCacheValid = true;
  } catch (err) {
    cacheProblem = (err as Error).message;
    modelCacheRefreshable = isRefreshableModelCacheError(err);
  }

  // A stale key is still selectable: daemon preflight owns the official
  // `grok models` refresh. Blocking it here would prevent setup from ever
  // reaching that preflight.
  const available = Boolean(
    binaryPath && authPresent && (modelCacheValid || modelCacheRefreshable)
  );
  let hint: string;
  if (!binaryPath) {
    hint = `official Grok CLI not found (checked GROK_BIN, ${join(grokHome(), "bin", "grok")}, and PATH)`;
  } else if (!authPresent) {
    hint = `${authProblem}; run \`${binaryPath} login\``;
  } else if (!modelCacheValid) {
    hint = modelCacheRefreshable
      ? `${cacheProblem}; daemon preflight will refresh it via \`${binaryPath} models\``
      : cacheProblem;
  } else if (!authFresh) {
    hint = `cached OAuth key present but stale; daemon preflight will refresh it via \`${binaryPath} models\``;
  } else {
    hint = `official CLI + valid cached OAuth key (${binaryPath})`;
  }
  return {
    available,
    binaryPath,
    authPresent,
    authFresh,
    modelCacheValid,
    expiresAt,
    hint,
  };
}

function runOfficialModels(binaryPath: string): Promise<void> {
  if (testHooks.runModels) return testHooks.runModels(binaryPath);
  return new Promise<void>((resolve, reject) => {
    execFile(
      binaryPath,
      ["models"],
      {
        env: { ...process.env, NO_COLOR: "1" },
        timeout: CLI_REFRESH_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (err) => {
        if (!err) {
          resolve();
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        reject(
          new Error(
            `Grok OAuth refresh via official CLI failed${code ? ` (${code})` : ""}. Run \`${binaryPath} models\` manually.`
          )
        );
      }
    );
  });
}

let refreshInflight: Promise<GrokCredentials> | null = null;

async function refreshViaOfficialCli(rejectedKey?: string): Promise<GrokCredentials> {
  // A concurrent request may already have refreshed the file after this
  // caller received 401. Avoid launching a second official CLI process.
  if (rejectedKey) {
    try {
      const current = readGrokCredentials();
      if (
        current.accessKey !== rejectedKey &&
        current.expiresAt > nowMs() + AUTH_REFRESH_SKEW_MS
      ) {
        return current;
      }
    } catch {
      // The shared refresh below will produce the actionable error.
    }
  }

  if (!refreshInflight) {
    refreshInflight = (async () => {
      const binary = findGrokBinary();
      if (!binary) {
        throw new Error(
          `Grok OAuth refresh requires the official CLI (checked GROK_BIN, ${join(grokHome(), "bin", "grok")}, and PATH)`
        );
      }
      logger.info("[grok-api] refreshing cached access key via official `grok models`...");
      await runOfficialModels(binary);
      const refreshed = readGrokCredentials();
      if (refreshed.expiresAt <= nowMs() + AUTH_REFRESH_SKEW_MS) {
        throw new Error(
          `Grok OAuth refresh via official CLI did not produce a valid cached access key. Run \`${binary} login\` and retry.`
        );
      }
      return refreshed;
    })().finally(() => {
      refreshInflight = null;
    });
  }
  return refreshInflight;
}

async function getFreshCredentials(): Promise<GrokCredentials> {
  const cached = readGrokCredentials();
  if (cached.expiresAt > nowMs() + AUTH_REFRESH_SKEW_MS) return cached;
  return refreshViaOfficialCli();
}

// ── Proxy + RateGuard ───────────────────────────────────────────────────

let dispatcherConfigured = false;

function configureDispatcher(): void {
  if (dispatcherConfigured) return;
  const proxyUrl =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (proxyUrl) {
    if (/^socks/i.test(proxyUrl)) {
      logger.warn("[grok-api] SOCKS proxy is not supported; ignoring it");
    } else {
      setGlobalDispatcher(new ProxyAgent(proxyUrl) as unknown as Dispatcher);
      logger.info("[grok-api] upstream HTTPS proxy enabled");
    }
  }
  dispatcherConfigured = true;
}

let rateGuard: RateGuard | null = null;

export function configureGrokRateGuard(config?: RelayRateGuardConfig): void {
  const mapped: Partial<RateGuardConfig> = {};
  if (config?.max_concurrency !== undefined) {
    mapped.maxConcurrency = config.max_concurrency;
  }
  if (config?.quiet_hours_max_concurrency !== undefined) {
    mapped.quietHoursMaxConcurrency = config.quiet_hours_max_concurrency;
  }
  if (config?.quiet_hours !== undefined) mapped.quietHours = config.quiet_hours;
  if (config?.min_request_gap_ms !== undefined) {
    mapped.minRequestGapMs = config.min_request_gap_ms;
  }
  if (config?.jitter_ms !== undefined) mapped.jitterMs = config.jitter_ms;
  if (config?.daily_budget_usd !== undefined) {
    mapped.dailyBudgetUsd = config.daily_budget_usd;
  }
  if (config?.max_relay_utilization !== undefined) {
    mapped.maxRelayUtilization = config.max_relay_utilization;
  }
  rateGuard = new RateGuard(mapped);
}

export function getGrokRateGuardSnapshot(): ReturnType<
  RateGuard["currentLoad"]
> | null {
  return rateGuard ? rateGuard.currentLoad() : null;
}

function fetchImpl(): FetchLike {
  return testHooks.fetch ?? fetch;
}

async function responseSnippet(response: Awaited<ReturnType<FetchLike>>): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, " ").slice(0, 500);
  } catch {
    return "<unreadable response body>";
  }
}

function retryAfterMs(value: string | null): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const absolute = Date.parse(value);
  return Number.isFinite(absolute) ? Math.max(0, absolute - nowMs()) : 60_000;
}

async function throwHttpError(
  response: Awaited<ReturnType<FetchLike>>
): Promise<never> {
  const snippet = await responseSnippet(response);
  if (response.status === 429) {
    const delay = retryAfterMs(response.headers.get("retry-after"));
    rateGuard?.triggerCooldown(nowMs() + delay, "Grok upstream 429");
    throw new Error(`Grok upstream 429 rate-limited: ${snippet}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Grok authentication unauthorized (upstream ${response.status}): ${snippet}`
    );
  }
  throw new Error(`Grok upstream ${response.status}: ${snippet}`);
}

// ── Preflight ───────────────────────────────────────────────────────────

export async function preflightGrokApi(
  config?: RelayRateGuardConfig
): Promise<void> {
  configureDispatcher();
  configureGrokRateGuard(config);
  const binary = findGrokBinary();
  if (!binary) {
    throw new Error(
      `Official Grok CLI not found (checked GROK_BIN, ${join(grokHome(), "bin", "grok")}, and PATH)`
    );
  }

  let creds = await getFreshCredentials();
  let endpoint: GrokModelEndpoint;
  try {
    endpoint = resolveModelEndpoint(DEFAULT_MODEL);
  } catch (err) {
    if (!isRefreshableModelCacheError(err)) throw err;
    creds = await refreshViaOfficialCli();
    endpoint = resolveModelEndpoint(DEFAULT_MODEL);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchImpl()(endpoint.modelsUrl, {
      method: "GET",
      signal: AbortSignal.timeout(PREFLIGHT_REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${creds.accessKey}`,
      },
    });
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel();
      creds = await refreshViaOfficialCli(creds.accessKey);
      endpoint = resolveModelEndpoint(DEFAULT_MODEL);
      continue;
    }
    if (!response.ok) await throwHttpError(response);
    // Drain the catalog so the connection can be reused; its contents are
    // already represented by models_cache.json and need not be logged.
    await response.text();
    logger.info(
      `[grok-api] preflight OK (binary=${binary}, expires_in=${Math.max(
        0,
        Math.floor((creds.expiresAt - nowMs()) / 1000)
      )}s)`
    );
    return;
  }
}

// ── Responses API call + parsing ────────────────────────────────────────

export interface CallGrokApiOptions {
  prompt?: string;
  passthroughBody?: Record<string, unknown>;
  model: string;
  maxTokens?: number;
  stream?: boolean;
  onRawEvent?: (rawFrame: string) => void;
}

interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface ResponseAccumulator {
  text: string;
  sawDelta: boolean;
  sessionId: string;
  model: string;
  usage: NormalizedUsage;
  completed: boolean;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function normalizeUsage(value: unknown): NormalizedUsage {
  const usage = asRecord(value) ?? {};
  const inputDetails =
    asRecord(usage.input_tokens_details) ??
    asRecord(usage.prompt_tokens_details) ??
    {};
  return {
    inputTokens: numberValue(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: numberValue(usage.output_tokens ?? usage.completion_tokens),
    cacheReadTokens: numberValue(
      inputDetails.cached_tokens ?? usage.cache_read_input_tokens
    ),
    cacheCreationTokens: numberValue(usage.cache_creation_input_tokens),
  };
}

function extractResponseText(value: unknown): string {
  const response = asRecord(value);
  if (!response) return "";
  if (typeof response.output_text === "string") return response.output_text;
  const output = response.output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const rawItem of output) {
    const item = asRecord(rawItem);
    if (!item) continue;
    const content = item.content;
    if (!Array.isArray(content)) {
      if (typeof item.text === "string") parts.push(item.text);
      continue;
    }
    for (const rawPart of content) {
      const part = asRecord(rawPart);
      if (!part) continue;
      const text = part.text ?? part.output_text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

function errorMessage(value: unknown): string {
  const record = asRecord(value);
  if (!record) return typeof value === "string" ? value : "unknown error";
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  const nested = asRecord(record.error);
  if (nested && typeof nested.message === "string") return nested.message;
  return JSON.stringify(record).slice(0, 500);
}

function applyResponseObject(
  acc: ResponseAccumulator,
  value: unknown,
  allowFinalText: boolean
): void {
  const response = asRecord(value);
  if (!response) return;
  if (typeof response.id === "string") acc.sessionId = response.id;
  if (typeof response.model === "string") acc.model = response.model;
  if (response.usage) acc.usage = normalizeUsage(response.usage);
  if (allowFinalText) {
    const finalText = extractResponseText(response);
    if (finalText) acc.text = finalText;
  }
}

function consumeResponseEvent(
  acc: ResponseAccumulator,
  payload: unknown,
  eventName?: string
): void {
  const event = asRecord(payload);
  if (!event) return;
  const type =
    (typeof event.type === "string" && event.type) || eventName || "message";

  if (type === "response.output_text.delta" && typeof event.delta === "string") {
    acc.text += event.delta;
    acc.sawDelta = true;
  } else if (
    type === "response.output_text.done" &&
    !acc.sawDelta &&
    typeof event.text === "string"
  ) {
    acc.text += event.text;
  }

  if (typeof event.id === "string" && !acc.sessionId) acc.sessionId = event.id;
  if (typeof event.model === "string") acc.model = event.model;
  if (event.usage) acc.usage = normalizeUsage(event.usage);

  const nestedResponse = event.response;
  const responseRecord = asRecord(nestedResponse);
  if (nestedResponse) {
    applyResponseObject(acc, nestedResponse, !acc.sawDelta);
  }

  const responseStatus =
    typeof responseRecord?.status === "string"
      ? responseRecord.status.toLowerCase()
      : "";
  if (
    type === "response.failed" ||
    type === "response.error" ||
    type === "error" ||
    responseStatus === "failed"
  ) {
    throw new Error(
      `Grok Responses error: ${errorMessage(event.error ?? responseRecord?.error ?? event)}`
    );
  }
  if (type === "response.incomplete" || responseStatus === "incomplete") {
    throw new Error(
      `Grok Responses incomplete: ${errorMessage(
        responseRecord?.incomplete_details ?? event.incomplete_details ?? event
      )}`
    );
  }
  if (type === "response.completed") acc.completed = true;
}

function makeAccumulator(model: string): ResponseAccumulator {
  return {
    text: "",
    sawDelta: false,
    sessionId: "",
    model,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    completed: false,
  };
}

async function parseSseResponse(
  response: Awaited<ReturnType<FetchLike>>,
  model: string,
  onRawEvent?: (frame: string) => void
): Promise<ResponseAccumulator> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Grok Responses stream returned an empty body");
  const acc = makeAccumulator(model);
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeFrame = (rawFrame: string): void => {
    if (!rawFrame.trim()) return;
    const normalizedFrame = rawFrame.replace(/\r\n/g, "\n");
    onRawEvent?.(`${normalizedFrame}\n\n`);
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of normalizedFrame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join("\n").trim();
    if (!data || data === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error(
        `Grok Responses stream contained invalid JSON: ${data.slice(0, 160)}`
      );
    }
    consumeResponseEvent(acc, payload, eventName);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = /\r?\n\r?\n/.exec(buffer);
    while (separator?.index !== undefined) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      consumeFrame(frame);
      separator = /\r?\n\r?\n/.exec(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeFrame(buffer);
  if (!acc.completed) {
    throw new Error(
      "Grok Responses stream ended before response.completed (truncated response)"
    );
  }
  return acc;
}

async function parseJsonResponse(
  response: Awaited<ReturnType<FetchLike>>,
  model: string
): Promise<ResponseAccumulator> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text());
  } catch (err) {
    throw new Error(`Grok Responses returned invalid JSON: ${(err as Error).message}`);
  }
  const record = asRecord(payload);
  if (record?.error) {
    throw new Error(`Grok Responses error: ${errorMessage(record.error)}`);
  }
  const status = typeof record?.status === "string" ? record.status.toLowerCase() : "";
  if (status === "incomplete" || status === "failed") {
    throw new Error(
      `Grok Responses ${status}: ${errorMessage(
        record?.incomplete_details ?? record?.error ?? record
      )}`
    );
  }
  const acc = makeAccumulator(model);
  applyResponseObject(acc, payload, true);
  return acc;
}

function hasResponsesInput(body: Record<string, unknown> | undefined): boolean {
  return Boolean(body && Object.prototype.hasOwnProperty.call(body, "input"));
}

const PAID_SERVER_TOOL_TYPES = new Set([
  "web_search",
  "x_search",
  "code_execution",
  "code_interpreter",
  "file_search",
  "collections_search",
  "attachment_search",
  "mcp",
]);

function validatePassthroughSafety(
  body: Record<string, unknown>,
  stream: boolean
): void {
  if (body.background === true) {
    throw new Error("Grok background Responses are not supported by relay");
  }
  if (body.previous_response_id != null || body.conversation != null) {
    throw new Error(
      "Grok stored response/conversation continuation is not supported; resend full prior context in input"
    );
  }
  if (
    typeof body.service_tier === "string" &&
    body.service_tier.toLowerCase() === "priority"
  ) {
    throw new Error("Grok priority service_tier is not supported by relay");
  }

  if (body.tools === undefined) return;
  if (!Array.isArray(body.tools)) {
    throw new Error("Grok Responses tools must be an array");
  }
  if (body.tools.length > 0 && !stream) {
    throw new Error(
      "Grok function tools require stream:true so typed function_call events can pass through intact"
    );
  }
  for (const rawTool of body.tools) {
    const tool = asRecord(rawTool);
    const type = typeof tool?.type === "string" ? tool.type.toLowerCase() : "";
    if (type === "function") continue;
    if (PAID_SERVER_TOOL_TYPES.has(type)) {
      throw new Error(
        `Grok server-side tool ${JSON.stringify(type)} is disabled because it incurs separate provider charges`
      );
    }
    throw new Error(
      `Unsupported Grok tool type ${JSON.stringify(type || "<missing>")}; relay only allows streamed function tools`
    );
  }
}

function buildRequestBody(opts: CallGrokApiOptions): {
  body: Record<string, unknown>;
  stream: boolean;
} {
  const passthrough = hasResponsesInput(opts.passthroughBody)
    ? opts.passthroughBody
    : undefined;
  const stream =
    opts.stream ??
    (passthrough
      ? passthrough.stream === true
      : Boolean(opts.onRawEvent));

  if (passthrough) {
    validatePassthroughSafety(passthrough, stream);
    return {
      body: {
        ...passthrough,
        model: opts.model,
        stream,
        // Responses defaults store=true. Relay traffic must never be retained
        // in the provider's Grok account, and async background jobs cannot be
        // represented by the current relay response envelope.
        store: false,
        background: false,
      },
      stream,
    };
  }

  const prompt = (opts.prompt ?? "").trim();
  if (!prompt) throw new Error("Empty Grok prompt");
  return {
    body: {
      model: opts.model,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      stream,
      store: false,
      background: false,
      ...(opts.maxTokens ? { max_output_tokens: opts.maxTokens } : {}),
    },
    stream,
  };
}

export async function callGrokApi(opts: CallGrokApiOptions): Promise<ParsedOutput> {
  configureDispatcher();
  if (!rateGuard) configureGrokRateGuard();
  return rateGuard!.run(() => doCallGrokApi(opts));
}

async function doCallGrokApi(opts: CallGrokApiOptions): Promise<ParsedOutput> {
  const request = buildRequestBody(opts);
  const serializedBody = JSON.stringify(request.body);
  let creds = await getFreshCredentials();
  let endpoint: GrokModelEndpoint;
  try {
    endpoint = resolveModelEndpoint(opts.model);
  } catch (err) {
    if (!isRefreshableModelCacheError(err)) throw err;
    creds = await refreshViaOfficialCli();
    endpoint = resolveModelEndpoint(opts.model);
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchImpl()(endpoint.responsesUrl, {
      method: "POST",
      signal: AbortSignal.timeout(RESPONSES_REQUEST_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        accept: request.stream ? "text/event-stream" : "application/json",
        authorization: `Bearer ${creds.accessKey}`,
      },
      body: serializedBody,
    });

    if (response.status === 401 && attempt === 0) {
      logger.warn("[grok-api] 401 from Responses proxy; refreshing via official CLI");
      await response.body?.cancel();
      creds = await refreshViaOfficialCli(creds.accessKey);
      endpoint = resolveModelEndpoint(opts.model);
      continue;
    }
    if (!response.ok) await throwHttpError(response);

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const isSse =
      contentType.includes("text/event-stream") ||
      (request.stream && !contentType.includes("json"));
    const acc = isSse
      ? await parseSseResponse(response, opts.model, opts.onRawEvent)
      : await parseJsonResponse(response, opts.model);

    const totalInput = acc.usage.inputTokens;
    const cacheRead = Math.min(totalInput, acc.usage.cacheReadTokens);
    const cacheCreation = Math.min(
      Math.max(0, totalInput - cacheRead),
      acc.usage.cacheCreationTokens
    );
    const baseInput = Math.max(0, totalInput - cacheRead - cacheCreation);
    const cost = calculateCost(
      acc.model || opts.model,
      baseInput,
      acc.usage.outputTokens,
      cacheCreation,
      cacheRead
    );
    rateGuard?.recordSpend(cost.apiCost);

    logger.info(
      `[grok-api] OK model=${acc.model || opts.model} in=${baseInput} out=${acc.usage.outputTokens} cache_read=${cacheRead}`
    );
    return {
      text: acc.text,
      sessionId: acc.sessionId,
      usage: {
        input_tokens: baseInput,
        output_tokens: acc.usage.outputTokens,
        cache_creation_tokens: cacheCreation,
        cache_read_tokens: cacheRead,
      },
      model: acc.model || opts.model,
      costUsd: cost.apiCost,
    };
  }

  throw new Error("Grok authentication unauthorized after official CLI refresh");
}
