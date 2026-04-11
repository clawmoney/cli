/**
 * Direct chatgpt.com upstream for Codex (ChatGPT Plus/Pro) OAuth subscriptions.
 *
 * Mirrors claude-api.ts structure exactly: same export shape, same error types,
 * same RateGuard integration, same OAuth refresh + persist-back pattern, same
 * fingerprint file loading, same 5xx retry path, same preflight function.
 *
 * Key differences from claude-api.ts:
 *  - Token source: ~/.codex/auth.json (written by the Codex CLI)
 *  - Upstream: https://chatgpt.com/backend-api/codex/responses (Responses API)
 *  - Request body is OpenAI Responses API shape (input[], instructions, model, store, stream)
 *  - Response is always SSE; we consume it internally and return ParsedOutput
 *  - Session headers: session_id + conversation_id (not x-claude-code-session-id)
 *  - Rate-limit headers: x-codex-primary-* / x-codex-secondary-*
 *  - No per-request device_id/account_uuid metadata — chatgpt-account-id header instead
 */
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError } from "./rate-guard.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
export declare function configureRateGuard(config?: RelayRateGuardConfig): void;
export declare function getRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null;
export declare function preflightCodexApi(config?: RelayRateGuardConfig): Promise<void>;
export interface CallCodexApiOptions {
    prompt: string;
    model: string;
    maxTokens?: number;
}
export declare function callCodexApi(opts: CallCodexApiOptions): Promise<ParsedOutput>;
