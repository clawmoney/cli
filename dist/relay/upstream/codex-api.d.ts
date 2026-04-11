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
