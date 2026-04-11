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
export declare function antigravityLoginCommand(): Promise<void>;
export declare function antigravityStatusCommand(): Promise<void>;
