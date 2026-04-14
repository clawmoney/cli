/**
 * Programmatic Gemini fingerprint capture.
 *
 * Mirrors scripts/capture-gemini-request.mjs but runs inline so the
 * setup wizard can bootstrap ~/.clawmoney/gemini-fingerprint.json
 * without the two-terminal dance.
 *
 * Flow:
 *   1. Listen on a random localhost port.
 *   2. Spawn `gemini -p "hi"` with CODE_ASSIST_ENDPOINT pointing at us.
 *   3. When the first POST hits a /v1internal:generateContent (or
 *      similar) path, extract project_id / user_agent / cli_version /
 *      x_goog_api_client from the body + headers, persist to
 *      ~/.clawmoney/gemini-fingerprint.json, and forward the request
 *      to cloudcode-pa.googleapis.com so the gemini CLI still sees a
 *      valid response.
 *   4. Clean up proxy server + gemini subprocess.
 *
 * Note: the :loadCodeAssist bootstrap request that Gemini CLI fires
 * first carries only `{metadata}` without a project — we skip it and
 * wait for a subsequent v1internal request that actually carries a
 * project field. Mirrors the mjs script's extractFingerprint guard.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync, } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fetch as undiciFetch, ProxyAgent } from "undici";
const CONFIG_DIR = join(homedir(), ".clawmoney");
const FINGERPRINT_PATH = join(CONFIG_DIR, "gemini-fingerprint.json");
export function hasGeminiFingerprint() {
    return existsSync(FINGERPRINT_PATH);
}
const HOP_BY_HOP = new Set([
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "accept-encoding",
]);
function cloneHeaders(src) {
    const out = {};
    for (const [k, v] of Object.entries(src)) {
        if (v == null)
            continue;
        if (HOP_BY_HOP.has(k.toLowerCase()))
            continue;
        out[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    return out;
}
// /v1beta and /v1alpha go to generativelanguage (AI Studio).
// Everything else (notably /v1internal for Code Assist) goes to
// cloudcode-pa. Matches the manual script's routing.
function resolveUpstreamURL(path) {
    if (path.startsWith("/v1beta") ||
        path.startsWith("/v1/beta") ||
        path.startsWith("/v1alpha")) {
        return `https://generativelanguage.googleapis.com${path}`;
    }
    return `https://cloudcode-pa.googleapis.com${path}`;
}
function extractFingerprint(body, headers) {
    if (!body || typeof body !== "object")
        return null;
    const projectRaw = body.project;
    const projectId = typeof projectRaw === "string" ? projectRaw.trim() : "";
    // :loadCodeAssist carries {metadata} without a project — wait for
    // the next request that does.
    if (!projectId)
        return null;
    const uaRaw = headers["user-agent"];
    const ua = (Array.isArray(uaRaw) ? uaRaw.join(", ") : (uaRaw ?? "")).trim();
    const versionMatch = ua.match(/GeminiCLI\/(\d+\.\d+[.\d]*)/i);
    const cliVersion = versionMatch ? versionMatch[1] : "unknown";
    const xGoogRaw = headers["x-goog-api-client"];
    const xGoog = (Array.isArray(xGoogRaw) ? xGoogRaw.join(", ") : (xGoogRaw ?? "")).trim();
    return {
        project_id: projectId,
        cli_version: cliVersion,
        user_agent: ua || `GeminiCLI/${cliVersion}`,
        x_goog_api_client: xGoog || "gl-node/unknown",
    };
}
function scrubCaptureFiles() {
    try {
        for (const f of readdirSync(CONFIG_DIR)) {
            if (/^capture-gemini-\d+\.json$/.test(f)) {
                unlinkSync(join(CONFIG_DIR, f));
            }
        }
    }
    catch {
        // ignore — best-effort
    }
}
export async function bootstrapGeminiFingerprint(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 45_000;
    mkdirSync(CONFIG_DIR, { recursive: true });
    if (hasGeminiFingerprint()) {
        throw new Error("gemini-fingerprint.json already exists — delete it to re-bootstrap");
    }
    // Gemini talks to Google — Google is reachable only through a
    // proxy from GFW-side networks, so we DO honor HTTPS_PROXY for the
    // upstream forward. The child subprocess gets no proxy env because
    // it's talking to 127.0.0.1 (us), and routing 127.0.0.1 through
    // http_proxy tends to wedge.
    const proxyUrl = process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy;
    let upstreamDispatcher;
    if (proxyUrl && /^https?:\/\//.test(proxyUrl)) {
        upstreamDispatcher = new ProxyAgent(proxyUrl);
    }
    let server = null;
    let geminiChild = null;
    let resolved = false;
    let capturedFp = null;
    const cleanup = () => {
        if (geminiChild && !geminiChild.killed) {
            try {
                geminiChild.kill("SIGTERM");
            }
            catch {
                // ignore
            }
        }
        if (server) {
            try {
                server.close();
            }
            catch {
                // ignore
            }
            server = null;
        }
    };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            if (resolved)
                return;
            resolved = true;
            cleanup();
            reject(new Error(`gemini fingerprint capture timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        server = createServer((req, res) => {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", async () => {
                const bodyBuf = Buffer.concat(chunks);
                const bodyText = bodyBuf.toString("utf-8");
                let parsedBody;
                try {
                    parsedBody = JSON.parse(bodyText);
                }
                catch {
                    parsedBody = bodyText;
                }
                const isGenerate = req.method === "POST" &&
                    typeof req.url === "string" &&
                    (req.url.includes("generateContent") || req.url.includes("v1internal"));
                if (!capturedFp &&
                    isGenerate &&
                    parsedBody &&
                    typeof parsedBody === "object") {
                    const fp = extractFingerprint(parsedBody, req.headers);
                    if (fp) {
                        capturedFp = fp;
                        try {
                            writeFileSync(FINGERPRINT_PATH, JSON.stringify(fp, null, 2), "utf-8");
                            scrubCaptureFiles();
                        }
                        catch (writeErr) {
                            if (!resolved) {
                                resolved = true;
                                clearTimeout(timer);
                                cleanup();
                                reject(new Error(`failed to write gemini fingerprint: ${writeErr.message}`));
                                return;
                            }
                        }
                    }
                }
                // Forward to real Google upstream.
                const upstreamURL = resolveUpstreamURL(req.url || "/");
                const targetHost = new URL(upstreamURL).host;
                try {
                    const upstreamHeaders = cloneHeaders(req.headers);
                    upstreamHeaders["host"] = targetHost;
                    const upstreamResp = await undiciFetch(upstreamURL, {
                        method: req.method,
                        headers: upstreamHeaders,
                        body: req.method === "GET" || req.method === "HEAD"
                            ? undefined
                            : bodyBuf,
                        dispatcher: upstreamDispatcher,
                    });
                    const respHeaders = {};
                    upstreamResp.headers.forEach((v, k) => {
                        const lower = k.toLowerCase();
                        if (lower === "content-encoding" ||
                            lower === "content-length" ||
                            lower === "transfer-encoding")
                            return;
                        respHeaders[k] = v;
                    });
                    res.writeHead(upstreamResp.status, respHeaders);
                    if (upstreamResp.body) {
                        const reader = upstreamResp.body.getReader();
                        while (true) {
                            const { done: rDone, value } = await reader.read();
                            if (rDone)
                                break;
                            res.write(Buffer.from(value));
                        }
                    }
                    res.end();
                }
                catch (err) {
                    try {
                        res.writeHead(502);
                        res.end();
                    }
                    catch {
                        // ignore
                    }
                    if (!resolved && !capturedFp) {
                        resolved = true;
                        clearTimeout(timer);
                        cleanup();
                        reject(new Error(`upstream google request failed: ${err.message}`));
                        return;
                    }
                }
                if (capturedFp && !resolved) {
                    resolved = true;
                    clearTimeout(timer);
                    cleanup();
                    resolve(capturedFp);
                }
            });
        });
        server.on("error", (err) => {
            if (resolved)
                return;
            resolved = true;
            clearTimeout(timer);
            cleanup();
            reject(new Error(`gemini bootstrap proxy error: ${err.message}`));
        });
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (!addr || typeof addr === "string") {
                if (resolved)
                    return;
                resolved = true;
                clearTimeout(timer);
                cleanup();
                reject(new Error("failed to bind gemini capture proxy"));
                return;
            }
            const port = addr.port;
            // Strip upstream proxy env vars from the child so it hits our
            // local 127.0.0.1 listener directly. NO_PROXY is belt-and-braces.
            const childEnv = {
                ...process.env,
                CODE_ASSIST_ENDPOINT: `http://127.0.0.1:${port}`,
                NO_PROXY: "127.0.0.1,localhost",
                no_proxy: "127.0.0.1,localhost",
            };
            delete childEnv.HTTPS_PROXY;
            delete childEnv.https_proxy;
            delete childEnv.HTTP_PROXY;
            delete childEnv.http_proxy;
            delete childEnv.ALL_PROXY;
            delete childEnv.all_proxy;
            geminiChild = spawn("gemini", ["-p", "hi"], {
                env: childEnv,
                stdio: ["ignore", "pipe", "pipe"],
                shell: process.platform === "win32",
            });
            let stderrBuf = "";
            geminiChild.stderr?.on("data", (chunk) => {
                stderrBuf += chunk.toString();
                if (stderrBuf.length > 4_000) {
                    stderrBuf = stderrBuf.slice(-4_000);
                }
            });
            geminiChild.stdout?.on("data", () => {
                // drain
            });
            geminiChild.on("error", (err) => {
                if (resolved)
                    return;
                resolved = true;
                clearTimeout(timer);
                cleanup();
                reject(new Error(`failed to spawn gemini: ${err.message} (is the gemini CLI installed and in PATH?)`));
            });
            geminiChild.on("exit", (code) => {
                setTimeout(() => {
                    if (capturedFp || resolved)
                        return;
                    resolved = true;
                    clearTimeout(timer);
                    cleanup();
                    const tail = stderrBuf.trim().slice(-400);
                    const detail = tail ? ` stderr: ${tail}` : "";
                    reject(new Error(`gemini -p hi exited with code ${code ?? "unknown"} before sending a v1internal request.${detail}`));
                }, 500);
            });
        });
    });
}
