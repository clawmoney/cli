import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { RelayWsClient } from "./ws-client.js";
import { callClaudeApi, preflightClaudeApi, getRateGuardSnapshot as getClaudeRateGuardSnapshot, } from "./upstream/claude-api.js";
import { callCodexApi, preflightCodexApi, getRateGuardSnapshot as getCodexRateGuardSnapshot, } from "./upstream/codex-api.js";
import { callGeminiApi, preflightGeminiApi, getGeminiRateGuardSnapshot, } from "./upstream/gemini-api.js";
import { callAntigravityApi, preflightAntigravityApi, getAntigravityRateGuardSnapshot, } from "./upstream/antigravity-api.js";
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
    ws_url: "wss://api.bnbot.ai/api/v1/ws/relay",
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
    try {
        const startMs = Date.now();
        let parsed;
        // Direct upstream API call — the right handler is picked by cli_type
        // (claude → Anthropic, codex → chatgpt.com WS, gemini → cloudcode-pa,
        // antigravity → daily-cloudcode-pa). Each handler has its own
        // fingerprint file and rate-guard instance.
        if (cliType === "codex") {
            parsed = await callCodexApi({
                prompt,
                model,
                maxTokens: max_budget_usd ? undefined : 4096,
            });
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
            parsed = await callClaudeApi({
                prompt,
                model,
                maxTokens: max_budget_usd ? undefined : 4096,
                // Forward each raw Anthropic SSE frame to the Hub in real time
                // so the end client sees tokens as they're generated (instead of
                // waiting for the whole response to arrive). Only claude-api has
                // true pass-through streaming today — codex/gemini/antigravity
                // still buffer the full response upstream and emit a single frame.
                onRawEvent: sendChunk,
            });
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
        return {
            event: "relay_response",
            request_id,
            content: parsed.text,
            cli_session_id: parsed.sessionId || undefined,
            usage: parsed.usage,
            model_used: parsed.model || model,
            cost_usd: parsed.costUsd || undefined,
            session_window: sessionWindowTelemetry,
        };
    }
    catch (err) {
        logger.error(`  └─ ERROR: ${err instanceof Error ? err.message : err}`);
        return {
            event: "relay_response",
            request_id,
            content: "",
            error: err instanceof Error ? err.message : "Unknown execution error",
        };
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
    // Validate the OAuth token + fingerprint up-front so we fail fast instead
    // of on the first inbound request. Each cli_type has its own preflight
    // path (different credential file, different fingerprint schema, different
    // rate-guard instance).
    const preflightFn = config.relay.cli_type === "codex"
        ? preflightCodexApi
        : config.relay.cli_type === "gemini"
            ? preflightGeminiApi
            : config.relay.cli_type === "claude"
                ? preflightClaudeApi
                : config.relay.cli_type === "antigravity"
                    ? preflightAntigravityApi
                    : null;
    if (preflightFn) {
        preflightFn(config.relay.rate_guard).catch((err) => {
            logger.error(`${config.relay.cli_type} API preflight failed: ${err.message}`);
            process.exit(1);
        });
    }
    const activeTasks = new Set();
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
    logger.info(`Config: cli=${config.relay.cli_type}, model=${config.relay.model}, mode=${config.relay.mode}, concurrency=${config.relay.concurrency}`);
}
