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
import { fetch, ProxyAgent, setGlobalDispatcher } from "undici";
import { relayLogger as logger } from "../logger.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError, } from "./rate-guard.js";
import { calculateCost } from "../pricing.js";
import { readOpenclawApiKeyProfile } from "./openclaw-creds.js";
// Re-export so provider.ts can catch the same error classes uniformly.
export { RateGuardBudgetExceededError, RateGuardCooldownError };
const specsByCliType = new Map();
export function registerPassthroughSpec(spec) {
    specsByCliType.set(spec.cliType, spec);
}
export function getPassthroughSpec(cliType) {
    return specsByCliType.get(cliType) ?? null;
}
export function listPassthroughCliTypes() {
    return Array.from(specsByCliType.keys());
}
// ── Proxy dispatcher (same pattern as OAuth adapters) ─────────────────────
let dispatcherConfigured = false;
function configureDispatcher() {
    if (dispatcherConfigured)
        return;
    const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
    if (proxyUrl) {
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
        logger.info(`[passthrough] upstream proxy ${proxyUrl}`);
    }
    dispatcherConfigured = true;
}
function resolveKey(spec) {
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
    throw new Error(`No API key found for cli_type="${spec.cliType}" ` +
        `(checked openclaw provider="${spec.openclawProvider}" and env ${spec.envVarName}). ` +
        `Run \`openclaw onboard\` or \`export ${spec.envVarName}=...\` before starting the daemon.`);
}
// ── Rate guards (one per cli_type) ────────────────────────────────────────
const rateGuards = new Map();
function ensureRateGuard(spec, config) {
    const existing = rateGuards.get(spec.cliType);
    if (existing)
        return existing;
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
export function configurePassthroughRateGuard(cliType, config) {
    const spec = getPassthroughSpec(cliType);
    if (!spec)
        return;
    rateGuards.delete(cliType);
    ensureRateGuard(spec, config);
}
export function getPassthroughRateGuardSnapshot(cliType) {
    const guard = rateGuards.get(cliType);
    return guard ? guard.currentLoad() : null;
}
// ── Preflight ─────────────────────────────────────────────────────────────
export async function preflightPassthroughApi(cliType, config) {
    const spec = getPassthroughSpec(cliType);
    if (!spec) {
        throw new Error(`No passthrough spec registered for cli_type="${cliType}"`);
    }
    configureDispatcher();
    ensureRateGuard(spec, config);
    const resolved = resolveKey(spec);
    logger.info(`[${spec.cliType}] preflight OK (key_source=${resolved.source}` +
        (resolved.source === "openclaw" ? `, profile=${resolved.profileKey}` : "") +
        `, baseUrl=${spec.baseUrl})`);
}
export async function callPassthroughApi(opts) {
    const spec = getPassthroughSpec(opts.cliType);
    if (!spec) {
        throw new Error(`No passthrough spec registered for cli_type="${opts.cliType}"`);
    }
    configureDispatcher();
    const guard = ensureRateGuard(spec);
    return guard.run(() => doCallPassthrough(spec, opts));
}
async function doCallPassthrough(spec, opts) {
    const resolved = resolveKey(spec);
    const body = opts.passthroughBody
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
        throw new Error(`${spec.cliType} upstream ${resp.status}: ${snippet}`);
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
    let usage;
    let modelUsed = opts.model;
    let sessionId = "";
    const emitFrame = (frame) => {
        if (opts.onRawEvent)
            opts.onRawEvent(frame);
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffered += decoder.decode(value, { stream: true });
        let sepIdx;
        while ((sepIdx = buffered.indexOf("\n\n")) !== -1) {
            const frame = buffered.slice(0, sepIdx);
            buffered = buffered.slice(sepIdx + 2);
            if (!frame.trim())
                continue;
            emitFrame(`${frame}\n\n`);
            for (const line of frame.split("\n")) {
                if (!line.startsWith("data:"))
                    continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === "[DONE]")
                    continue;
                try {
                    const parsed = JSON.parse(payload);
                    if (parsed.model && !modelUsed)
                        modelUsed = parsed.model;
                    if (parsed.id && !sessionId)
                        sessionId = parsed.id;
                    for (const ch of parsed.choices ?? []) {
                        const delta = ch.delta?.content ?? ch.message?.content;
                        if (typeof delta === "string")
                            text += delta;
                    }
                    if (parsed.usage)
                        usage = parsed.usage;
                }
                catch {
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
    const breakdown = calculateCost(modelUsed || opts.model, Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens), outputTokens, cacheCreationTokens, cacheReadTokens);
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
