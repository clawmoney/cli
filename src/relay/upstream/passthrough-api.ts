/**
 * Shared passthrough adapter for API-key-authenticated OpenAI-compatible
 * providers.
 *
 * Used by cli_types whose upstream is a static Bearer-auth REST endpoint
 * speaking the OpenAI `/v1/chat/completions` wire: zai (Z.AI / GLM),
 * moonshot, kimi-coding, qwen-cp, plus the "classic" openai API-key mode.
 *
 * Shape mirrors gemini-api.ts minus the OAuth plumbing — there's no token
 * refresh, no per-account fingerprinting, no 5h window signal. The rate-guard
 * is still honored so provider-configured concurrency / daily budget caps
 * apply the same way they do for OAuth adapters.
 *
 * Credential source, in order:
 *   1. Openclaw api_key profile (provider field matches spec.openclawProvider)
 *   2. Environment variable named by spec.envVarName
 *
 * Anything more (clawmoney-managed keystore, per-request key rotation) is
 * out of scope here; users who need that today set the env var before
 * launching the daemon.
 */

import { fetch, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { relayLogger as logger } from "../logger.js";
import {
  RateGuard,
  RateGuardBudgetExceededError,
  RateGuardCooldownError,
  RateGuardRelayUtilizationExceededError,
} from "./rate-guard.js";
import { calculateCost } from "../pricing.js";
import { readOpenclawApiKeyProfile } from "./openclaw-creds.js";

// Re-export so provider.ts can catch the same error classes uniformly.
export { RateGuardBudgetExceededError, RateGuardCooldownError };

// ── Spec registry ─────────────────────────────────────────────────────────

/**
 * Describes one passthrough upstream. One `PassthroughSpec` corresponds to
 * one clawmoney cli_type.
 */
export interface PassthroughSpec {
  /** clawmoney cli_type identifier (matches `RelayRequest.cli_type`). */
  cliType: string;
  /** OpenClaw provider id used for api_key profile lookup. */
  openclawProvider: string;
  /** Env var name to consult when openclaw profile is missing. */
  envVarName: string;
  /** Base URL of the upstream (no trailing slash). */
  baseUrl: string;
  /**
   * Wire family. "openai-completions" means buyer body is forwarded to
   * `${baseUrl}/chat/completions`. Future values (e.g. "anthropic-messages")
   * could be added, but for Step 2a every passthrough target speaks OpenAI.
   */
  api: "openai-completions";
  /**
   * Optional default rate-guard tweaks. Most upstreams are fine with the
   * generic defaults; add per-provider overrides here if a host is known
   * to rate-limit harder than the default 2-concurrency floor.
   */
  rateGuardOverrides?: Partial<RelayRateGuardConfig>;
  /**
   * Human-readable display label for log lines. Purely cosmetic.
   */
  label?: string;
}

const specsByCliType = new Map<string, PassthroughSpec>();

export function registerPassthroughSpec(spec: PassthroughSpec): void {
  specsByCliType.set(spec.cliType, spec);
}

export function getPassthroughSpec(cliType: string): PassthroughSpec | null {
  return specsByCliType.get(cliType) ?? null;
}

export function listPassthroughCliTypes(): string[] {
  return Array.from(specsByCliType.keys());
}

// ── Proxy dispatcher (same pattern as OAuth adapters) ─────────────────────

let dispatcherConfigured = false;
function configureDispatcher(): void {
  if (dispatcherConfigured) return;
  const proxyUrl =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent(proxyUrl) as unknown as Dispatcher);
    logger.info(`[passthrough] upstream proxy ${proxyUrl}`);
  }
  dispatcherConfigured = true;
}

// ── Credential resolution ─────────────────────────────────────────────────

interface ResolvedKey {
  key: string;
  source: "openclaw" | "env";
  /** Populated when source === "openclaw". */
  profileKey?: string;
  /** Populated when source === "openclaw". */
  storePath?: string;
}

function resolveKey(spec: PassthroughSpec): ResolvedKey {
  const fromOpenclaw = readOpenclawApiKeyProfile(spec.openclawProvider);
  if (fromOpenclaw) {
    return {
      key: fromOpenclaw.key,
      source: "openclaw",
      profileKey: fromOpenclaw.profileKey,
      storePath: fromOpenclaw.storePath,
    };
  }
  const fromEnv = process.env[spec.envVarName];
  if (fromEnv && fromEnv.length > 0) {
    return { key: fromEnv, source: "env" };
  }
  throw new Error(
    `No API key found for cli_type="${spec.cliType}" ` +
      `(checked openclaw provider="${spec.openclawProvider}" and env ${spec.envVarName}). ` +
      `Run \`openclaw onboard\` or \`export ${spec.envVarName}=...\` before starting the daemon.`
  );
}

// ── Rate guards (one per cli_type) ────────────────────────────────────────

const rateGuards = new Map<string, RateGuard>();

