/**
 * `clawmoney antigravity login` — OAuth browser flow for Google Antigravity IDE.
 *
 * Antigravity is Google's agentic IDE. Its quota pool is separate from Gemini
 * CLI's, so a provider who pairs an Antigravity daemon with a Gemini CLI
 * daemon on the same Google account gets 2× Gemini capacity. More importantly,
 * Antigravity is the only path that exposes Claude models to non-Anthropic-
 * subscribed Google Ultra users.
 *
 * Flow:
 *   1. Generate PKCE verifier + challenge.
 *   2. Start a short-lived HTTP server on localhost:51121.
 *   3. Print the Google consent URL (and try to open it in the browser).
 *   4. Wait for Google to redirect back with ?code=....
 *   5. Exchange the code for refresh + access tokens.
 *   6. Resolve the cloudaicompanionProject via loadCodeAssist.
 *   7. Persist to ~/.clawmoney/antigravity-accounts.json.
 *
 * The implementation borrows heavily from the opencode-antigravity-auth
 * reference project — same client id, same scopes, same PKCE + state payload
 * format, so tokens issued by this flow are interchangeable with that plugin.
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_SCOPES, ANTIGRAVITY_REDIRECT_URI, exchangeAntigravityAuthCode, fetchAntigravityUserEmail, storeNewAntigravityAccount, ANTIGRAVITY_ACCOUNTS_FILE, loadAccounts, } from "../relay/upstream/antigravity-api.js";
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
function base64Url(input) {
    return input
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}
function generatePkce() {
    // RFC 7636: verifier is 43–128 chars of [A-Z / a-z / 0-9 / "-" / "." / "_" / "~"].
    // We use 32 random bytes → 43-char base64url, matching @openauthjs/openauth.
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    return { verifier, challenge };
}
function encodeState(verifier) {
    return Buffer.from(JSON.stringify({ verifier, projectId: "" }), "utf8").toString("base64url");
}
function buildAuthUrl(challenge, state) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", ANTIGRAVITY_REDIRECT_URI);
    url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "offline");
    // `prompt=consent` forces Google to re-issue a refresh_token even if the
    // user has already granted the Antigravity scopes before. Without this,
    // Google silently drops refresh_token from the token response and we'd
    // store a dead account.
    url.searchParams.set("prompt", "consent");
    return url.toString();
}
function openInBrowser(url) {
    const cmd = process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
            ? `start "" "${url}"`
            : `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) {
            // Non-fatal — we already printed the URL for the user to copy.
        }
    });
}
function waitForCallback() {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            if (!req.url || !req.url.startsWith(CALLBACK_PATH)) {
                res.writeHead(404);
                res.end();
                return;
            }
            const parsed = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
            const error = parsed.searchParams.get("error");
            if (error) {
                res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
                res.end(`<html><body><h1>Login failed</h1><p>${error}</p><p>You can close this tab and re-run <code>clawmoney antigravity login</code>.</p></body></html>`);
                reject(new Error(`OAuth error: ${error}`));
                return;
            }
            const code = parsed.searchParams.get("code");
            const state = parsed.searchParams.get("state");
            if (!code || !state) {
                res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
                res.end("<html><body><h1>Missing code or state</h1></body></html>");
                reject(new Error("OAuth callback missing code/state"));
                return;
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end(`<html><body style="font-family:system-ui;padding:40px;text-align:center;">
          <h1>✓ ClawMoney is linked to Antigravity</h1>
          <p>You can close this tab and return to your terminal.</p>
        </body></html>`);
            resolve({ result: { code, state }, server });
        });
        server.on("error", (err) => reject(err));
        server.listen(CALLBACK_PORT, "127.0.0.1");
        setTimeout(() => {
            reject(new Error(`Timed out waiting for OAuth callback after ${Math.round(CALLBACK_TIMEOUT_MS / 60_000)} minutes.`));
        }, CALLBACK_TIMEOUT_MS).unref();
    });
}
export async function antigravityLoginCommand() {
    console.log(chalk.bold("\n  Antigravity OAuth login\n"));
    console.log(chalk.dim("  This links a Google account's Antigravity IDE quota to your ClawMoney daemon."));
    console.log(chalk.dim("  Antigravity has a SEPARATE quota pool from Gemini CLI — use both to double your capacity."));
    console.log("");
    const { verifier, challenge } = generatePkce();
    const state = encodeState(verifier);
    const authUrl = buildAuthUrl(challenge, state);
    const spinner = ora("Starting local callback server on 127.0.0.1:51121...").start();
    let callbackPromise;
    try {
        callbackPromise = waitForCallback();
        spinner.succeed("Callback server ready");
    }
    catch (err) {
        spinner.fail(`Failed to bind localhost:${CALLBACK_PORT} — is another clawmoney login already running?`);
        throw err;
    }
    console.log("");
    console.log(chalk.bold("  Open this URL in your browser to authorize:"));
    console.log("");
    console.log("    " + chalk.cyan(authUrl));
    console.log("");
    console.log(chalk.dim("  (Attempting to open it automatically. If nothing opens, copy it manually.)"));
    openInBrowser(authUrl);
    const waitSpinner = ora("Waiting for Google to redirect back...").start();
    let code;
    let server;
    try {
        const callback = await callbackPromise;
        code = callback.result.code;
        server = callback.server;
        waitSpinner.succeed("Received authorization code");
    }
    catch (err) {
        waitSpinner.fail(err.message);
        throw err;
    }
    finally {
        // The HTTP server is single-use; close it regardless of success.
    }
    server.close();
    const exchangeSpinner = ora("Exchanging code for tokens...").start();
    let tokens;
    try {
        tokens = await exchangeAntigravityAuthCode({
            code,
            code_verifier: verifier,
        });
        exchangeSpinner.succeed("Tokens received");
    }
    catch (err) {
        exchangeSpinner.fail(err.message);
        throw err;
    }
    const emailSpinner = ora("Fetching account email...").start();
    const email = await fetchAntigravityUserEmail(tokens.access_token);
    if (email) {
        emailSpinner.succeed(`Linked account: ${email}`);
    }
    else {
        emailSpinner.warn("Could not fetch account email (not fatal)");
    }
    const storeSpinner = ora("Resolving project ID and persisting account...").start();
    try {
        const account = await storeNewAntigravityAccount({
            refresh_token: tokens.refresh_token,
            access_token: tokens.access_token,
            expiry_ms: tokens.expiry_ms,
            email,
        });
        storeSpinner.succeed(`Saved to ${ANTIGRAVITY_ACCOUNTS_FILE} (project=${account.project_id})`);
    }
    catch (err) {
        storeSpinner.fail(err.message);
        throw err;
    }
    console.log("");
    console.log(chalk.green("  Antigravity login complete."));
    console.log("");
    console.log(chalk.dim("  Next: register a model and start the daemon. Example:\n" +
        "    clawmoney relay register --cli antigravity --model antigravity-gemini-3-pro\n" +
        "    clawmoney relay start --cli antigravity"));
}
export async function antigravityStatusCommand() {
    const file = loadAccounts();
    if (file.accounts.length === 0) {
        console.log(chalk.dim("No Antigravity accounts stored."));
        console.log(chalk.dim(`  Run "clawmoney antigravity login" to add one.`));
        return;
    }
    console.log(chalk.bold("\n  Antigravity accounts\n"));
    for (let i = 0; i < file.accounts.length; i++) {
        const a = file.accounts[i];
        const expiryStr = a.expiry_ms
            ? new Date(a.expiry_ms).toISOString().replace("T", " ").slice(0, 19)
            : "unknown";
        console.log(`  ${i === 0 ? chalk.bold("●") : " "} ${a.email ?? "(email unknown)"}`);
        console.log(`      project:  ${a.project_id ?? "-"}`);
        console.log(`      expires:  ${expiryStr}`);
        console.log("");
    }
}
