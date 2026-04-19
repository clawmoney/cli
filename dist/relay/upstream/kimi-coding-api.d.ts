/**
 * Kimi Code (Moonshot Kimi Coding Plan) adapter.
 *
 * Supports three credential sources, in order of preference:
 *
 *   1. kimi-cli's native OAuth store at ~/.kimi/credentials/kimi-code.json
 *      (populated by `kimi login`; refreshed against auth.kimi.com).
 *   2. An OpenClaw api_key profile (provider="kimi") — static Bearer from
 *      `openclaw onboard --auth-choice kimi-code-api-key`.
 *   3. `KIMI_API_KEY` env var — static Bearer for providers who want to
 *      ship their own key without involving kimi-cli or openclaw.
 *
 * Wire is OpenAI-compatible (/chat/completions + SSE), just like the
 * moonshot / openai / zai passthrough specs. The wrinkles on top of
 * vanilla passthrough are OAuth-specific:
 *
 *   - Token auto-refresh against https://auth.kimi.com/api/oauth/token
 *     (standard OAuth2 refresh_token grant, client_id
 *     17e5f671-d194-4dfb-9706-5516cb48c098 — same value the kimi-cli
 *     public binary ships with).
 *   - Refreshed tokens written back to the same file kimi-cli reads, so
 *     our relay daemon and a concurrent `kimi` TUI on the same machine
 *     stay in sync instead of fighting over token state.
 *   - Moonshot-flavored fingerprint headers (X-Msh-Platform, -Version,
 *     -Device-Id, etc.) — matches what a real kimi-cli sends so upstream
 *     fraud detection doesn't flag relay traffic as unknown-client.
 *     Device id is read from ~/.kimi/device_id; if the operator hasn't
 *     run kimi-cli locally we synthesize one and persist it (same thing
 *     kimi-cli does on first launch).
 *
 * Source of truth for all the above is
 * https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/auth/oauth.py.
 */
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError } from "./rate-guard.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
export declare function configureKimiCodingRateGuard(config?: RelayRateGuardConfig): void;
export declare function getKimiCodingRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null;
export declare function preflightKimiCodingApi(config?: RelayRateGuardConfig): Promise<void>;
export interface CallKimiCodingApiOptions {
    prompt?: string;
    passthroughBody?: Record<string, unknown>;
    model: string;
    maxTokens?: number;
    onRawEvent?: (rawFrame: string) => void;
}
export declare function callKimiCodingApi(opts: CallKimiCodingApiOptions): Promise<ParsedOutput>;
