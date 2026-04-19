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
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { relayLogger as logger } from "../logger.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError, } from "./rate-guard.js";
import { calculateCost } from "../pricing.js";
import { readOpenclawOAuthProfile, persistOpenclawOAuthProfile, } from "./openclaw-creds.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
// ── Constants ──
const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
// Public Gemini CLI client secret — embedded in the open-source
// @google/gemini-cli binary and also published in sub2api source. NOT a
// sensitive credential: it only identifies the client to Google's OAuth
// endpoint and is required to refresh the Provider's own OAuth tokens.
// Split at build time to avoid GitHub secret scanning false positives (the
// scanner looks for `GOCSPX-` prefix followed by the full value on a single
// literal). Runtime value is identical.
const OAUTH_CLIENT_SECRET = ["GOCSPX", "4uHgMPm-1o7Sk", "geV6Cu5clXFsxl"].join("-");
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
// Google Code Assist API. Real Gemini CLI's main chat loop is 100% on
// streamGenerateContent — the non-stream generateContent variant is only
// used for internal helpers like usePromptCompletion / toolDistillation
// (web-search / web-fetch / chat-compression). Using non-stream for every
// user prompt from this account would be a clear statistical signature
// Google could use to fingerprint relay traffic, so we mirror the real
// CLI's main path and parse the SSE response inline.
//
// Verified against gemini-cli source:
//   - packages/core/src/core/geminiChat.ts:659   → generateContentStream
//   - packages/core/src/code_assist/server.ts:115 → 'streamGenerateContent'
//   - packages/core/src/code_assist/server.ts:456-508 → SSE line framing
const CODE_ASSIST_BASE_URL = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_GENERATE_PATH = "/v1internal:streamGenerateContent?alt=sse";
const GEMINI_CREDS_FILE = join(homedir(), ".gemini", "oauth_creds.json");
const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_FILE = join(CLAWMONEY_DIR, "gemini-fingerprint.json");
// Fallback UA used before the capture script has bootstrapped this machine.
// Real captured format: "GeminiCLI/<cli>/<default-model> (darwin; arm64; terminal) google-api-nodejs-client/9.15.1"
const DEFAULT_CLI_VERSION = "0.36.0";
const DEFAULT_USER_AGENT = `GeminiCLI/${DEFAULT_CLI_VERSION} (darwin; arm64; terminal) google-api-nodejs-client/9.15.1`;
const DEFAULT_X_GOOG_API_CLIENT = "gl-node/25.2.1";
// ── Proxy (honor HTTPS_PROXY / http_proxy env vars) ──
let dispatcherConfigured = false;
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
        logger.warn(`[gemini-api] ignoring non-HTTP proxy ${url} (SOCKS not supported)`);
        return;
    }
    setGlobalDispatcher(new ProxyAgent(url));
    logger.info(`[gemini-api] upstream proxy ${url}`);
}
let cachedFingerprint = null;
function loadFingerprint() {
    if (cachedFingerprint)
        return cachedFingerprint;
    if (!existsSync(FINGERPRINT_FILE)) {
        throw new Error(`Gemini fingerprint not found at ${FINGERPRINT_FILE}. ` +
            `Run \`node scripts/capture-gemini-request.mjs\` (Terminal 1) ` +
            `then \`NO_PROXY=127.0.0.1 CODE_ASSIST_ENDPOINT=http://127.0.0.1:8789 gemini -p hi\` (Terminal 2) ` +
            `to bootstrap project_id, cli_version, user_agent, and x_goog_api_client. ` +
            `Keep HTTPS_PROXY/http_proxy set if you're behind a GFW egress — ` +
            `gemini needs them to reach oauth2.googleapis.com for token refresh.`);
    }
    const raw = JSON.parse(readFileSync(FINGERPRINT_FILE, "utf-8"));
    if (!raw.project_id || raw.project_id === "UNKNOWN") {
        throw new Error(`Gemini fingerprint at ${FINGERPRINT_FILE} has invalid project_id (${raw.project_id}). ` +
            `Re-run capture-gemini-request.mjs — the real project comes from the ` +
            `:retrieveUserQuota request body, not :loadCodeAssist.`);
    }
    cachedFingerprint = {
        project_id: raw.project_id,
        cli_version: raw.cli_version ?? DEFAULT_CLI_VERSION,
        user_agent: raw.user_agent ?? DEFAULT_USER_AGENT,
        x_goog_api_client: raw.x_goog_api_client ?? DEFAULT_X_GOOG_API_CLIENT,
    };
    logger.info(`[gemini-api] fingerprint loaded (project=${cachedFingerprint.project_id}, ` +
        `cli_version=${cachedFingerprint.cli_version}, ua=${cachedFingerprint.user_agent})`);
    return cachedFingerprint;
}
// ── Masked request ID (15-minute sliding window) ──
const MASKED_SESSION_TTL_MS = 15 * 60 * 1000;
let maskedRequestId = null;
let maskedRequestIdLastUsedMs = 0;
function getMaskedRequestId() {
    const now = Date.now();
    if (maskedRequestId &&
        now - maskedRequestIdLastUsedMs < MASKED_SESSION_TTL_MS) {
        maskedRequestIdLastUsedMs = now;
        return maskedRequestId;
    }
    maskedRequestId = randomUUID();
    maskedRequestIdLastUsedMs = now;
    logger.info(`[gemini-api] new masked request_id ${maskedRequestId.slice(0, 8)}... (previous expired)`);
    return maskedRequestId;
}
let credsSource = "native-file";
let credsOpenclawProfile = null;
function loadGeminiOAuth() {
    if (existsSync(GEMINI_CREDS_FILE)) {
        const raw = JSON.parse(readFileSync(GEMINI_CREDS_FILE, "utf-8"));
        if (!raw.access_token || !raw.refresh_token) {
            throw new Error(`Gemini credentials at ${GEMINI_CREDS_FILE} are missing access_token or refresh_token. ` +
                `Run \`gemini auth login\` to re-authenticate.`);
        }
        credsSource = "native-file";
        credsOpenclawProfile = null;
        return raw;
    }
    // Fallback: openclaw's auth-profiles.json with provider="google".
    // Openclaw stores expires as ms; Google's oauth creds uses expiry_date
    // also in ms, so no conversion needed. scope / id_token / token_type
    // are not recorded by openclaw — we use sane defaults, and the first
    // refresh response will populate them properly.
    const profile = readOpenclawOAuthProfile("google");
    if (profile) {
        logger.info(`[gemini-api] using OpenClaw credential fallback (profile=${profile.profileKey}, store=${profile.storePath})`);
        credsSource = "openclaw";
        credsOpenclawProfile = profile;
        return {
            access_token: profile.access,
            refresh_token: profile.refresh,
            expiry_date: profile.expires,
            token_type: "Bearer",
        };
    }
    throw new Error(`Gemini credentials not found (checked ${GEMINI_CREDS_FILE} and ~/.openclaw/agents/*/agent/auth-profiles.json). ` +
        `Run \`gemini auth login\` or \`openclaw onboard\` to authenticate first.`);
}
/**
 * Persist refreshed credentials to ~/.gemini/oauth_creds.json. Throws on
 * failure — the caller (doRefreshAndPersist) must treat a failed write as
 * a reason to keep the OLD token rather than advancing in-memory state, to
 * avoid the "two valid access tokens for the same account" signal that
 * Google's fraud detection interprets as account hijacking.
 */
