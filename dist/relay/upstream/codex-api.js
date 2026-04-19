/**
 * Direct chatgpt.com upstream for Codex (ChatGPT Plus/Pro) OAuth subscriptions.
 *
 * Mirrors claude-api.ts structure exactly: same export shape, same error types,
 * same RateGuard integration, same OAuth refresh + persist-back pattern, same
 * fingerprint file loading, same 5xx retry path, same preflight function.
 *
 * IMPORTANT — wire format: codex-cli 0.118+ migrated from HTTP POST+SSE to a
 * WebSocket-based Responses API. The endpoint is accessed as
 *   wss://chatgpt.com/backend-api/codex/responses
 * with the handshake headers shown below, and after the upgrade the client
 * sends a single `{type:"response.create", ...}` JSON frame. The server
 * replies with a stream of JSON frames that mirror the old SSE event names
 * (`response.created`, `response.output_text.delta`, `response.completed`,
 * `response.failed`, `response.error`, etc.). We accumulate text deltas +
 * the terminal event, close cleanly, and return ParsedOutput — exactly the
 * same contract the caller sees for HTTP Claude.
 *
 * Key differences from claude-api.ts:
 *  - Token source: ~/.codex/auth.json (written by the Codex CLI)
 *  - Upstream transport: WebSocket to chatgpt.com/backend-api/codex/responses
 *  - Handshake header `openai-beta: responses_websockets=2026-02-06`
 *  - Handshake header `version: <codex cli version>`
 *  - Handshake header `chatgpt-account-id` from ~/.codex/auth.json tokens.account_id
 *  - First frame is a JSON `response.create` — request body is OpenAI Responses
 *    API shape (input[], instructions, model, store, stream) with `type` added
 *  - Session headers: session_id + conversation_id (not x-claude-code-session-id)
 *  - Rate-limit headers surface on the upgrade response or via `rate_limits` /
 *    `response.failed` frames — we parse both
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import { URL } from "node:url";
import WebSocket from "ws";
import { ProxyAgent as UndiciProxyAgent, setGlobalDispatcher } from "undici";
import { relayLogger as logger } from "../logger.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError, } from "./rate-guard.js";
import { calculateCost } from "../pricing.js";
import { readOpenclawOAuthProfile, persistOpenclawOAuthProfile, } from "./openclaw-creds.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
// ── Constants ──
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
// Same path as the old POST endpoint, just accessed via WebSocket upgrade.
// Capture confirmed: `GET /v1/responses HTTP/1.1` with `Host: chatgpt.com`
// + `Connection: Upgrade` hits the same backend route.
const CODEX_RESPONSES_WS_URL = "wss://chatgpt.com/backend-api/codex/responses";
const CODEX_AUTH_FILE = join(homedir(), ".codex", "auth.json");
const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_FILE = join(CLAWMONEY_DIR, "codex-fingerprint.json");
// Default fingerprint values. Overridden per-machine by the capture script.
const DEFAULT_CLI_VERSION = "0.118.0";
// Verified against codex-rs/login/src/auth/default_client.rs:34 —
// `pub const DEFAULT_ORIGINATOR: &str = "codex_cli_rs"`. A prior audit
// claimed this was "codex_exec" which was wrong; real Codex CLI sends
// `codex_cli_rs` on every /backend-api/codex/responses upgrade, and a
// different originator value is a direct fingerprint mismatch against
// OpenAI's allowlist of known first-party clients.
const DEFAULT_ORIGINATOR = "codex_cli_rs";
// Observed in the 0.118 capture: there is NO user-agent header. Leave empty
// by default; the fingerprint file may still override with a real value for
// older codex-cli that does send one.
const DEFAULT_USER_AGENT = "";
// openai-beta header value for the 0.118+ WebSocket protocol.
const OPENAI_BETA_WS_VALUE = "responses_websockets=2026-02-06";
const REFRESH_SKEW_MS = 3 * 60 * 1000;
// Matches claude-api.ts MASKED_SESSION_TTL_MS — 3 minutes with ±30s jitter
// to mimic human coding rhythm and avoid all providers rolling in lockstep.
const MASKED_SESSION_TTL_MS = 3 * 60 * 1000;
const MASKED_SESSION_JITTER_MS = 30 * 1000;
const MAX_TRANSIENT_RETRIES = 2;
// Per-call upper bound on how long we wait for a terminal WS frame.
// Codex responses on small prompts come back in <10s; we give a generous
// ceiling to tolerate slow tokens without hanging the daemon forever.
const WS_OVERALL_TIMEOUT_MS = 180 * 1000;
// Default instructions for Codex template mode. Template mode flattens
// messages into a single prompt and drops buyer's tools — the "plain
// text only" hint aligns model behavior with what template can actually
// deliver.
const RELAY_INSTRUCTIONS = "You are a helpful AI assistant operating in relay mode. Respond to the user's message with plain text only. Be concise.";
// Neutral fallback for Codex passthrough mode when the buyer did NOT
// supply their own instructions. Unlike the template-mode string, this
// one does NOT forbid tool use — if the buyer sent a tools array we
// want the model to use them. Kept intentionally vague so it doesn't
// bias the model's behavior when the buyer's intent is unspecified.
const CODEX_PASSTHROUGH_FALLBACK_INSTRUCTIONS = "You are a helpful coding assistant. Use the available tools when appropriate to answer the user.";
// ── Proxy ──
//
// We configure the global undici dispatcher for the OAuth refresh fetch()
// call (which uses node's undici-backed fetch), AND we store the proxy URL
// so the per-call WebSocket dial can install an https-proxy-agent on it.
let dispatcherConfigured = false;
let wsProxyUrl = null;
function configureDispatcher() {
    if (dispatcherConfigured)
        return;
    dispatcherConfigured = true;
    const url = process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy;
    if (!url)
        return;
    if (!/^https?:\/\//.test(url)) {
        logger.warn(`[codex-api] ignoring non-HTTP proxy ${url} (SOCKS not supported)`);
        return;
    }
    setGlobalDispatcher(new UndiciProxyAgent(url));
    wsProxyUrl = url;
    logger.info(`[codex-api] upstream proxy ${url}`);
}
// ── Fingerprint ──
let cachedFingerprint = null;
function loadCodexFingerprint() {
    if (cachedFingerprint)
        return cachedFingerprint;
    if (!existsSync(FINGERPRINT_FILE)) {
        logger.warn(`[codex-api] fingerprint not found at ${FINGERPRINT_FILE} — using defaults. ` +
            `Run \`node scripts/capture-codex-request.mjs\` then \`codex exec "hi"\` ` +
            `(with OPENAI_BASE_URL pointing at the capture proxy) to bootstrap.`);
        cachedFingerprint = {
            user_agent: DEFAULT_USER_AGENT,
            cli_version: DEFAULT_CLI_VERSION,
            originator: DEFAULT_ORIGINATOR,
            openai_beta: OPENAI_BETA_WS_VALUE,
            installation_id: randomUUID(),
        };
        return cachedFingerprint;
    }
    const raw = JSON.parse(readFileSync(FINGERPRINT_FILE, "utf-8"));
    // Persist a per-daemon installation UUID the first time we see this
    // fingerprint — the value must be stable across daemon restarts (real
    // CLI generates it once on install) so we write it back when minted.
    let installationId = raw.installation_id;
    if (!installationId) {
        installationId = randomUUID();
        try {
            writeFileSync(FINGERPRINT_FILE, JSON.stringify({ ...raw, installation_id: installationId }, null, 2), { encoding: "utf-8", mode: 0o600 });
            logger.info("[codex-api] persisted new installation_id to fingerprint file");
        }
        catch (err) {
            logger.warn(`[codex-api] could not persist installation_id: ${err.message}`);
        }
    }
    cachedFingerprint = {
        user_agent: raw.user_agent ?? DEFAULT_USER_AGENT,
        cli_version: raw.cli_version ?? DEFAULT_CLI_VERSION,
        originator: raw.originator ?? DEFAULT_ORIGINATOR,
        openai_beta: raw.openai_beta ?? OPENAI_BETA_WS_VALUE,
        installation_id: installationId,
    };
    logger.info(`[codex-api] fingerprint loaded (version=${cachedFingerprint.cli_version}, originator=${cachedFingerprint.originator}, openai-beta=${cachedFingerprint.openai_beta})`);
    return cachedFingerprint;
}
// ── JWT exp decode ──
//
// Codex auth.json has no explicit expiresAt field — expiry is embedded in
// the access_token JWT. We decode the payload (no signature validation;
// we only need the exp timestamp for cache invalidation). Falls back to
// Date.now() + 1h if decoding fails so we don't refuse to serve.
function decodeJwtExp(jwt) {
    try {
        const parts = jwt.split(".");
        if (parts.length !== 3)
            return Date.now() + 3600 * 1000;
        const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = payload + "==".slice((payload.length + 3) % 4);
        const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
        if (typeof decoded.exp === "number" && decoded.exp > 0) {
            return decoded.exp * 1000;
        }
    }
    catch {
        // fall through
    }
    return Date.now() + 3600 * 1000;
}
// ── Credential I/O ──
function loadCodexAuth() {
    // Prefer ~/.codex/auth.json when present — that's the canonical Codex CLI
    // location and refresh behavior has been field-tested against it longest.
    if (existsSync(CODEX_AUTH_FILE)) {
        const raw = JSON.parse(readFileSync(CODEX_AUTH_FILE, "utf-8"));
        const tok = raw?.tokens;
        if (!tok?.access_token || !tok?.refresh_token || !tok?.account_id) {
            throw new Error(`Codex auth.json missing required fields (tokens.access_token / tokens.refresh_token / tokens.account_id)`);
        }
        return {
            source: "codex-file",
            accessToken: tok.access_token,
            refreshToken: tok.refresh_token,
            accountId: tok.account_id,
            expiresAt: decodeJwtExp(tok.access_token),
            _rawFile: raw,
        };
    }
    // Fallback: openclaw's auth-profiles.json. Providers who onboarded with
    // `openclaw onboard` + Codex subscription have their token here instead.
    const openclawProfile = readOpenclawOAuthProfile("openai-codex");
    if (openclawProfile) {
        if (!openclawProfile.accountId) {
            throw new Error(`OpenClaw openai-codex profile at ${openclawProfile.storePath} is missing accountId; re-run \`openclaw onboard\`.`);
        }
        logger.info(`[codex-api] using OpenClaw credential fallback (profile=${openclawProfile.profileKey}, store=${openclawProfile.storePath})`);
        return {
            source: "openclaw",
            accessToken: openclawProfile.access,
            refreshToken: openclawProfile.refresh,
            accountId: openclawProfile.accountId,
            expiresAt: openclawProfile.expires,
            _openclawProfile: openclawProfile,
        };
    }
    throw new Error(`Codex auth not found at ${CODEX_AUTH_FILE} and no openai-codex OAuth profile in ~/.openclaw/agents/. ` +
        `Log in with \`codex login\` or \`openclaw onboard\` first.`);
}
function writeCodexAuth(file) {
    writeFileSync(CODEX_AUTH_FILE, JSON.stringify(file, null, 2), "utf-8");
}
async function refreshUpstreamToken(refreshToken) {
    // OpenAI refresh uses form-encoded body (see sub2api openai/pkg/oauth.go).
    // Scope: "openid profile email" (drops offline_access on refresh).
    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: "openid profile email",
    });
    const resp = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
            "accept": "application/json",
            "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Codex token refresh failed: ${resp.status} ${text.slice(0, 300)}`);
    }
    const data = (await resp.json());
    const newAt = data.access_token;
    return {
        accessToken: newAt,
        refreshToken: data.refresh_token ?? refreshToken,
        expiresAt: data.expires_in
            ? Date.now() + data.expires_in * 1000
            : decodeJwtExp(newAt),
    };
}
// ── Token cache ──
let cachedCreds = null;
let refreshInflight = null;
async function doRefreshAndPersist(current) {
    logger.info(`[codex-api] refreshing OAuth token (source=${current.source})...`);
    const fresh = await refreshUpstreamToken(current.refreshToken);
    // Persist FIRST, then advance in-memory state. If the on-disk write fails
    // we keep serving on the old token — OpenAI/ChatGPT would see two valid
    // access tokens in flight for the same account and mark it as hijacked
    // otherwise.
    if (current.source === "codex-file") {
        const updatedFile = {
            ...current._rawFile,
            last_refresh: new Date().toISOString(),
            tokens: {
                ...current._rawFile.tokens,
                access_token: fresh.accessToken,
                refresh_token: fresh.refreshToken,
            },
        };
        try {
            writeCodexAuth(updatedFile);
            logger.info("[codex-api] ~/.codex/auth.json updated");
        }
        catch (err) {
            logger.error(`[codex-api] CRITICAL: persist failed — keeping old token to avoid account-hijack detection signal: ${err.message}`);
            return current;
        }
        return {
            source: "codex-file",
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            accountId: current.accountId,
            expiresAt: fresh.expiresAt,
            _rawFile: updatedFile,
        };
    }
    // openclaw path: write refreshed triple back into the same auth-profiles.json
    // profile we read from, so openclaw's own runtime stays in sync.
    try {
        persistOpenclawOAuthProfile(current._openclawProfile, {
            access: fresh.accessToken,
            refresh: fresh.refreshToken,
            expires: fresh.expiresAt,
            accountId: current.accountId,
        });
        logger.info(`[codex-api] OpenClaw profile ${current._openclawProfile.profileKey} updated (${current._openclawProfile.storePath})`);
    }
    catch (err) {
        logger.error(`[codex-api] CRITICAL: openclaw persist failed — keeping old token to avoid account-hijack detection signal: ${err.message}`);
        return current;
    }
    return {
        source: "openclaw",
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        accountId: current.accountId,
        expiresAt: fresh.expiresAt,
        _openclawProfile: {
            ...current._openclawProfile,
            access: fresh.accessToken,
            refresh: fresh.refreshToken,
            expires: fresh.expiresAt,
        },
    };
}
async function getFreshCreds() {
    if (!cachedCreds) {
        cachedCreds = loadCodexAuth();
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
// ── Masked session id (3-minute sliding window, jittered) ──
// See the claude-api.ts copy of this block for the full rationale — real
// Codex reuses the same id across consecutive requests in a conversation;
// rolling one per request screams bot. Kept in sync with claude's TTL.
let maskedSessionId = null;
let maskedSessionExpiresAt = 0;
function getMaskedSessionId() {
    const now = Date.now();
    if (maskedSessionId && now < maskedSessionExpiresAt) {
        return maskedSessionId;
    }
    maskedSessionId = randomUUID();
    const jitter = Math.floor((Math.random() * 2 - 1) * MASKED_SESSION_JITTER_MS);
    maskedSessionExpiresAt = now + MASKED_SESSION_TTL_MS + jitter;
    logger.info(`[codex-api] new masked session_id ${maskedSessionId.slice(0, 8)}... ` +
        `(window=${Math.round((MASKED_SESSION_TTL_MS + jitter) / 1000)}s)`);
    return maskedSessionId;
}
// ── Rate-limit cooldown parsing ──
//
// Rate-limit state comes from two places on the new WS protocol:
//   1. The upgrade-phase HTTP response headers (on 4xx/5xx responses to the
//      GET + Upgrade request), where Codex still surfaces
//        x-codex-primary-used-percent / x-codex-primary-reset-after-seconds
//        x-codex-secondary-used-percent / x-codex-secondary-reset-after-seconds
//   2. Inline `rate_limits` / `response.failed` JSON frames over the socket
//      itself, which contain the same `reset_after_seconds` fields nested
//      under `rate_limits.primary.reset_after_seconds`.
function cooldownFromHttpHeaders(headers) {
    function getNumericHeader(name) {
        const v = headers[name] ?? headers[name.toLowerCase()];
        const str = Array.isArray(v) ? v[0] : v;
        if (str == null)
            return null;
        const secs = Number(str);
        if (!Number.isFinite(secs) || secs <= 0)
            return null;
        return Date.now() + secs * 1000;
    }
    const primary = getNumericHeader("x-codex-primary-reset-after-seconds");
    const secondary = getNumericHeader("x-codex-secondary-reset-after-seconds");
    const retryAfterRaw = (headers["retry-after"] ?? headers["Retry-After"]);
    let retryAfterMs = null;
    if (typeof retryAfterRaw === "string") {
        const s = Number(retryAfterRaw);
        retryAfterMs = Number.isFinite(s) && s >= 0 ? Date.now() + s * 1000 : null;
    }
    const candidates = [];
    if (primary)
        candidates.push({ ms: primary, reason: "codex primary window" });
    if (secondary)
        candidates.push({ ms: secondary, reason: "codex secondary window" });
    if (retryAfterMs)
        candidates.push({ ms: retryAfterMs, reason: "retry-after" });
    if (candidates.length === 0)
        return null;
    candidates.sort((a, b) => a.ms - b.ms);
    return candidates[0];
}
function cooldownFromRateLimitsFrame(evt) {
    const rl = evt["rate_limits"];
    if (!rl)
        return null;
    const candidates = [];
    for (const key of ["primary", "secondary"]) {
        const bucket = rl[key];
        if (!bucket)
            continue;
        const secs = Number(bucket["reset_after_seconds"] ?? 0);
        if (Number.isFinite(secs) && secs > 0) {
            candidates.push({ ms: Date.now() + secs * 1000, reason: `codex ${key} window` });
        }
    }
    if (candidates.length === 0)
        return null;
    candidates.sort((a, b) => a.ms - b.ms);
    return candidates[0];
}
// ── Rate guard ──
let rateGuard = null;
export function configureRateGuard(config) {
    const mapped = config
        ? {
            maxConcurrency: config.max_concurrency,
            quietHoursMaxConcurrency: config.quiet_hours_max_concurrency,
            quietHours: config.quiet_hours,
            minRequestGapMs: config.min_request_gap_ms,
            jitterMs: config.jitter_ms,
            dailyBudgetUsd: config.daily_budget_usd,
            maxRelayUtilization: config.max_relay_utilization,
        }
        : {};
    const cleaned = Object.fromEntries(Object.entries(mapped).filter(([, v]) => v !== undefined));
    rateGuard = new RateGuard(cleaned);
    const cfg = rateGuard.cfg;
    logger.info(`[codex-api] rate-guard active (concurrency_active=${cfg.maxConcurrency}, quiet=${cfg.quietHoursMaxConcurrency}, daily_budget=$${cfg.dailyBudgetUsd})`);
}
export function getRateGuardSnapshot() {
    return rateGuard?.currentLoad() ?? null;
}
export async function preflightCodexApi(config) {
    configureDispatcher();
    configureRateGuard(config);
    // Load fingerprint (warns but does not throw if absent — defaults apply).
    loadCodexFingerprint();
    // Load & decode creds, refreshing if near expiry.
    await getFreshCreds();
    // Ensure the `ws` package is actually resolvable so we fail fast at
    // preflight instead of on the first relay request.
    if (typeof WebSocket !== "function") {
        throw new Error("ws package failed to load — cannot open Codex WebSocket upstream");
    }
    logger.info(`[codex-api] preflight OK (account_id=${cachedCreds?.accountId ? "set" : "missing"}, expires_in=${Math.max(0, Math.round(((cachedCreds?.expiresAt ?? 0) - Date.now()) / 1000))}s)`);
}
// ── Request body builder ──
//
// Over WebSocket, codex-cli sends a single JSON frame that serializes
// `ResponseCreateWsRequest` (codex-rs/codex-api/src/common.rs:200-225).
// The struct has SIX required fields that we were previously omitting —
// OpenAI's backend appears to tolerate missing defaults, but leaving
// them out makes the wire shape distinct from a real CLI client, which
// is exactly the fingerprint the account-detection pipeline watches for.
//
// Required (per real CLI schema):
//   model, instructions, input, tools, tool_choice, parallel_tool_calls,
//   reasoning (optional but almost always present via default_reasoning_level),
//   store, stream, include, client_metadata (with installation_id + window_id +
//   turn_metadata)
function buildCodexRequestFrame(prompt, model, fingerprint, sessionId, turnMetadataHeader, windowGeneration, warmup) {
    // `client_metadata` is a flat string-to-string map. Real CLI populates
    // it via build_ws_client_metadata() (client.rs:575-605). The keys look
    // like HTTP header names but they're JSON fields.
    const clientMetadata = {
        "x-codex-installation-id": fingerprint.installation_id,
        "x-codex-window-id": `${sessionId}:${windowGeneration}`,
        "x-codex-turn-metadata": turnMetadataHeader,
    };
    const frame = {
        type: "response.create",
        model,
        instructions: RELAY_INSTRUCTIONS,
        input: [
            {
                type: "message",
                role: "user",
                content: prompt,
            },
        ],
        // Real CLI sends tools: [] when no MCP/local tools are configured.
        // Absent != [] on the wire, so we always emit the empty array.
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        // Reasoning is server-side for most models; real CLI sends
        // {effort: "medium"} by default when `supports_reasoning_summaries`
        // (virtually all gpt-5.x+). Passing medium is the safest default.
        reasoning: { effort: "medium", summary: "auto" },
        // OAuth → ChatGPT internal API requires store=false.
        store: false,
        // Internal endpoint always streams — mirrors Codex CLI.
        stream: true,
        // Real CLI sends include: ["reasoning.encrypted_content"] when
        // reasoning is set; otherwise []. We set reasoning, so include it.
        include: ["reasoning.encrypted_content"],
        client_metadata: clientMetadata,
    };
    if (warmup) {
        // Real CLI's prewarm flow sets `generate: false` on the first frame
        // of each turn (codex-rs/core/src/client.rs:1283-1285). The server
        // replies with a response.completed event but does NOT generate
        // tokens, so the warmup is cheap. The real frame then follows on
        // the SAME WebSocket session.
        frame.generate = false;
    }
    return frame;
}
// Patch a raw ChatGPT WS frame before we forward it to the Hub as SSE.
// ChatGPT's internal response.completed frames come from a proprietary
// backend that does NOT populate usage.total_tokens — the Codex CLI Rust
// parser is strict about this field (stream disconnected before completion:
// failed to parse ResponseCompleted: missing field `total_tokens`), so we
// inject it here when we can compute it from input_tokens + output_tokens.
// Returns the possibly-rewritten frame JSON; on parse/shape error returns
// the original untouched so a malformed input never turns into a crash.
function patchCodexFrameForForwarding(raw) {
    try {
        const evt = JSON.parse(raw);
        const type = evt["type"];
        if (type !== "response.completed" && type !== "response.done") {
            return raw;
        }
        const resp = evt["response"];
        if (!resp || typeof resp !== "object")
            return raw;
        const usage = resp["usage"];
        if (!usage || typeof usage !== "object")
            return raw;
        if (typeof usage["total_tokens"] === "number")
            return raw;
        const input = Number(usage["input_tokens"] ?? 0);
        const output = Number(usage["output_tokens"] ?? 0);
        usage["total_tokens"] = input + output;
        // Also ensure the nested *_details objects exist — Codex CLI's
        // schema checks for them on the response.completed frame.
        if (!usage["input_tokens_details"] || typeof usage["input_tokens_details"] !== "object") {
            const cached = Number(usage.cache_read_input_tokens ?? 0);
            usage["input_tokens_details"] = { cached_tokens: cached };
        }
        if (!usage["output_tokens_details"] || typeof usage["output_tokens_details"] !== "object") {
            usage["output_tokens_details"] = { reasoning_tokens: 0 };
        }
        return JSON.stringify(evt);
    }
    catch {
        return raw;
    }
}
function handleFrame(raw, acc) {
    let evt;
    try {
        evt = JSON.parse(raw);
    }
    catch {
        return { terminal: false };
    }
    const type = typeof evt["type"] === "string" ? evt["type"] : "";
    // Text deltas — identical to the HTTP SSE format, just one JSON per frame.
    if (type === "response.output_text.delta") {
        const delta = evt["delta"];
        if (typeof delta === "string")
            acc.text += delta;
        return { terminal: false };
    }
    // Standalone rate-limits frame (seen in sub2api captures). Does NOT end
    // the turn, but we harvest the cooldown window for later use.
    if (type === "rate_limits") {
        const cd = cooldownFromRateLimitsFrame(evt);
        return { terminal: false, rateLimit: cd ?? undefined };
    }
    // Error frame — surfaces 400-class issues and upstream policy rejections.
    if (type === "response.failed" || type === "response.error" || type === "error") {
        const errObj = (evt["error"] ?? evt["response"]);
        const msg = (errObj && typeof errObj["message"] === "string" && errObj["message"]) ||
            (typeof evt["message"] === "string" && evt["message"]) ||
            "unknown codex ws error";
        const cd = cooldownFromRateLimitsFrame(evt);
        return { terminal: true, error: msg, rateLimit: cd ?? undefined };
    }
    if (type === "response.completed" || type === "response.done") {
        const resp = evt["response"];
        if (resp) {
            if (typeof resp["model"] === "string")
                acc.model = resp["model"];
            const usage = resp["usage"];
            if (usage) {
                acc.inputTokens = Number(usage["input_tokens"] ?? 0);
                acc.outputTokens = Number(usage["output_tokens"] ?? 0);
                const details = usage["input_tokens_details"];
                if (details) {
                    acc.cacheReadTokens = Number(details["cached_tokens"] ?? 0);
                }
            }
            // Prefer the complete output[] text if present — it's the authoritative
            // final form; delta accumulation is a fallback.
            const output = resp["output"];
            if (Array.isArray(output) && output.length > 0) {
                const parts = [];
                for (const item of output) {
                    const content = item["content"];
                    if (!Array.isArray(content))
                        continue;
                    for (const part of content) {
                        if (part["type"] === "output_text" && typeof part["text"] === "string") {
                            parts.push(part["text"]);
                        }
                    }
                }
                if (parts.length > 0)
                    acc.text = parts.join("");
            }
        }
        return { terminal: true };
    }
    return { terminal: false };
}
class WsDialError extends Error {
    statusCode;
    headers;
    bodySnippet;
    constructor(status, headers, bodySnippet) {
        super(`Codex WS upgrade failed: HTTP ${status} — ${bodySnippet.slice(0, 200)}`);
        this.name = "WsDialError";
        this.statusCode = status;
        this.headers = headers;
        this.bodySnippet = bodySnippet;
    }
}
// Minimal HTTP-CONNECT tunneling Agent for HTTPS/WSS targets.
//
// When the Provider is behind an HTTP proxy (e.g. `export HTTPS_PROXY=
// http://127.0.0.1:7890`), Node's built-in https.Agent does not support
// CONNECT tunneling out of the box. We avoid adding a third-party proxy
// agent dep by inlining the ~15 lines of glue needed: open a plain TCP
// socket to the proxy, send a CONNECT line, wait for `200 Connection
// Established`, then hand the raw socket back to the caller wrapped in
// a TLS session targeting the origin host.
//
// The `ws` package accepts anything that quacks like an http.Agent with a
// `createConnection(opts, cb)` method. We subclass https.Agent and override
// createConnection, but the TS declarations for `Agent.createConnection`
// point at a Duplex-returning signature that doesn't quite match our
// socket-returning one, so we cast through `unknown` where required.
class HttpsConnectAgent extends https.Agent {
    proxyHost;
    proxyPort;
    constructor(proxyUrl) {
        super({ keepAlive: false });
        const parsed = new URL(proxyUrl);
        this.proxyHost = parsed.hostname;
        this.proxyPort = Number(parsed.port) || 80;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createConnection(opts, callback) {
        const targetHost = opts.host || "";
        const targetPort = Number(opts.port) || 443;
        const tcp = net.connect(this.proxyPort, this.proxyHost, () => {
            tcp.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
        });
        let buf = "";
        const onData = (chunk) => {
            buf += chunk.toString("utf-8");
            const headerEnd = buf.indexOf("\r\n\r\n");
            if (headerEnd === -1)
                return;
            tcp.off("data", onData);
            const statusLine = buf.split("\r\n", 1)[0] ?? "";
            const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
            const code = m ? Number(m[1]) : 0;
            if (code !== 200) {
                tcp.destroy();
                callback(new Error(`proxy CONNECT failed: ${statusLine}`));
                return;
            }
            // Success — upgrade the tunneled TCP socket to TLS.
            const secured = tls.connect({
                socket: tcp,
                servername: targetHost,
                host: targetHost,
                port: targetPort,
            });
            secured.on("error", (err) => callback(err));
            secured.on("secureConnect", () => callback(null, secured));
        };
        tcp.on("data", onData);
        tcp.on("error", (err) => callback(err));
        return undefined;
    }
}
function dialCodexWebSocket(headers) {
    return new Promise((resolve, reject) => {
        let agent;
        if (wsProxyUrl) {
            agent = new HttpsConnectAgent(wsProxyUrl);
        }
        // ws honors permessage-deflate out of the box when the server offers it,
        // which matches the "Sec-WebSocket-Extensions: permessage-deflate;
        // client_max_window_bits" line in the real handshake.
        const ws = new WebSocket(CODEX_RESPONSES_WS_URL, undefined, {
            headers,
            agent,
            perMessageDeflate: { clientMaxWindowBits: 15 },
            handshakeTimeout: 30_000,
            // We set Host, Origin, etc. purely via headers above — no other fields
            // should bleed from ws defaults since they'd diverge from the real CLI.
        });
        const onOpen = () => {
            ws.off("error", onError);
            ws.off("unexpected-response", onUnexpected);
            resolve({ ws });
        };
        const onError = (err) => {
            ws.off("open", onOpen);
            ws.off("unexpected-response", onUnexpected);
            reject(err);
        };
        const onUnexpected = (_req, res) => {
            // The server rejected the upgrade — capture status + body to drive
            // 401/429/5xx handling the same way the old HTTP path did.
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf-8");
                ws.off("open", onOpen);
                ws.off("error", onError);
                reject(new WsDialError(res.statusCode ?? 0, res.headers, body));
            });
            res.on("error", (err) => {
                ws.off("open", onOpen);
                ws.off("error", onError);
                reject(err);
            });
        };
        ws.once("open", onOpen);
        ws.once("error", onError);
        ws.once("unexpected-response", onUnexpected);
    });
}
export async function callCodexApi(opts) {
    configureDispatcher();
    if (!rateGuard)
        configureRateGuard();
    return rateGuard.run(() => doCallCodexApi(opts));
}
export async function callCodexApiPassthrough(opts) {
    configureDispatcher();
    if (!rateGuard)
        configureRateGuard();
    return rateGuard.run(() => doCallCodexApiPassthrough(opts));
}
async function doCallCodexApi(opts) {
    const prompt = (opts.prompt ?? "").trim();
    if (!prompt) {
        throw new Error("Empty prompt");
    }
    const fingerprint = loadCodexFingerprint();
    const sessionId = getMaskedSessionId();
    let transientAttempt = 0;
    let hasRefreshed = false;
    // Real CLI bumps `window_generation` each time the conversation's
    // window rolls (compact, new subtopic, etc.). For the relay scenario
    // we start at 0 and keep it there — retries within the same prompt
    // don't advance the window.
    const windowGeneration = 0;
    while (true) {
        const creds = await getFreshCreds();
        // Turn-metadata header: real Codex CLI builds this from TurnMetadataBag
        // (codex-rs/core/src/turn_metadata.rs:56-66). Field order in serde
        // is session_id → turn_id → workspaces → sandbox, with
        // `skip_serializing_if` for None and empty BTreeMap, meaning:
        //   - Empty `workspaces` is OMITTED, not serialized as `{}`.
        //   - `sandbox` is always present on an interactive CLI run because
        //     TurnMetadataState constructs it from sandbox_tag(sandbox_policy).
        // Our relay has no real workspace + no sandbox policy, so we:
        //   - Skip the workspaces field entirely (matches BTreeMap::is_empty).
        //   - Emit a platform-appropriate sandbox tag so the field matches
        //     what a real CLI user on this OS would send. Real CLI values:
        //       "seatbelt"        — macOS
        //       "seccomp"         — Linux
        //       "windows_sandbox" — Windows (restricted token)
        //       "none"            — DangerFullAccess / sandbox disabled
        //     We pick the default per platform; an operator can override via
        //     the fingerprint file if they're running with a custom policy.
        const platformSandboxTag = process.platform === "darwin"
            ? "seatbelt"
            : process.platform === "linux"
                ? "seccomp"
                : process.platform === "win32"
                    ? "windows_sandbox"
                    : "none";
        const turnMetadata = JSON.stringify({
            session_id: sessionId,
            turn_id: randomUUID(),
            sandbox: platformSandboxTag,
        });
        // Build TWO frames for the same WS session — real Codex CLI's turn
        // flow is:
        //   1. open WebSocket
        //   2. send prewarm frame `{...request, generate: false}`
        //   3. wait for response.completed (server returns completed with
        //      no generated tokens — warmup is cheap)
        //   4. send the real frame on the SAME connection
        //   5. wait for response.completed with the actual stream output
        //   6. close WebSocket
        // See codex-rs/core/src/client.rs:1377-1425 (prewarm_websocket) and
        // lines 1283-1285 (`if warmup { ws_payload.generate = Some(false); }`).
        //
        // Relay accounts that skip step 2-3 stick out: the account's entire
        // traffic history shows zero prewarm frames, while every real CLI
        // user's account shows exactly one prewarm per turn. We mirror the
        // full two-phase flow to eliminate this signal.
        const warmupFrame = buildCodexRequestFrame(prompt, opts.model, fingerprint, sessionId, turnMetadata, windowGeneration, 
        /*warmup*/ true);
        const realFrame = buildCodexRequestFrame(prompt, opts.model, fingerprint, sessionId, turnMetadata, windowGeneration, 
        /*warmup*/ false);
        const warmupFrameJson = JSON.stringify(warmupFrame);
        const realFrameJson = JSON.stringify(realFrame);
        // Build handshake headers to match Codex CLI 0.118's real upgrade
        // request. Key sources:
        //   codex-rs/core/src/client.rs:771-798 → build_websocket_headers
        //     → build_responses_headers + build_conversation_headers +
        //       build_responses_identity_headers
        //   codex-rs/login/src/auth/default_client.rs:228 →
        //     reqwest-level default header `originator`
        //
        // Real on-wire set for a /backend-api/codex/responses upgrade:
        //   originator: codex_cli_rs
        //   openai-beta: responses_websockets=2026-02-06
        //   x-codex-turn-metadata: <json>
        //   x-client-request-id: <conversation_id>
        //   session_id: <conversation_id>        ← from build_conversation_headers
        //   x-codex-window-id: <conversation_id>:<window_generation>
        //   (+ authorization: Bearer, user-agent, and whatever the ws client adds)
        //
        // NOTE: `chatgpt-account-id` and `version` are NOT sent on the real
        // upgrade path — they belong to other code assist endpoints. We leave
        // them out to shrink the fingerprint delta.
        const windowId = `${sessionId}:${windowGeneration}`;
        const headers = {
            "authorization": `Bearer ${creds.accessToken}`,
            "originator": fingerprint.originator,
            "openai-beta": fingerprint.openai_beta,
            "session_id": sessionId,
            "x-client-request-id": sessionId,
            "x-codex-window-id": windowId,
            "x-codex-turn-metadata": turnMetadata,
        };
        if (fingerprint.user_agent) {
            headers["user-agent"] = fingerprint.user_agent;
        }
        let dialed;
        try {
            dialed = await dialCodexWebSocket(headers);
        }
        catch (err) {
            if (err instanceof WsDialError) {
                const status = err.statusCode;
                if (status === 429) {
                    const cooldown = cooldownFromHttpHeaders(err.headers);
                    if (cooldown && rateGuard) {
                        rateGuard.triggerCooldown(cooldown.ms, cooldown.reason);
                    }
                    else if (rateGuard) {
                        rateGuard.triggerCooldown(Date.now() + 5 * 60_000, "fallback 5m (no reset header)");
                    }
                    throw new Error(`Codex 429 rate-limited: ${err.bodySnippet.slice(0, 300)}`);
                }
                if (status === 401 && !hasRefreshed) {
                    logger.warn("[codex-api] 401 from upgrade, refreshing token + retry");
                    hasRefreshed = true;
                    cachedCreds = null;
                    continue;
                }
                const isTransient = status >= 500 && status <= 599;
                if (isTransient && transientAttempt < MAX_TRANSIENT_RETRIES) {
                    const backoffMs = 500 * Math.pow(2, transientAttempt) + Math.random() * 500;
                    logger.warn(`[codex-api] upgrade ${status} (attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(backoffMs)}ms — ${err.bodySnippet.slice(0, 200)}`);
                    await new Promise((r) => setTimeout(r, backoffMs));
                    transientAttempt++;
                    continue;
                }
                throw new Error(`Codex upgrade ${status}: ${err.bodySnippet.slice(0, 400)}`);
            }
            // Plain transport error (DNS, TCP, TLS) — treat like a 5xx for retry
            // purposes, then bubble up.
            if (transientAttempt < MAX_TRANSIENT_RETRIES) {
                const backoffMs = 500 * Math.pow(2, transientAttempt) + Math.random() * 500;
                logger.warn(`[codex-api] transport error (attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(backoffMs)}ms — ${err.message}`);
                await new Promise((r) => setTimeout(r, backoffMs));
                transientAttempt++;
                continue;
            }
            throw err;
        }
        // Connection is open. Run the two-phase prewarm → real flow on the
        // same WebSocket session. Phase state machine:
        //   - phase = "warmup": server frames are consumed only to detect
        //     response.completed. Text / usage deltas are ignored because
        //     generate=false suppresses them (and even if the server sends
        //     something, we want the real request's numbers, not the
        //     warmup's).
        //   - phase = "real": server frames populate the shared accumulator
        //     as before; response.completed finishes the promise.
        const { ws } = dialed;
        const acc = {
            text: "",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            model: opts.model,
            terminal: false,
        };
        let resolved = false;
        const result = await new Promise((resolve) => {
            let phase = "warmup";
            const finish = (r) => {
                if (resolved)
                    return;
                resolved = true;
                clearTimeout(timer);
                try {
                    ws.close(1000, "done");
                }
                catch {
                    // ignore
                }
                resolve(r);
            };
            const timer = setTimeout(() => {
                finish({
                    ok: false,
                    retriable: false,
                    error: new Error(`Codex WS timed out after ${WS_OVERALL_TIMEOUT_MS}ms waiting for response.completed`),
                });
            }, WS_OVERALL_TIMEOUT_MS);
            // Scratch accumulator used for the warmup phase. Real CLI throws
            // warmup output away (client.rs:1408-1417 just reads until
            // Completed and discards everything else).
            const warmupAcc = {
                text: "",
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                model: opts.model,
                terminal: false,
            };
            const sendFrame = (frameJson) => {
                try {
                    ws.send(frameJson, (sendErr) => {
                        if (sendErr) {
                            finish({ ok: false, retriable: true, error: sendErr });
                        }
                    });
                }
                catch (err) {
                    finish({ ok: false, retriable: true, error: err });
                }
            };
            ws.on("message", (data, _isBinary) => {
                const text = Buffer.isBuffer(data)
                    ? data.toString("utf-8")
                    : Array.isArray(data)
                        ? Buffer.concat(data).toString("utf-8")
                        : Buffer.from(data).toString("utf-8");
                // Frames are individual JSON objects (no newline framing).
                const target = phase === "warmup" ? warmupAcc : acc;
                // Forward raw frames to the caller (when streaming is requested)
                // only for the real phase — warmup frames are daemon-internal and
                // never reach the end client. Each frame is re-emitted as an
                // Anthropic-style SSE block where `event:` is the frame type
                // (response.output_text.delta, response.completed, etc.), which
                // matches OpenAI's public Responses API SSE wire format exactly.
                if (phase === "real" && opts.onRawEvent) {
                    try {
                        const parsedFrame = JSON.parse(text);
                        const frameType = typeof parsedFrame.type === "string" ? parsedFrame.type : "message";
                        // Inject usage.total_tokens on response.completed frames so
                        // the end client's strict parser doesn't abort the stream.
                        const patched = patchCodexFrameForForwarding(text);
                        opts.onRawEvent(`event: ${frameType}\ndata: ${patched}\n\n`);
                    }
                    catch {
                        // Non-JSON frame — forward as a plain data event.
                        opts.onRawEvent(`event: message\ndata: ${text}\n\n`);
                    }
                }
                const outcome = handleFrame(text, target);
                if (outcome.rateLimit && rateGuard) {
                    // Soft hint — record but don't kill this request. Next request will
                    // hit the cooldown check at the guard level.
                    rateGuard.triggerCooldown(outcome.rateLimit.ms, outcome.rateLimit.reason);
                }
                if (outcome.terminal) {
                    if (outcome.error) {
                        finish({
                            ok: false,
                            retriable: false,
                            error: new Error(`Codex upstream error: ${outcome.error}`),
                        });
                        return;
                    }
                    if (phase === "warmup") {
                        // Warmup done — advance phase and send the real frame on
                        // the same WebSocket. Do NOT close the socket here; real
                        // CLI keeps the connection open so the real request can
                        // reuse it.
                        phase = "real";
                        sendFrame(realFrameJson);
                        return;
                    }
                    // Real phase completed.
                    acc.terminal = true;
                    finish({ ok: true });
                }
            });
            ws.on("close", (code, reason) => {
                if (acc.terminal)
                    return; // normal close after real-phase terminal event
                finish({
                    ok: false,
                    retriable: true,
                    error: new Error(`Codex WS closed early (code=${code}, reason=${reason.toString().slice(0, 200)})`),
                });
            });
            ws.on("error", (err) => {
                finish({ ok: false, retriable: true, error: err });
            });
            // Phase 1: send the warmup frame (generate=false). The server
            // responds with response.completed without generating tokens;
            // our message handler then transitions to phase "real" and sends
            // the real frame on this same connection.
            sendFrame(warmupFrameJson);
        });
        if (!result.ok) {
            if (result.retriable && transientAttempt < MAX_TRANSIENT_RETRIES) {
                const backoffMs = 500 * Math.pow(2, transientAttempt) + Math.random() * 500;
                logger.warn(`[codex-api] mid-session ws error (attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(backoffMs)}ms — ${result.error.message}`);
                await new Promise((r) => setTimeout(r, backoffMs));
                transientAttempt++;
                continue;
            }
            throw result.error;
        }
        const parsed = {
            text: acc.text,
            sessionId,
            usage: {
                input_tokens: acc.inputTokens,
                output_tokens: acc.outputTokens,
                cache_creation_tokens: 0,
                cache_read_tokens: acc.cacheReadTokens,
            },
            model: acc.model,
            costUsd: 0,
        };
        if (rateGuard) {
            const cost = calculateCost(opts.model, parsed.usage.input_tokens, parsed.usage.output_tokens, parsed.usage.cache_creation_tokens, parsed.usage.cache_read_tokens);
            rateGuard.recordSpend(cost.apiCost);
            parsed.costUsd = cost.apiCost;
        }
        logger.info(`[codex-api] OK model=${acc.model} in=${acc.inputTokens} out=${acc.outputTokens} cache_read=${acc.cacheReadTokens}`);
        return parsed;
    }
}
// ── Passthrough frame builder ─────────────────────────────────────────────
// Build a ChatGPT backend-api/codex/responses WS frame from the buyer's
// raw Responses API body. Daemon-controlled fields (type, client_metadata,
// store, stream, include, generate, model) are always overwritten; every
// other field — input, instructions, tools, tool_choice, reasoning,
// parallel_tool_calls, etc. — is preserved verbatim so the end client's
// agentic loop works end-to-end.
function buildCodexPassthroughFrame(clientBody, model, fingerprint, sessionId, turnMetadataHeader, windowGeneration, warmup) {
    // Shallow clone so we don't mutate the buyer's dict across retries.
    const frame = { ...clientBody };
    // Daemon-controlled envelope fields — always forced.
    frame.type = "response.create";
    frame.model = model;
    frame.store = false;
    frame.stream = true;
    // Real CLI sends include: ["reasoning.encrypted_content"] when reasoning
    // is enabled. We set reasoning below (from client or default), so include
    // it for fingerprint parity.
    frame.include = ["reasoning.encrypted_content"];
    // Daemon fingerprint injection — client_metadata is how the upstream
    // ties traffic to a device+window identity. Buyers never see this
    // field; always set it from our fingerprint.
    frame.client_metadata = {
        "x-codex-installation-id": fingerprint.installation_id,
        "x-codex-window-id": `${sessionId}:${windowGeneration}`,
        "x-codex-turn-metadata": turnMetadataHeader,
    };
    // Reasoning: if buyer sent their own reasoning config, preserve it;
    // otherwise inject the real-CLI default `{effort: "medium", summary: "auto"}`
    // so the request shape matches typical CLI traffic.
    if (!frame.reasoning || typeof frame.reasoning !== "object") {
        frame.reasoning = { effort: "medium", summary: "auto" };
    }
    // Ensure tools is an array (real CLI always sends tools, even if empty).
    if (!Array.isArray(frame.tools)) {
        frame.tools = [];
    }
    // Default tool_choice if not set.
    if (frame.tool_choice === undefined || frame.tool_choice === null) {
        frame.tool_choice = "auto";
    }
    // Default parallel_tool_calls to false (matches current template).
    if (frame.parallel_tool_calls === undefined) {
        frame.parallel_tool_calls = false;
    }
    // Instructions: if buyer didn't send one, fall back to a neutral
    // tool-friendly default so the model still has guidance while not
    // forbidding tool use (unlike template mode's RELAY_INSTRUCTIONS,
    // which says "plain text only" — wrong fit for passthrough where
    // buyer's tools should actually be used).
    if (typeof frame.instructions !== "string" || !frame.instructions) {
        frame.instructions = CODEX_PASSTHROUGH_FALLBACK_INSTRUCTIONS;
    }
    if (warmup) {
        // Real CLI's prewarm flow: first frame of each turn has generate:false.
        frame.generate = false;
    }
    else {
        // Explicitly unset any leftover generate:false (buyer's body shouldn't
        // carry it, but defensive).
        delete frame.generate;
    }
    return frame;
}
// ── Passthrough entry point ───────────────────────────────────────────────
//
// Copy-pasted from doCallCodexApi (with frame-building swapped for
// buildCodexPassthroughFrame). Duplicated rather than refactored so we
// can iterate on passthrough-specific bugs without risking a regression
// in the battle-tested template path. When passthrough stabilizes we
// can merge the two via a frame-builder parameter.
async function doCallCodexApiPassthrough(opts) {
    // Minimal body validation — we need at least `input` (array) and the
    // model. Everything else is optional per the Responses API spec.
    const input = opts.clientBody.input;
    if (!Array.isArray(input) || input.length === 0) {
        throw new Error("Passthrough body missing `input` array");
    }
    const fingerprint = loadCodexFingerprint();
    const sessionId = getMaskedSessionId();
    let transientAttempt = 0;
    let hasRefreshed = false;
    const windowGeneration = 0;
    while (true) {
        const creds = await getFreshCreds();
        const platformSandboxTag = process.platform === "darwin"
            ? "seatbelt"
            : process.platform === "linux"
                ? "seccomp"
                : process.platform === "win32"
                    ? "windows_sandbox"
                    : "none";
        const turnMetadata = JSON.stringify({
            session_id: sessionId,
            turn_id: randomUUID(),
            sandbox: platformSandboxTag,
        });
        const warmupFrame = buildCodexPassthroughFrame(opts.clientBody, opts.model, fingerprint, sessionId, turnMetadata, windowGeneration, 
        /*warmup*/ true);
        const realFrame = buildCodexPassthroughFrame(opts.clientBody, opts.model, fingerprint, sessionId, turnMetadata, windowGeneration, 
        /*warmup*/ false);
        const warmupFrameJson = JSON.stringify(warmupFrame);
        const realFrameJson = JSON.stringify(realFrame);
        const windowId = `${sessionId}:${windowGeneration}`;
        const headers = {
            "authorization": `Bearer ${creds.accessToken}`,
            "originator": fingerprint.originator,
            "openai-beta": fingerprint.openai_beta,
            "session_id": sessionId,
            "x-client-request-id": sessionId,
            "x-codex-window-id": windowId,
            "x-codex-turn-metadata": turnMetadata,
        };
        if (fingerprint.user_agent) {
            headers["user-agent"] = fingerprint.user_agent;
        }
        let dialed;
        try {
            dialed = await dialCodexWebSocket(headers);
        }
        catch (err) {
            if (err instanceof WsDialError) {
                const status = err.statusCode;
                if (status === 429) {
                    const cooldown = cooldownFromHttpHeaders(err.headers);
                    if (cooldown && rateGuard) {
                        rateGuard.triggerCooldown(cooldown.ms, cooldown.reason);
                    }
                    else if (rateGuard) {
                        rateGuard.triggerCooldown(Date.now() + 5 * 60_000, "fallback 5m (no reset header)");
                    }
                    throw new Error(`Codex 429 rate-limited: ${err.bodySnippet.slice(0, 300)}`);
                }
                if (status === 401 && !hasRefreshed) {
                    logger.warn("[codex-api] 401 from upgrade (passthrough), refreshing token + retry");
                    hasRefreshed = true;
                    cachedCreds = null;
                    continue;
                }
                const isTransient = status >= 500 && status <= 599;
                if (isTransient && transientAttempt < MAX_TRANSIENT_RETRIES) {
                    const backoffMs = 500 * Math.pow(2, transientAttempt) + Math.random() * 500;
                    logger.warn(`[codex-api] upgrade ${status} (passthrough attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(backoffMs)}ms — ${err.bodySnippet.slice(0, 200)}`);
                    await new Promise((r) => setTimeout(r, backoffMs));
                    transientAttempt++;
                    continue;
                }
                throw new Error(`Codex upgrade ${status}: ${err.bodySnippet.slice(0, 400)}`);
            }
            if (transientAttempt < MAX_TRANSIENT_RETRIES) {
                const backoffMs = 500 * Math.pow(2, transientAttempt) + Math.random() * 500;
                logger.warn(`[codex-api] transport error (passthrough attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(backoffMs)}ms — ${err.message}`);
                await new Promise((r) => setTimeout(r, backoffMs));
                transientAttempt++;
                continue;
            }
            throw err;
        }
        const { ws } = dialed;
        const acc = {
            text: "",
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            model: opts.model,
            terminal: false,
        };
        let resolved = false;
        const result = await new Promise((resolve) => {
            let phase = "warmup";
            const finish = (r) => {
                if (resolved)
                    return;
                resolved = true;
                clearTimeout(timer);
                try {
                    ws.close(1000, "done");
                }
                catch {
                    // ignore
                }
                resolve(r);
            };
            const timer = setTimeout(() => {
                finish({
                    ok: false,
                    retriable: false,
                    error: new Error(`Codex WS timed out after ${WS_OVERALL_TIMEOUT_MS}ms waiting for response.completed`),
                });
            }, WS_OVERALL_TIMEOUT_MS);
            const warmupAcc = {
                text: "",
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                model: opts.model,
                terminal: false,
            };
            const sendFrame = (frameJson) => {
                try {
                    ws.send(frameJson, (sendErr) => {
                        if (sendErr) {
                            finish({ ok: false, retriable: true, error: sendErr });
                        }
                    });
                }
                catch (err) {
                    finish({ ok: false, retriable: true, error: err });
                }
            };
            ws.on("message", (data, _isBinary) => {
                const text = Buffer.isBuffer(data)
                    ? data.toString("utf-8")
                    : Array.isArray(data)
                        ? Buffer.concat(data).toString("utf-8")
                        : Buffer.from(data).toString("utf-8");
                const target = phase === "warmup" ? warmupAcc : acc;
                // Forward raw frames to the Hub for real-time SSE streaming to
                // the end client. Same rules as template mode — only real phase,
                // wrap as `event: <type>\ndata: <json>\n\n`.
                if (phase === "real" && opts.onRawEvent) {
                    try {
                        const parsedFrame = JSON.parse(text);
                        const frameType = typeof parsedFrame.type === "string" ? parsedFrame.type : "message";
                        const patched = patchCodexFrameForForwarding(text);
                        opts.onRawEvent(`event: ${frameType}\ndata: ${patched}\n\n`);
                    }
                    catch {
                        opts.onRawEvent(`event: message\ndata: ${text}\n\n`);
                    }
                }
                const outcome = handleFrame(text, target);
                if (outcome.rateLimit && rateGuard) {
                    rateGuard.triggerCooldown(outcome.rateLimit.ms, outcome.rateLimit.reason);
                }
                if (outcome.terminal) {
                    if (outcome.error) {
                        finish({
                            ok: false,
                            retriable: false,
                            error: new Error(`Codex upstream error: ${outcome.error}`),
                        });
                        return;
                    }
                    if (phase === "warmup") {
                        phase = "real";
                        sendFrame(realFrameJson);
                        return;
                    }
                    acc.terminal = true;
                    finish({ ok: true });
                }
            });
            ws.on("close", (code, reason) => {
                if (acc.terminal)
                    return;
                finish({
                    ok: false,
                    retriable: true,
                    error: new Error(`Codex WS closed early (code=${code}, reason=${reason.toString().slice(0, 200)})`),
                });
            });
            ws.on("error", (err) => {
                finish({ ok: false, retriable: true, error: err });
            });
            sendFrame(warmupFrameJson);
        });
        if (!result.ok) {
            if (result.retriable && transientAttempt < MAX_TRANSIENT_RETRIES) {
                const backoffMs = 500 * Math.pow(2, transientAttempt) + Math.random() * 500;
                logger.warn(`[codex-api] mid-session ws error (passthrough attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), retrying in ${Math.round(backoffMs)}ms — ${result.error.message}`);
                await new Promise((r) => setTimeout(r, backoffMs));
                transientAttempt++;
                continue;
            }
            throw result.error;
        }
        const parsed = {
            text: acc.text,
            sessionId,
            usage: {
                input_tokens: acc.inputTokens,
                output_tokens: acc.outputTokens,
                cache_creation_tokens: 0,
                cache_read_tokens: acc.cacheReadTokens,
            },
            model: acc.model,
            costUsd: 0,
        };
        if (rateGuard) {
            const cost = calculateCost(opts.model, parsed.usage.input_tokens, parsed.usage.output_tokens, parsed.usage.cache_creation_tokens, parsed.usage.cache_read_tokens);
            rateGuard.recordSpend(cost.apiCost);
            parsed.costUsd = cost.apiCost;
        }
        logger.info(`[codex-api] passthrough OK model=${acc.model} in=${acc.inputTokens} out=${acc.outputTokens} cache_read=${acc.cacheReadTokens}`);
        return parsed;
    }
}
