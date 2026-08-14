/**
 * Grok Build (xAI SuperGrok / xAI OIDC) relay adapter.
 *
 * Source of truth (2026-08-14, xai-org/grok-build HEAD):
 *   crates/codegen/xai-grok-env/src/lib.rs
 *     PRODUCTION cli_chat_proxy_base_url = https://cli-chat-proxy.grok.com/v1
 *   crates/codegen/xai-grok-sampler/src/client.rs
 *     POST {base}/chat/completions  (OpenAI-compat SSE)
 *     headers: Authorization Bearer, User-Agent grok-shell/{ver} ({os}; {arch}),
 *              x-grok-client-version, x-grok-client-identifier=grok-shell,
 *              x-grok-conv-id / req-id / model-override / session-id / agent-id
 *   crates/codegen/xai-grok-http/src/lib.rs
 *     x-grok-client-mode = interactive | headless
 *   crates/codegen/xai-grok-shell/src/auth/oidc/protocol.rs
 *     discover {issuer}/.well-known/openid-configuration
 *     POST token_endpoint grant_type=refresh_token + client_id
 *     access_token persisted as the `key` field in ~/.grok/auth.json
 *
 * Do NOT send SuperGrok traffic to api.x.ai — that is the pay-per-token
 * API. Grok Build's official CLI talks to cli-chat-proxy.grok.com.
 */
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError } from "./rate-guard.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
export declare function configureGrokRateGuard(config?: RelayRateGuardConfig): void;
export declare function getGrokRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null;
export declare function preflightGrokApi(config?: RelayRateGuardConfig): Promise<void>;
export interface CallGrokApiOptions {
    prompt?: string;
    passthroughBody?: Record<string, unknown>;
    model: string;
    maxTokens?: number;
    onRawEvent?: (rawFrame: string) => void;
    sessionKey?: string;
}
export declare function callGrokApi(opts: CallGrokApiOptions): Promise<ParsedOutput>;
