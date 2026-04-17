import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { RelayWsClient } from "./ws-client.js";
import { callClaudeApi, callClaudeApiPassthrough, preflightClaudeApi, getRateGuardSnapshot as getClaudeRateGuardSnapshot, } from "./upstream/claude-api.js";
import { callCodexApi, callCodexApiPassthrough, preflightCodexApi, getRateGuardSnapshot as getCodexRateGuardSnapshot, } from "./upstream/codex-api.js";
import { callGeminiApi, preflightGeminiApi, getGeminiRateGuardSnapshot, } from "./upstream/gemini-api.js";
import { callAntigravityApi, preflightAntigravityApi, getAntigravityRateGuardSnapshot, } from "./upstream/antigravity-api.js";
import { apiGet, apiPost } from "../utils/api.js";
/**
 * Pick the rate-guard snapshot matching this request's cli_type. Fixes a
 * pre-existing bug where gemini/codex responses were piggy-backing Claude's
 * session_window telemetry because provider.ts always called the claude-api
 * snapshot regardless of upstream.
 */
function getRateGuardSnapshotForCli(cli) {
    switch (cli) {
        case "codex":
            return getCodexRateGuardSnapshot();
        case "gemini":
            return getGeminiRateGuardSnapshot();
        case "antigravity":
            return getAntigravityRateGuardSnapshot();
        case "claude":
        default:
            return getClaudeRateGuardSnapshot();
    }
}
import { calculateCost } from "./pricing.js";
import { relayLogger as logger } from "./logger.js";
const CONFIG_DIR = join(homedir(), ".clawmoney");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");
const PID_FILE = join(CONFIG_DIR, "relay.pid");
const DEFAULT_RELAY = {
    cli_type: "claude",
    model: "claude-opus-4-6",
    mode: "chat",
    concurrency: 5,
    daily_limit_usd: 20,
    ws_url: "wss://api.spareapi.ai/ws/relay",
    reconnect: {
        initial: 5,
        max: 300,
        multiplier: 2,
    },
};
// ── PID helpers ──
export function readRelayPid() {
    try {
        const content = readFileSync(PID_FILE, "utf-8").trim();
        const pid = parseInt(content, 10);
        return isNaN(pid) ? null : pid;
    }
    catch {
        return null;
    }
}
export function isRelayPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function writeRelayPid() {
    writeFileSync(PID_FILE, String(process.pid), "utf-8");
}
export function removeRelayPid() {
    try {
        unlinkSync(PID_FILE);
    }
    catch {
        // Ignore
    }
}
// ── Config loading ──
function loadRelayConfig(cliOverride) {
    let raw;
    try {
        const content = readFileSync(CONFIG_FILE, "utf-8");
        raw = YAML.parse(content);
    }
    catch (err) {
        logger.error(`Failed to read config from ${CONFIG_FILE}:`, err);
        process.exit(1);
    }
    if (!raw.api_key || typeof raw.api_key !== "string") {
        logger.error("api_key is required in config.yaml. Run 'clawmoney setup' first.");
        process.exit(1);
    }
    const userRelay = (raw.relay ?? {});
    const relay = {
        cli_type: cliOverride ?? userRelay.cli_type ?? DEFAULT_RELAY.cli_type,
        // Pass rate_guard through verbatim. Per-field merging happens
        // inside each upstream module's configureRateGuard() which
        // already knows its own defaults — we don't want to double-
        // default here.
        rate_guard: userRelay.rate_guard,
        model: userRelay.model ?? DEFAULT_RELAY.model,
        mode: userRelay.mode ?? DEFAULT_RELAY.mode,
        concurrency: userRelay.concurrency ?? DEFAULT_RELAY.concurrency,
        daily_limit_usd: userRelay.daily_limit_usd ?? DEFAULT_RELAY.daily_limit_usd,
        ws_url: userRelay.ws_url ?? DEFAULT_RELAY.ws_url,
        reconnect: {
            initial: userRelay.reconnect?.initial ?? DEFAULT_RELAY.reconnect.initial,
            max: userRelay.reconnect?.max ?? DEFAULT_RELAY.reconnect.max,
            multiplier: userRelay.reconnect?.multiplier ?? DEFAULT_RELAY.reconnect.multiplier,
        },
    };
    return {
        api_key: raw.api_key,
        agent_id: raw.agent_id,
        agent_slug: raw.agent_slug,
        relay,
        proxy: typeof raw.proxy === "string" ? raw.proxy : undefined,
    };
}
/**
 * Export the config's `proxy` setting into process.env so every downstream
 * module (claude-api, codex-api, gemini-api, antigravity-api) that already
 * reads HTTPS_PROXY at startup picks it up without any per-module changes.
 * Silently no-ops if the env var is already set by the user's shell.
 */
