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
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError } from "./rate-guard.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
declare const FINGERPRINT_FILE: string;
export declare function configureGeminiRateGuard(config?: RelayRateGuardConfig): void;
export declare function getGeminiRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null;
export declare function preflightGeminiApi(config?: RelayRateGuardConfig): Promise<void>;
export interface CallGeminiApiOptions {
    prompt: string;
    model: string;
    maxTokens?: number;
}
export declare function callGeminiApi(opts: CallGeminiApiOptions): Promise<ParsedOutput>;
export declare function ensureClawmoneyDir(): void;
export { FINGERPRINT_FILE as GEMINI_FINGERPRINT_FILE };
