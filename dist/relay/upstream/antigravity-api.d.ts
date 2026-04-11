/**
 * Direct Google Code Assist API upstream for Google Antigravity IDE OAuth.
 *
 * Antigravity is Google's agentic IDE (Electron/VSCode fork) that ships with
 * a bundled Google Ultra subscription. It hits the same `cloudcode-pa`
 * `v1internal` family of endpoints as Gemini CLI, but through an entirely
 * separate OAuth client — which means it has its own quota pool. Running an
 * Antigravity daemon alongside a Gemini CLI daemon on the same Google account
 * effectively doubles our Gemini capacity.
 *
 * More importantly, Antigravity is the ONLY path that exposes Anthropic
 * Claude models (`claude-opus-4-6-thinking`, `claude-sonnet-4-6`) via Google
 * OAuth. Ultra subscribers who have no Anthropic subscription can still
 * provide Claude capacity through this daemon.
 *
 * Token source:  ~/.clawmoney/antigravity-accounts.json (written by
 *                `clawmoney antigravity login`)
 * Upstream:      https://daily-cloudcode-pa.sandbox.googleapis.com
 *                → https://autopush-cloudcode-pa.sandbox.googleapis.com
 *                → https://cloudcode-pa.googleapis.com
 *                (first two are the "daily" and "autopush" sandbox tiers the
 *                real Antigravity client hits; prod is the final fallback)
 *
 * References:
 *   - opencode-antigravity-auth (TypeScript reference implementation)
 *   - sub2api/backend/internal/pkg/antigravity (Go reference implementation)
 */
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError } from "./rate-guard.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
export declare const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export declare const ANTIGRAVITY_CLIENT_SECRET: string;
export declare const ANTIGRAVITY_SCOPES: readonly ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/cclog", "https://www.googleapis.com/auth/experimentsandconfigs"];
export declare const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
declare const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
declare const ACCOUNTS_FILE: string;
/**
 * Antigravity OAuth refresh tokens are stored in a JSON array of "accounts".
 * Phase 1 of this integration treats the file as single-account: we read the
 * first entry on boot. Phase 2 (multi-account / rotation) can iterate over
 * the array without changing the on-disk schema.
 */
export interface AntigravityAccount {
    /** Google email, cosmetic only (for logs). */
    email?: string;
    /**
     * Google OAuth refresh token. Long-lived — stays valid until the user
     * revokes the grant on the Google account security page.
     */
    refresh_token: string;
    /** Last access token we cached. May be expired; we refresh on demand. */
    access_token?: string;
    /**
     * Unix ms when the cached access_token expires. 0 if we never fetched one
     * or if the stored value is known to be stale.
     */
    expiry_ms?: number;
    /**
     * cloudaicompanionProject id returned by loadCodeAssist. Required for
     * every request. For workspace accounts we fall back to the shared
     * "rising-fact-p41fc" project id.
     */
    project_id?: string;
    /** Unix ms when this account was added — cosmetic, for ops/debugging. */
    added_at?: number;
}
interface AntigravityAccountsFile {
    version: 1;
    accounts: AntigravityAccount[];
}
export declare function configureAntigravityDispatcher(): void;
export declare function ensureClawmoneyDir(): void;
export declare function loadAccounts(): AntigravityAccountsFile;
export declare function saveAccounts(file: AntigravityAccountsFile): void;
export declare function resolveAntigravityProjectId(accessToken: string): Promise<string>;
export declare function configureAntigravityRateGuard(config?: RelayRateGuardConfig): void;
export declare function getAntigravityRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null;
export declare function preflightAntigravityApi(config?: RelayRateGuardConfig): Promise<void>;
export interface CallAntigravityApiOptions {
    prompt: string;
    model: string;
    maxTokens?: number;
}
export declare function callAntigravityApi(opts: CallAntigravityApiOptions): Promise<ParsedOutput>;
export { ACCOUNTS_FILE as ANTIGRAVITY_ACCOUNTS_FILE, OAUTH_TOKEN_URL };
/**
 * Called by the `antigravity login` command after it exchanges an auth code
 * for tokens. Persists the account, resolves the project ID, and returns the
 * stored record.
 */
export declare function storeNewAntigravityAccount(input: {
    refresh_token: string;
    access_token: string;
    expiry_ms: number;
    email?: string;
}): Promise<AntigravityAccount>;
/**
 * Request OAuth tokens from Google using an authorization code obtained via
 * the browser flow. Exported so the CLI login command can call it.
 */
export declare function exchangeAntigravityAuthCode(input: {
    code: string;
    code_verifier: string;
}): Promise<{
    access_token: string;
    refresh_token: string;
    expiry_ms: number;
}>;
/**
 * Fetch the Google user's email for display / de-duplication. Non-fatal on
 * failure — we'll just store the account without an email label.
 */
export declare function fetchAntigravityUserEmail(accessToken: string): Promise<string | undefined>;