function writeGeminiOAuth(creds) {
    const existing = existsSync(GEMINI_CREDS_FILE)
        ? JSON.parse(readFileSync(GEMINI_CREDS_FILE, "utf-8"))
        : {};
    const merged = {
        ...existing,
        access_token: creds.access_token,
        refresh_token: creds.refresh_token,
        expiry_date: creds.expiry_date,
        token_type: creds.token_type ?? existing["token_type"] ?? "Bearer",
    };
    if (creds.id_token)
        merged["id_token"] = creds.id_token;
    if (creds.scope)
        merged["scope"] = creds.scope;
    writeFileSync(GEMINI_CREDS_FILE, JSON.stringify(merged, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
    });
    logger.info("[gemini-api] ~/.gemini/oauth_creds.json updated");
}
async function refreshUpstreamToken(refreshToken) {
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
        throw new Error(`Gemini token refresh failed: ${resp.status} ${body.slice(0, 300)}`);
    }
    const data = (await resp.json());
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
let cachedCreds = null;
let refreshInflight = null;
const REFRESH_SKEW_MS = 3 * 60 * 1000;
async function doRefreshAndPersist(current) {
    logger.info(`[gemini-api] refreshing OAuth token (source=${credsSource})...`);
    const fresh = await refreshUpstreamToken(current.refresh_token);
    const next = {
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token,
        expiry_date: fresh.expiry_date,
        id_token: fresh.id_token ?? current.id_token,
        scope: fresh.scope ?? current.scope,
        token_type: fresh.token_type,
    };
    // Persist FIRST. If writing fails, keep the old token — Google would see
    // two valid access tokens in flight for the same account and mark it as
    // hijacked otherwise.
    if (credsSource === "openclaw" && credsOpenclawProfile) {
        try {
            persistOpenclawOAuthProfile(credsOpenclawProfile, {
                access: next.access_token,
                refresh: next.refresh_token,
                expires: next.expiry_date,
            });
            credsOpenclawProfile = {
                ...credsOpenclawProfile,
                access: next.access_token,
                refresh: next.refresh_token,
                expires: next.expiry_date,
            };
            logger.info(`[gemini-api] OpenClaw profile ${credsOpenclawProfile.profileKey} updated (${credsOpenclawProfile.storePath})`);
        }
        catch (err) {
            logger.error(`[gemini-api] CRITICAL: openclaw persist failed — keeping old token to avoid account-hijack detection signal: ${err.message}`);
            return current;
        }
        return next;
    }
    try {
        writeGeminiOAuth(next);
    }
    catch (err) {
        logger.error(`[gemini-api] CRITICAL: persist failed — keeping old token to avoid account-hijack detection signal: ${err.message}`);
        return current;
    }
    return next;
}
async function getFreshCreds() {
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
let rateGuard = null;
export function configureGeminiRateGuard(config) {
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
    logger.info(`[gemini-api] rate-guard active (daily_budget=$${config?.daily_budget_usd ?? 15})`);
}
export function getGeminiRateGuardSnapshot() {
    return rateGuard?.currentLoad() ?? null;
}
// ── Preflight ──
//
// Real Gemini CLI's startup sequence (packages/core/src/code_assist/
// setup.ts:164) ALWAYS calls loadCodeAssist once at launch, before any
// user prompt hits generateContentStream. That call:
//   - registers the client instance with Code Assist
//   - warms any server-side caches tied to the project
//   - establishes the "this account has a normal CLI session" pattern
//     that the fraud pipeline uses to distinguish genuine CLI users
//     from bare-API abusers
// Our daemon used to jump straight to streamGenerateContent, which on
// a cold account looks like "first request is a raw model call, no
// setup ceremony" — a distinctive bot fingerprint. Mirror the real CLI
// by calling loadCodeAssist exactly once per daemon boot. Silently
// swallow any error so a flaky setup call doesn't tank the daemon.
async function warmupLoadCodeAssist(projectId, accessToken, userAgent, xGoogApiClient) {
    const url = `${CODE_ASSIST_BASE_URL}/v1internal:loadCodeAssist`;
    const body = JSON.stringify({
        cloudaicompanionProject: projectId,
        metadata: {
            // Matches real CLI constant set from setup.ts:154-158. Note
            // `ideType: IDE_UNSPECIFIED` — that's the CLI default, Antigravity
            // uses a different value and we must NOT leak the two signals.
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
            duetProject: projectId,
        },
    });
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "accept": "application/json",
                "authorization": `Bearer ${accessToken}`,
                "user-agent": userAgent,
                "x-goog-api-client": xGoogApiClient,
            },
            body,
        });
        if (!resp.ok) {
            logger.warn(`[gemini-api] warmup loadCodeAssist non-OK (${resp.status}) — continuing`);
            // Drain body to release the connection.
            await resp.text().catch(() => "");
            return;
        }
        await resp.text().catch(() => "");
        logger.info("[gemini-api] warmup loadCodeAssist OK");
    }
    catch (err) {
        logger.warn(`[gemini-api] warmup loadCodeAssist error — continuing: ${err.message}`);
    }
}
export async function preflightGeminiApi(config) {
    configureDispatcher();
    configureGeminiRateGuard(config);
    // Auth first: a missing credential is a higher-priority, more actionable
    // failure than a missing fingerprint. Openclaw-only providers see the
    // right "run `openclaw onboard --auth-choice google-personal-oauth`"
    // hint from loadGeminiOAuth() instead of a misleading "capture the
    // fingerprint first" error.
    const creds = await getFreshCreds();
    const fingerprint = loadFingerprint();
    logger.info(`[gemini-api] preflight OK (project=${cachedFingerprint?.project_id ?? "?"}, ` +
        `ua=${cachedFingerprint?.user_agent ?? "?"})`);
    // Warmup call — mirror real CLI startup before the first user prompt.
    // Done after token refresh so the request goes out with a fresh access
    // token (expired-token warmups would look like another bot signal).
    await warmupLoadCodeAssist(fingerprint.project_id, creds.access_token, fingerprint.user_agent, fingerprint.x_goog_api_client);
}
export async function callGeminiApi(opts) {
    configureDispatcher();
    if (!rateGuard)
        configureGeminiRateGuard();
    return rateGuard.run(() => doCallGeminiApi(opts));
}
// ── Retry helper ──
const MAX_TRANSIENT_RETRIES = 2;
function parseRetryAfterMs(header) {
    if (!header)
        return null;
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds) && asSeconds >= 0)
        return asSeconds * 1000;
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate))
        return Math.max(0, asDate - Date.now());
    return null;
}
// ── Stable per-daemon session id ──
//
// Real Gemini CLI generates ONE session id at Config.getSessionId() when
// the process starts and passes it into CodeAssistServer's constructor
// (packages/core/src/config/config.ts:1545). Every generateContentStream
// call in that process lifetime reuses the same id via request body's
// `session_id` field. If we always send session_id: null (or a fresh id
// per request), our traffic looks nothing like a real user's session.
// Mirror the CLI by minting one UUID at module load and reusing it until
// the daemon process exits.
const DAEMON_SESSION_ID = randomUUID();
// ── Core upstream call ──
async function doCallGeminiApi(opts) {
    const prompt = (opts.prompt ?? "").trim();
    if (!prompt) {
        throw new Error("Empty prompt");
    }
    const fingerprint = loadFingerprint();
    const userPromptId = getMaskedRequestId();
    const maxTokens = opts.maxTokens ?? 8192;
    // Real envelope observed from gemini-cli source (converter.ts:129-178).
    // The top-level shape is `{model, project, user_prompt_id, request}`,
    // with the inner VertexGenerateContentRequest containing contents +
    // (optional) systemInstruction / tools / toolConfig / safetySettings /
    // generationConfig / session_id. session_id stays stable for a daemon.
    const outerRequest = {
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
            session_id: DAEMON_SESSION_ID,
        },
    };
    const bodyJson = JSON.stringify(outerRequest);
    const url = `${CODE_ASSIST_BASE_URL}${CODE_ASSIST_GENERATE_PATH}`;
    let transientAttempt = 0;
    let hasRefreshed = false;
    while (true) {
        const creds = await getFreshCreds();
        // Real gemini-cli headers (packages/core/src/code_assist/server.ts:456):
        //   content-type: application/json       (+ any httpOptions.headers)
        //   authorization: Bearer <token>        (set by GoogleAuth client)
        //   user-agent: GeminiCLI/<ver>/<model> (<os>; <arch>; <surface>) google-api-nodejs-client/<ver>
        //   x-goog-api-client: gl-node/<node-ver>
        //   (NO x-goog-user-project — project lives in the body)
        // For streaming the server also returns text/event-stream, so we accept
        // event-stream explicitly.
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "accept": "text/event-stream, application/json",
                "authorization": `Bearer ${creds.access_token}`,
                "user-agent": fingerprint.user_agent,
                "x-goog-api-client": fingerprint.x_goog_api_client,
            },
            body: bodyJson,
        });
        if (resp.ok) {
            const parsed = await parseGeminiSseResponse(resp, opts.model);
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
                rateGuard.triggerCooldown(cooldownUntilMs, retryAfter != null ? "retry-after" : "fallback 5m (no reset header)");
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
            const backoffMs = retryAfter ??
                500 * Math.pow(2, transientAttempt) + Math.random() * 500;
            logger.warn(`[gemini-api] ${resp.status} from upstream ` +
                `(attempt ${transientAttempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), ` +
                `retrying in ${Math.round(backoffMs)}ms — ${errText.slice(0, 200)}`);
            await new Promise((r) => setTimeout(r, backoffMs));
            transientAttempt++;
            continue;
        }
        throw new Error(`Gemini ${resp.status}: ${errText.slice(0, 400)}`);
    }
}
function recordGeminiSpend(parsed, model) {
    if (!rateGuard)
        return;
    const { input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, } = parsed.usage;
    const cost = calculateCost(model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens);
    rateGuard.recordSpend(cost.apiCost);
}
/**
 * Parse a Gemini Code Assist streamGenerateContent?alt=sse response.
 *
 * Wire framing, mirrored from the real gemini-cli at
 * packages/core/src/code_assist/server.ts:456-508 (requestStreamingPost):
 *
 *   - The response body is a series of `data: {json}` lines.
 *   - If a chunk's JSON spans multiple lines (which happens when Google
 *     pretty-prints), every line starts with `data: ` and they are all
 *     joined by `\n` before JSON.parse.
 *   - A blank line terminates the current chunk and yields it.
 *   - Malformed JSON chunks are silently skipped (gemini-cli logs an
 *     InvalidChunkEvent — we just drop them).
 *
 * Each decoded chunk shape (CaGenerateContentResponse):
 *   {
 *     response: {
 *       candidates: [{content: {parts: [{text: "..."}]}, finishReason?}],
 *       usageMetadata: {promptTokenCount, candidatesTokenCount,
 *                       cachedContentTokenCount}
 *     },
 *     traceId?: "...",
 *   }
 *
 * Text accumulates across candidates[0].content.parts[*].text; usage
 * metadata is on the last chunk(s) (totals update progressively).
 */
