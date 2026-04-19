/**
 * MiniMax adapter — OAuth Coding Plan + API-key.
 *
 * Unlike the static-key passthrough adapters in passthrough-api.ts, MiniMax
 * supports an OAuth-flavored "Coding Plan" subscription that openclaw
 * captures under provider="minimax-portal". Tokens there have refresh tokens
 * and expiry timestamps — we honor them the same way codex-api.ts honors
 * ChatGPT OAuth.
 *
 * Endpoint shape is OpenAI-compatible (`/v1/chat/completions`), so we reuse
 * the OpenAI SSE wire without the Anthropic /v1/messages complexity — the
 * `/anthropic` route on the same host is available but needs Anthropic-style
 * SSE parsing which is out of scope for MVP. Setting
 * `MINIMAX_USE_ANTHROPIC_PATH=1` is reserved for a future switch.
 *
 * Credential source order:
 *   1. OpenClaw oauth profile provider="minimax-portal"
 *   2. Openclaw api_key profile provider="minimax"
 *   3. Env var MINIMAX_API_KEY
 *
 * Refresh: best-effort standard OAuth2 refresh against `{baseUrl}/oauth/token`
 * with grant_type=refresh_token. If refresh fails we throw a clear error
 * telling the operator to re-run `openclaw onboard --auth-choice minimax-*-oauth`.
 */
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError } from "./rate-guard.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
export declare function configureMinimaxRateGuard(config?: RelayRateGuardConfig): void;
export declare function getMinimaxRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null;
export declare function preflightMinimaxApi(config?: RelayRateGuardConfig): Promise<void>;
export interface CallMinimaxApiOptions {
    prompt?: string;
    passthroughBody?: Record<string, unknown>;
    model: string;
    maxTokens?: number;
    onRawEvent?: (rawFrame: string) => void;
}
export declare function callMinimaxApi(opts: CallMinimaxApiOptions): Promise<ParsedOutput>;