function applyProxyFromConfig(config) {
    if (!config.proxy)
        return;
    const alreadySet = process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy;
    if (alreadySet) {
        logger.info(`[provider] shell HTTPS_PROXY=${alreadySet} overrides config.yaml proxy=${config.proxy}`);
        return;
    }
    process.env.HTTPS_PROXY = config.proxy;
    process.env.HTTP_PROXY = config.proxy;
    logger.info(`[provider] using config.yaml proxy=${config.proxy}`);
}
// ── Request handler ──
// Flatten a Claude/OpenAI message `content` field into a plain string.
// Content may be either a string (OpenAI-style) or an array of content
// blocks (Claude Code / real Anthropic API shape: [{type:"text",text:"..."}]).
// String(array) would produce "[object Object],[object Object]" which the
// model then echoes back as garbage — hence the explicit block walk.
function extractMessageText(content) {
    if (content == null)
        return "";
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
            if (block && typeof block === "object") {
                const b = block;
                if (b.type === "text" && typeof b.text === "string" && b.text) {
                    parts.push(b.text);
                }
            }
        }
        return parts.join("\n");
    }
    return "";
}
function messagesToPrompt(messages) {
    return messages.map((m) => extractMessageText(m.content)).join("\n");
}
// ── OAuth auto-pause (per-cli_type) ────────────────────────────────────
//
// When upstream keeps rejecting our OAuth token (Anthropic 403
// permission_error, ChatGPT auth failures, etc.), continuing to hammer
// it wastes buyer requests, surfaces errors the Hub has to failover
// around, and thrashes the Hub's 5xx ban / unban cycle every time the
// daemon reconnects. Track consecutive auth-broken errors per cli_type
// — after AUTH_ERROR_THRESHOLD hits in a row, stop accepting new
// requests for THAT cli_type until daemon restart. Every successful
// upstream response resets the counter.
//
// Key properties:
//   - Per cli_type: a broken Claude OAuth doesn't take down Codex or
//     Gemini on the same daemon, because each has its own counter and
//     its own disable flag.
//   - In-memory only: state resets on daemon restart. If the operator
//     re-authed between restarts, the next request proves the token
//     works and nothing happens; if they didn't, the counter fills
//     back up within AUTH_ERROR_THRESHOLD requests and re-disables.
//   - No WS lifecycle touched: the daemon stays connected to the Hub
//     so other cli_types still serve. We just refuse to call upstream
//     for the disabled one, returning a clean error the Hub can use
//     to ban this provider row (its existing _is_auth_broken_error
//     pattern catches our "OAuth authentication broken" message).
//
// Operator recovery: run `clawmoney login <cli>` (or re-auth the
// relevant CLI directly — `claude login`, `codex login`, etc.), then
// `clawmoney relay restart` to reset the counter.
const AUTH_ERROR_THRESHOLD = 3;
const consecutiveAuthErrorsByCli = new Map();
const cliAuthDisabled = new Set();
const AUTH_BROKEN_PATTERNS = [
    // Anthropic 403: OAuth authentication is currently not allowed for
    // this organization. The new prod signal from 2026-04-15 incident.
    "permission_error",
    "not allowed for this organization",
    // Legacy Claude / Anthropic auth failures (also matched by Hub's
    // _AUTH_BROKEN_PATTERNS, so the two sides agree on classification).
    "token refresh failed",
    "invalid_grant",
    "request not allowed",
    "oauth refresh",
    // Generic OAuth HTTP signatures. Catches the one-off 401/403
    // responses from codex / gemini / antigravity that carry the same
    // meaning even when the upstream-specific message format differs.
    "unauthorized",
];
function isAuthBrokenError(errMsg) {
    const lower = errMsg.toLowerCase();
    return AUTH_BROKEN_PATTERNS.some((p) => lower.includes(p));
}
function noteUpstreamAuthError(cliType) {
    const next = (consecutiveAuthErrorsByCli.get(cliType) ?? 0) + 1;
    consecutiveAuthErrorsByCli.set(cliType, next);
    if (next >= AUTH_ERROR_THRESHOLD && !cliAuthDisabled.has(cliType)) {
        cliAuthDisabled.add(cliType);
        logger.error("");
        logger.error(`  ╔══════════════════════════════════════════════════════════════`);
        logger.error(`  ║ OAuth broken for cli_type='${cliType}' — ${next} consecutive`);
        logger.error(`  ║ auth-broken responses from upstream. Pausing relay for this`);
        logger.error(`  ║ cli_type to stop thrashing buyer requests + Hub ban state.`);
        logger.error(`  ║`);
        logger.error(`  ║ TO RESUME: re-authenticate your ${cliType} CLI locally, then`);
        logger.error(`  ║           run 'clawmoney relay restart'.`);
        logger.error(`  ║`);
        logger.error(`  ║ Other cli_types on this daemon continue to serve normally.`);
        logger.error(`  ╚══════════════════════════════════════════════════════════════`);
        logger.error("");
    }
}
function noteUpstreamSuccess(cliType) {
    // Successful request → reset the consecutive counter. The disabled
    // flag is sticky until daemon restart on purpose — we never want to
    // "heal" mid-run based on a single lucky response, which could be
    // an upstream glitch rather than a real token refresh.
    consecutiveAuthErrorsByCli.delete(cliType);
}
async function executeRelayRequest(request, config, sendChunk) {
    const { request_id, max_budget_usd } = request;
    const cliType = request.cli_type ?? config.relay.cli_type;
    const model = request.model ?? config.relay.model;
    const stateful = request.stateful ?? false;
    const cliSessionId = request.cli_session_id ?? undefined;
    // Build prompt from messages
    const prompt = request.messages
        ? messagesToPrompt(request.messages)
        : request.prompt ?? "";
    const lastUserMsg = request.messages
        ? extractMessageText([...request.messages].reverse().find((m) => m.role === "user")?.content)
        : prompt;
    const turns = request.messages
        ? request.messages.filter((m) => m.role === "user").length
        : 1;
    const modeLabel = stateful
        ? (cliSessionId ? `stateful[resume ${cliSessionId.slice(0, 8)}]` : "stateful[new]")
        : "stateless";
    logger.info(`  ┌─ Request ${request_id.slice(0, 8)}`);
    logger.info(`  │ CLI:    ${cliType} / ${model} (${modeLabel})`);
    logger.info(`  │ Turns:  ${turns}`);
    logger.info(`  │ Prompt: ${String(lastUserMsg).slice(0, 80)}`);
    // Fast-fail if this cli_type was auto-paused by a run of auth-broken
    // responses earlier in the session. Returning the error here instead
    // of calling upstream saves the round-trip and keeps the Hub's ban
    // pattern triggering (it matches "OAuth authentication" / "auth
    // broken" in _is_auth_broken_error) so buyer requests go straight to
    // a healthy provider.
    if (cliAuthDisabled.has(cliType)) {
        logger.warn(`  └─ REFUSED: ${cliType} auth paused (restart relay after re-auth)`);
        return {
            event: "relay_response",
            request_id,
            content: "",
            error: `OAuth authentication broken for cli_type='${cliType}'. Provider needs to re-authenticate locally and restart the daemon. (permission_error)`,
        };
    }
    try {
        const startMs = Date.now();
        let parsed;
        // Direct upstream API call — the right handler is picked by cli_type
        // (claude → Anthropic, codex → chatgpt.com WS, gemini → cloudcode-pa,
        // antigravity → daily-cloudcode-pa). Each handler has its own
        // fingerprint file and rate-guard instance.
        if (cliType === "codex") {
            // Same two-mode pattern as claude: passthrough when the Hub forwards
            // a real Responses API body (used by /v1/responses endpoint for
            // Codex CLI drop-in replacement), template mode otherwise (used by
            // the OpenAI-compat /v1/chat/completions classic endpoint).
            if (request.passthrough_body) {
                parsed = await callCodexApiPassthrough({
                    clientBody: request.passthrough_body,
                    model,
                    onRawEvent: sendChunk,
                });
            }
            else {
                parsed = await callCodexApi({
                    prompt,
                    model,
                    maxTokens: max_budget_usd ? undefined : 4096,
                    onRawEvent: sendChunk,
                });
            }
        }
        else if (cliType === "gemini") {
            parsed = await callGeminiApi({
                prompt,
                model,
                maxTokens: max_budget_usd ? undefined : 8192,
            });
        }
        else if (cliType === "antigravity") {
            parsed = await callAntigravityApi({
                prompt,
                model,
                maxTokens: max_budget_usd ? undefined : 8192,
            });
        }
        else {
            // Claude: two modes.
            //
            // 1. PASSTHROUGH (preferred when Hub supplies request.passthrough_body):
            //    the Hub is acting as a transparent ANTHROPIC_BASE_URL proxy for a
            //    real Claude Code (or anthropic-SDK) client. Forward the buyer's
            //    actual body — tools, multi-turn messages, thinking, system, etc.
            //    all preserved — with surgical fingerprint rewrites so Anthropic
            //    sees a stable per-OAuth-account identity instead of a rotating
            //    buyer-identity signal.
            //
            // 2. TEMPLATE (fallback when no passthrough_body): the legacy
            //    chat-relay path. Daemon constructs a synthetic single-user-message
            //    request body that matches the real CC wire fingerprint exactly,
            //    dropping everything the buyer sent except the concatenated prompt
            //    text. Used for OpenAI-compatible /v1/chat/completions and any
            //    other client that doesn't need real agentic support.
            if (request.passthrough_body) {
                parsed = await callClaudeApiPassthrough({
                    clientBody: request.passthrough_body,
                    model,
                    clientBeta: request.anthropic_beta,
                    onRawEvent: sendChunk,
                });
            }
            else {
                parsed = await callClaudeApi({
                    prompt,
                    model,
                    maxTokens: max_budget_usd ? undefined : 4096,
                    onRawEvent: sendChunk,
                });
            }
        }
        const elapsedMs = Date.now() - startMs;
        const answer = parsed.text.replace(/\n/g, " ").slice(0, 80);
        const { input_tokens: inT, output_tokens: outT, cache_creation_tokens: cacheWriteT, cache_read_tokens: cacheReadT } = parsed.usage;
        const cost = calculateCost(model, inT, outT, cacheWriteT, cacheReadT);
        const elapsedSec = (elapsedMs / 1000).toFixed(1);
        logger.info(`  │ Answer: ${answer}`);
        logger.info(`  │ Tokens: input=${inT} cache_write=${cacheWriteT} cache_read=${cacheReadT} output=${outT}`);
        logger.info(`  │ Time:   ${elapsedSec}s`);
        logger.info(`  │ Cost:   input=$${cost.inputCost.toFixed(4)} cache_w=$${cost.cacheCreationCost.toFixed(4)} cache_r=$${cost.cacheReadCost.toFixed(4)} output=$${cost.outputCost.toFixed(4)}`);
        logger.info(`  │ Total:  API $${cost.apiCost.toFixed(4)} → Relay $${cost.relayCost.toFixed(4)} → Earn $${cost.providerEarn.toFixed(4)}`);
        logger.info(`  └─ Done`);
        // Piggy-back the provider's current 5h session-window snapshot onto
        // the response so the Hub can use it for predictive claim scheduling
        // (avoid routing fresh work to a provider whose window is already
        // 90%+ saturated).
        let sessionWindowTelemetry;
        const snap = getRateGuardSnapshotForCli(cliType);
        if (snap?.sessionWindow) {
            sessionWindowTelemetry = {
                reset_at_ms: snap.sessionWindow.endMs,
                utilization: snap.sessionWindow.utilization,
                status: snap.sessionWindow.status,
            };
        }
        // CLAWMONEY_FAKE_MODEL_USED — test-only lever. When set, rewrite the
        // reported `model_used` field to the env var's value before returning
        // to the Hub. Used to manually exercise the Hub's model-mismatch guard
        // + quarantine flow without having to juggle real subscription tiers
        // or fake upstream accounts. DO NOT set this in production.
        const fakeModelUsed = process.env.CLAWMONEY_FAKE_MODEL_USED;
        const reportedModel = fakeModelUsed || parsed.model || model;
        if (fakeModelUsed) {
            logger.warn(`  ! CLAWMONEY_FAKE_MODEL_USED=${fakeModelUsed} — reporting fake model to Hub (test mode)`);
        }
        // Successful upstream round-trip — reset the auth-error counter for
        // this cli_type. One good response means the token currently works.
        noteUpstreamSuccess(cliType);
        return {
            event: "relay_response",
            request_id,
            content: parsed.text,
            cli_session_id: parsed.sessionId || undefined,
            usage: parsed.usage,
            model_used: reportedModel,
            cost_usd: parsed.costUsd || undefined,
            session_window: sessionWindowTelemetry,
        };
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error(`  └─ ERROR: ${errMsg}`);
        // If the upstream error looks like a persistent auth failure
        // (OAuth rejected, token broken, permission_error, etc.), bump
        // this cli_type's consecutive-auth-error counter. After
        // AUTH_ERROR_THRESHOLD in a row, future requests for this
        // cli_type short-circuit at the top of executeRelayRequest until
        // daemon restart.
        if (isAuthBrokenError(errMsg)) {
            noteUpstreamAuthError(cliType);
        }
        return {
            event: "relay_response",
            request_id,
            content: "",
            error: errMsg || "Unknown execution error",
        };
    }
}
// ── Preflight helpers ──
// Map a cli_type string to its preflight function. Returns null for
// unknown types so the caller can skip them gracefully instead of
// crashing the daemon.
function getPreflightFn(cliType) {
    switch (cliType) {
        case "claude":
            return preflightClaudeApi;
        case "codex":
            return preflightCodexApi;
        case "gemini":
            return preflightGeminiApi;
        case "antigravity":
            return preflightAntigravityApi;
        default:
            return null;
    }
}
// Query the Hub for the full set of cli_types the current agent has
// registered as relay providers. Used by the multi-cli daemon to decide
// which upstream preflights to run. Returns null on any network / auth
// failure — caller falls back to single-cli mode.
async function fetchRegisteredCliTypes(config) {
    try {
        const resp = await apiGet("/api/v1/relay/providers/me", config.api_key);
        if (!resp.ok || !Array.isArray(resp.data)) {
            return null;
        }
        const seen = new Set();
        for (const p of resp.data) {
            if (typeof p.cli_type === "string" && p.cli_type)
                seen.add(p.cli_type);
        }
        return Array.from(seen);
    }
    catch {
        return null;
    }
}
// ── Main daemon entry point ──
export function runRelayProvider(cliOverride) {
    // Check for existing process
    const existingPid = readRelayPid();
    if (existingPid && isRelayPidAlive(existingPid)) {
        logger.error(`Relay Provider is already running (PID ${existingPid}). Use "relay stop" first.`);
        process.exit(1);
    }
    const config = loadRelayConfig(cliOverride);
    // Make the config-level proxy visible to every upstream module that reads
    // process.env.HTTPS_PROXY / http_proxy at init time. Must run BEFORE any
    // preflight call so the first outbound request already goes through it.
    applyProxyFromConfig(config);
    // Validate OAuth tokens + fingerprints up front so we fail fast on the
    // happy path instead of on the first inbound request.
    //
    // Two modes:
    //
    // 1. Single-cli legacy mode — `--cli X` passed explicitly. Run only
    //    that one preflight and fail-fast on error (preserves the old
    //    behavior when the user knows exactly what they're starting).
    //
    // 2. Multi-cli auto mode — no `--cli` override. Query the Hub for the
    //    full list of registered providers, collect their distinct
    //    cli_types, and run each preflight in parallel. Per-cli failures
    //    are tolerated (logged as a warning) so a broken codex OAuth
    //    doesn't take down the claude half of the daemon.
    //
    // The Hub already dispatches requests by agent_id and stamps each
    // relay_request with its target `cli_type` — provider.ts's request
    // handler (`executeRelayRequest`) routes to the right upstream module
    // based on that field. So from the Hub's point of view, a daemon that
    // has preflighted multiple cli_types is just "a more capable provider".
    if (cliOverride) {
        // Legacy single-cli path.
        const preflightFn = getPreflightFn(cliOverride);
        if (preflightFn) {
            preflightFn(config.relay.rate_guard).catch((err) => {
                logger.error(`${cliOverride} API preflight failed: ${err.message}`);
                process.exit(1);
            });
        }
    }
    else {
        // Multi-cli auto mode — fire-and-forget, don't block startup on the
        // HTTP round-trip. The WS connection can come up in parallel; the
        // preflights only gate the FIRST call of each family, not the WS
        // handshake.
        (async () => {
            const registered = await fetchRegisteredCliTypes(config);
            if (!registered || registered.length === 0) {
                logger.warn("Could not determine registered cli_types from Hub. " +
                    "Falling back to config cli_type for preflight.");
                const fallback = config.relay.cli_type;
                const fn = getPreflightFn(fallback);
                if (fn) {
                    try {
                        await fn(config.relay.rate_guard);
                    }
                    catch (err) {
                        logger.warn(`${fallback} preflight failed: ${err.message}`);
                    }
                }
                return;
            }
            logger.info(`Preflighting ${registered.length} registered cli_type(s): ${registered.join(", ")}`);
            await Promise.all(registered.map(async (ct) => {
                const fn = getPreflightFn(ct);
                if (!fn) {
                    logger.warn(`Unknown cli_type ${ct} — skipping preflight`);
                    return;
                }
                try {
                    await fn(config.relay.rate_guard);
                    logger.info(`  ${ct} preflight OK`);
                }
                catch (err) {
                    logger.warn(`  ${ct} preflight failed: ${err.message} — ` +
                        `that family will NOT be able to serve requests until fixed`);
                }
            }));
        })().catch((err) => {
            logger.warn(`Multi-cli preflight driver error: ${err.message}`);
        });
    }
    const activeTasks = new Set();
    async function syncModelCatalog() {
        try {
            // Step 1: existing providers (gives us cli_types + default settings).
            const myResp = await apiGet("/api/v1/relay/providers/me", config.api_key);
            if (!myResp.ok || !Array.isArray(myResp.data)) {
                logger.warn(`[catalog-sync] skipped: /providers/me returned ${myResp.status}`);
                return;
            }
            const existing = myResp.data;
            if (existing.length === 0) {
                logger.info("[catalog-sync] no existing providers yet — skipping auto-sync");
                return;
            }
            // Settings template per cli_type (from any existing provider in that family).
            const settingsByCli = new Map();
            const knownModels = new Set();
            for (const p of existing) {
                knownModels.add(`${p.cli_type}/${p.model}`);
                if (!settingsByCli.has(p.cli_type)) {
                    settingsByCli.set(p.cli_type, {
                        concurrency: p.concurrency,
                        daily_limit_usd: p.daily_limit_usd,
                    });
                }
            }
            // Step 2: fetch catalog.
            const catalogResp = await apiGet("/api/v1/relay/model-catalog");
            if (!catalogResp.ok || !catalogResp.data?.catalog) {
                logger.warn(`[catalog-sync] skipped: /model-catalog returned ${catalogResp.status}`);
                return;
            }
            const catalog = catalogResp.data.catalog;
            // Step 3: build batch for cli_types the agent has at least one provider for.
            const batch = [];
            const newModels = [];
            for (const [cliType, settings] of settingsByCli) {
                const recommended = catalog[cliType] ?? [];
                for (const entry of recommended) {
                    if (!knownModels.has(`${cliType}/${entry.model}`)) {
                        newModels.push(`${cliType}/${entry.model}`);
                    }
                    batch.push({
                        cli_type: cliType,
                        model: entry.model,
                        mode: "chat",
                        concurrency: settings.concurrency,
                        daily_limit_usd: settings.daily_limit_usd,
                        price_input_per_m: entry.input,
                        price_output_per_m: entry.output,
                    });
                }
            }
            if (batch.length === 0) {
                return;
            }
            // Step 4: upsert via batch register (already idempotent).
            const regResp = await apiPost("/api/v1/relay/providers/batch", { providers: batch }, config.api_key);
            if (!regResp.ok) {
                logger.warn(`[catalog-sync] batch register failed: ${regResp.status}`);
                return;
            }
            const created = regResp.data.created?.length ?? 0;
            const failed = regResp.data.failed?.length ?? 0;
            if (newModels.length > 0 || created > 0) {
                logger.info(`[catalog-sync] OK: ${batch.length} entries, ${created} newly created, ${failed} failed` +
                    (newModels.length > 0 ? ` (new: ${newModels.join(", ")})` : ""));
            }
            else {
                logger.info(`[catalog-sync] OK: ${batch.length} entries, no changes`);
            }
        }
        catch (err) {
            logger.warn(`[catalog-sync] error: ${err.message}`);
        }
    }
    // Initial sync, then every 30 min.
    syncModelCatalog().catch((err) => logger.warn(`[catalog-sync] initial sync failed: ${err.message}`));
    const catalogTimer = setInterval(() => syncModelCatalog().catch((err) => logger.warn(`[catalog-sync] periodic sync failed: ${err.message}`)), 30 * 60 * 1000);
    catalogTimer.unref();
    // Create WS client
    const wsClient = new RelayWsClient(config, (event) => {
        handleEvent(event);
    });
    // Event router
    function handleEvent(event) {
        switch (event.event) {
            case "connected":
                logger.info(`Connected as "${event.agent_name}" (id=${event.agent_id}, provider=${event.provider_id})`);
                break;
            case "relay_request":
                handleRelayRequest(event);
                break;
            case "error":
                logger.error(`Server error: ${event.message}`);
                break;
            case "relay_notice":
                // Loud WARN for the human operator. Quarantine notices are the
                // most important kind — they mean buyers are going to stop
                // seeing this provider until the daemon is restarted, so we
                // don't want them buried in the log.
                logger.warn(`[NOTICE ${event.notice_type}] ${event.message}`);
                if (event.notice_type === "model_mismatch_quarantine" &&
                    event.expected_model &&
                    event.got_model) {
                    logger.warn(`  expected=${event.expected_model}  got=${event.got_model}  cli=${event.cli_type ?? "?"}`);
                }
                break;
            default:
                logger.warn("Unknown event:", event);
        }
    }
    function handleRelayRequest(request) {
        if (activeTasks.size >= config.relay.concurrency) {
            logger.warn(`Rejecting request ${request.request_id}: at max concurrency (${config.relay.concurrency})`);
            wsClient.send({
                event: "relay_response",
                request_id: request.request_id,
                content: "",
                error: "Provider is at maximum capacity. Please try again later.",
            });
            return;
        }
        activeTasks.add(request.request_id);
        logger.info(`Processing relay request=${request.request_id} (active=${activeTasks.size}/${config.relay.concurrency})`);
        // Per-request SSE chunk forwarder. Each raw Anthropic SSE frame is sent
        // to the Hub as its own WS event so the Hub can relay it straight to the
        // buyer — drops TTFT from "whole response" to "first-token-from-upstream".
        // WS sends are fire-and-forget here; the final relay_response still
        // carries the fully aggregated content as a fallback for Hubs that
        // haven't wired up chunk forwarding yet.
        const sendChunk = (sse) => {
            wsClient.send({
                event: "relay_stream_chunk",
                request_id: request.request_id,
                sse,
            });
        };
        executeRelayRequest(request, config, sendChunk)
            .then((response) => {
            const sent = wsClient.send(response);
            if (sent) {
                logger.info(`Delivered relay response for request=${request.request_id}`);
            }
            else {
                logger.warn(`Failed to send relay response for ${request.request_id} (WS disconnected)`);
            }
        })
            .catch((err) => {
            logger.error(`Unhandled error for relay request ${request.request_id}:`, err);
        })
            .finally(() => {
            activeTasks.delete(request.request_id);
        });
    }
    // Graceful shutdown
    let shuttingDown = false;
    function shutdown(signal) {
        if (shuttingDown)
            return;
        shuttingDown = true;
        logger.info(`Received ${signal}. Shutting down...`);
        wsClient.stop();
        removeRelayPid();
        logger.info("Relay Provider stopped.");
        process.exit(0);
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    // Write PID and start
    writeRelayPid();
    wsClient.start();
    logger.info("Relay Provider running. Listening for relay requests...");
    if (cliOverride) {
        logger.info(`Config: cli=${cliOverride} (single), mode=${config.relay.mode}, concurrency=${config.relay.concurrency}`);
    }
    else {
        logger.info(`Config: cli=auto (multi), mode=${config.relay.mode}, concurrency=${config.relay.concurrency}`);
    }
}