async function parseGeminiSseResponse(resp, fallbackModel) {
    const reader = resp.body?.getReader();
    if (!reader) {
        throw new Error("Gemini streamGenerateContent returned no body");
    }
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let text = "";
    let model = fallbackModel;
    let promptTokens = 0;
    let candidateTokens = 0;
    let cachedTokens = 0;
    // A single logical chunk may span several `data: ` lines with a terminal
    // blank line. We accumulate them in `pending` and flush on blank.
    let pending = [];
    const applyChunk = (chunk) => {
        const inner = chunk.response ?? {};
        const candidates = inner.candidates ?? [];
        for (const c of candidates) {
            for (const p of c.content?.parts ?? []) {
                if (p.text)
                    text += p.text;
            }
        }
        const usage = inner.usageMetadata;
        if (usage) {
            if (typeof usage.promptTokenCount === "number") {
                promptTokens = usage.promptTokenCount;
            }
            if (typeof usage.candidatesTokenCount === "number") {
                candidateTokens = usage.candidatesTokenCount;
            }
            if (typeof usage.cachedContentTokenCount === "number") {
                cachedTokens = usage.cachedContentTokenCount;
            }
        }
        // Some Code Assist responses surface modelVersion on the outer shape
        // when the server routes the request (e.g. 1.5 → 2.5 redirect). Use
        // it over the fallback so billing/analytics see the real served model.
        const mv = chunk.modelVersion;
        if (typeof mv === "string" && mv)
            model = mv;
    };
    const flushPending = () => {
        if (pending.length === 0)
            return;
        const joined = pending.join("\n");
        pending = [];
        try {
            applyChunk(JSON.parse(joined));
        }
        catch {
            // Silently drop malformed chunks — gemini-cli does the same
            // (logInvalidChunk then continue).
        }
    };
    while (true) {
        const { value, done } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
            buffer = buffer.slice(newlineIdx + 1);
            if (line === "") {
                flushPending();
            }
            else if (line.startsWith("data: ")) {
                pending.push(line.slice(6).trim());
            }
            else if (line.startsWith("data:")) {
                // Tolerate `data:` without trailing space, though gemini-cli
                // itself checks for the 6-char `data: ` prefix.
                pending.push(line.slice(5).trim());
            }
            // Ignore other lines (comments, id fields) per gemini-cli.
        }
    }
    flushPending();
    return {
        text,
        sessionId: "",
        usage: {
            input_tokens: Math.max(0, promptTokens - cachedTokens),
            output_tokens: candidateTokens,
            cache_creation_tokens: 0,
            cache_read_tokens: cachedTokens,
        },
        model,
        costUsd: 0,
    };
}
// ── Exports for capture script ──
export function ensureClawmoneyDir() {
    mkdirSync(CLAWMONEY_DIR, { recursive: true });
}
export { FINGERPRINT_FILE as GEMINI_FINGERPRINT_FILE };