function ensureRateGuard(spec: PassthroughSpec, config?: RelayRateGuardConfig): RateGuard {
  const existing = rateGuards.get(spec.cliType);
  if (existing) return existing;
  const mapped = {
    ...(config ? {
      maxConcurrency: config.max_concurrency,
      quietHoursMaxConcurrency: config.quiet_hours_max_concurrency,
      quietHours: config.quiet_hours,
      minRequestGapMs: config.min_request_gap_ms,
      jitterMs: config.jitter_ms,
      dailyBudgetUsd: config.daily_budget_usd,
      maxRelayUtilization: config.max_relay_utilization,
    } : {}),
    ...(spec.rateGuardOverrides ? {
      maxConcurrency: spec.rateGuardOverrides.max_concurrency,
      minRequestGapMs: spec.rateGuardOverrides.min_request_gap_ms,
    } : {}),
  };
  const guard = new RateGuard(mapped);
  rateGuards.set(spec.cliType, guard);
  return guard;
}

export function configurePassthroughRateGuard(
  cliType: string,
  config?: RelayRateGuardConfig
): void {
  const spec = getPassthroughSpec(cliType);
  if (!spec) return;
  rateGuards.delete(cliType);
  ensureRateGuard(spec, config);
}

export function getPassthroughRateGuardSnapshot(
  cliType: string
): ReturnType<RateGuard["currentLoad"]> | null {
  const guard = rateGuards.get(cliType);
  return guard ? guard.currentLoad() : null;
}

// ── Preflight ─────────────────────────────────────────────────────────────

export async function preflightPassthroughApi(
  cliType: string,
  config?: RelayRateGuardConfig
): Promise<void> {
  const spec = getPassthroughSpec(cliType);
  if (!spec) {
    throw new Error(`No passthrough spec registered for cli_type="${cliType}"`);
  }
  configureDispatcher();
  ensureRateGuard(spec, config);
  const resolved = resolveKey(spec);
  logger.info(
    `[${spec.cliType}] preflight OK (key_source=${resolved.source}` +
      (resolved.source === "openclaw" ? `, profile=${resolved.profileKey}` : "") +
      `, baseUrl=${spec.baseUrl})`
  );
}

// ── API call ──────────────────────────────────────────────────────────────

export interface CallPassthroughApiOptions {
  cliType: string;
  /** Buyer-supplied prompt (template mode) — ignored when passthroughBody is set. */
  prompt?: string;
  /** Buyer-supplied full /v1/chat/completions body (passthrough mode). */
  passthroughBody?: Record<string, unknown>;
  /** Canonical model id for routing + pricing. Must match API_PRICES. */
  model: string;
  /** When true, upstream is called with stream:true and SSE is pushed to onRawEvent. */
  onRawEvent?: (rawFrame: string) => void;
  maxTokens?: number;
}

export async function callPassthroughApi(
  opts: CallPassthroughApiOptions
): Promise<ParsedOutput> {
  const spec = getPassthroughSpec(opts.cliType);
  if (!spec) {
    throw new Error(`No passthrough spec registered for cli_type="${opts.cliType}"`);
  }
  configureDispatcher();
  const guard = ensureRateGuard(spec);
  return guard.run(() => doCallPassthrough(spec, opts));
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

async function doCallPassthrough(
  spec: PassthroughSpec,
  opts: CallPassthroughApiOptions
): Promise<ParsedOutput> {
  const resolved = resolveKey(spec);

  const body: Record<string, unknown> = opts.passthroughBody
    ? { ...opts.passthroughBody, model: opts.model, stream: true }
    : {
        model: opts.model,
        stream: true,
        messages: [{ role: "user", content: opts.prompt ?? "" }],
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      };

  const url = `${spec.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${resolved.key}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    const snippet = text.slice(0, 500);
    throw new Error(
      `${spec.cliType} upstream ${resp.status}: ${snippet}`
    );
  }

  // SSE body — either stream-forward each `data: …` chunk to onRawEvent and
  // accumulate text/usage, or parse a non-streaming JSON if the upstream
  // decided to ignore our stream:true request (some proxies do).
  const reader = resp.body?.getReader();
  if (!reader) {
    throw new Error(`${spec.cliType} upstream returned empty body`);
  }

  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";
  let usage: OpenAIUsage | undefined;
  let modelUsed = opts.model;
  let sessionId = "";

  const emitFrame = (frame: string) => {
    if (opts.onRawEvent) opts.onRawEvent(frame);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let sepIdx: number;
    while ((sepIdx = buffered.indexOf("\n\n")) !== -1) {
      const frame = buffered.slice(0, sepIdx);
      buffered = buffered.slice(sepIdx + 2);
      if (!frame.trim()) continue;
      emitFrame(`${frame}\n\n`);
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
          // ignore un-parseable frames (keep-alives, heartbeats, etc.)
        }
      }
    }
  }

  // Some upstreams never emit a usage frame on stream responses; fall back
  // to zero and let pricing.calculateCost compute from token counts if they
  // surface later. Providers that want accurate billing should route through
  // OAuth adapters instead.
  const inputTokens = usage?.prompt_tokens ?? 0;
  const cacheReadTokens = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;

  const breakdown = calculateCost(
    modelUsed || opts.model,
    Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens),
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens
  );

  return {
    text,
    sessionId,
    usage: {
      input_tokens: Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens),
      output_tokens: outputTokens,
      cache_creation_tokens: cacheCreationTokens,
      cache_read_tokens: cacheReadTokens,
    },
    model: modelUsed || opts.model,
    costUsd: breakdown.apiCost,
  };
}
