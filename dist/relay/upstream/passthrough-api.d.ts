/**
 * Shared passthrough adapter for API-key-authenticated OpenAI-compatible
 * providers.
 *
 * Used by cli_types whose upstream is a static Bearer-auth REST endpoint
 * speaking the OpenAI `/v1/chat/completions` wire: zai (Z.AI / GLM),
 * moonshot, kimi-coding, qwen-cp, plus the "classic" openai API-key mode.
 *
 * Shape mirrors gemini-api.ts minus the OAuth plumbing — there's no token
 * refresh, no per-account fingerprinting, no 5h window signal. The rate-guard
 * is still honored so provider-configured concurrency / daily budget caps
 * apply the same way they do for OAuth adapters.
 *
 * Credential source, in order:
 *   1. Openclaw api_key profile (provider field matches spec.openclawProvider)
 *   2. Environment variable named by spec.envVarName
 *
 * Anything more (clawmoney-managed keystore, per-request key rotation) is
 * out of scope here; users who need that today set the env var before
 * launching the daemon.
 */
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard, RateGuardBudgetExceededError, RateGuardCooldownError } from "./rate-guard.js";
export { RateGuardBudgetExceededError, RateGuardCooldownError };
/**
 * Describes one passthrough upstream. One `PassthroughSpec` corresponds to
 * one clawmoney cli_type.
 */
export interface PassthroughSpec {
    /** clawmoney cli_type identifier (matches `RelayRequest.cli_type`). */
    cliType: string;
    /** OpenClaw provider id used for api_key profile lookup. */
    openclawProvider: string;
    /** Env var name to consult when openclaw profile is missing. */
    envVarName: string;
    /** Base URL of the upstream (no trailing slash). */
    baseUrl: string;
    /**
     * Wire family. "openai-completions" means buyer body is forwarded to
     * `${baseUrl}/chat/completions`. Future values (e.g. "anthropic-messages")
     * could be added, but for Step 2a every passthrough target speaks OpenAI.
     */
    api: "openai-completions";
    /**
     * Optional default rate-guard tweaks. Most upstreams are fine with the
     * generic defaults; add per-provider overrides here if a host is known
     * to rate-limit harder than the default 2-concurrency floor.
     */
    rateGuardOverrides?: Partial<RelayRateGuardConfig>;
    /**
     * Human-readable display label for log lines. Purely cosmetic.
     */
    label?: string;
}
export declare function registerPassthroughSpec(spec: PassthroughSpec): void;
export declare function getPassthroughSpec(cliType: string): PassthroughSpec | null;
export declare function listPassthroughCliTypes(): string[];
export declare function configurePassthroughRateGuard(cliType: string, config?: RelayRateGuardConfig): void;
export declare function getPassthroughRateGuardSnapshot(cliType: string): ReturnType<RateGuard["currentLoad"]> | null;
export declare function preflightPassthroughApi(cliType: string, config?: RelayRateGuardConfig): Promise<void>;
export interface CallPassthroughApiOptions {
    cliType: string;
    /** Buyer-supplied prompt (template mode) — ignored when passthroughBody is set. */
    prompt?: string;
    /** Buyer-supplied full /v1/chat/completions body (passthrough mode). */
    passthroughBody?: Record<string, unknown>;
    /** Canonical model id for routing + pricing. Must match API_PRICES. */
    model: string;
    /** When true, upstream is called with stream:true and SSE is pushed to onRawEvent. */
    onRawEvent?: (rawFrame: string) => void;
    maxTokens?: number;
}
export declare function callPassthroughApi(opts: CallPassthroughApiOptions): Promise<ParsedOutput>;
