/**
 * Direct Anthropic API upstream for Claude Code OAuth subscriptions.
 *
 * Instead of spawning the `claude` CLI for every relay request, this module
 * reuses the OAuth token that the locally-logged-in Claude Code has already
 * obtained, and sends /v1/messages requests directly to api.anthropic.com
 * with the exact Claude Code request shape (captured from claude-cli/2.1.100).
 *
 * Why this exists:
 *   - spawn CLI latency is 1-3s per request; direct HTTP is ~300ms
 *   - CLI mode can't stream; HTTP mode is real SSE
 *   - CLI mode can't saturate concurrency; HTTP mode scales trivially
 *
 * Token is loaded once at startup (from macOS Keychain or ~/.claude) and
 * refreshed in-process when within 3 min of expiry. Refreshed tokens are
 * persisted back to the Keychain so the Provider's real Claude Code stays
 * in sync — otherwise Claude Code would find its refresh_token revoked on
 * next use.
 */
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError } from "./rate-guard.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
export declare function configureRateGuard(config?: RelayRateGuardConfig): void;
export declare function getRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null;
export declare function preflightClaudeApi(config?: RelayRateGuardConfig): Promise<void>;
export interface CallClaudeApiOptions {
    prompt: string;
    model: string;
    maxTokens?: number;
    onRawEvent?: (rawFrame: string) => void;
}
export declare function callClaudeApi(opts: CallClaudeApiOptions): Promise<ParsedOutput>;
export interface CallClaudeApiPassthroughOptions {
    clientBody: Record<string, unknown>;
    model: string;
    clientBeta?: string;
    onRawEvent?: (rawFrame: string) => void;
}
export declare function callClaudeApiPassthrough(opts: CallClaudeApiPassthroughOptions): Promise<ParsedOutput>;
