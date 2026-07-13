/**
 * Grok Build subscription upstream.
 *
 * Authentication remains owned by the official Grok CLI. We only read the
 * cached access key from ~/.grok/auth.json. When it is near expiry, or the
 * Responses proxy returns 401, we run `grok models` and then re-read the
 * cache. In particular, this module never exchanges or persists the
 * refresh_token itself.
 */
import { fetch } from "undici";
import type { ParsedOutput, RelayRateGuardConfig } from "../types.js";
import { RateGuard } from "./rate-guard.js";
type FetchLike = typeof fetch;
interface GrokApiTestHooks {
    fetch?: FetchLike;
    runModels?: (binaryPath: string) => Promise<void>;
    grokHome?: string;
    now?: () => number;
}
/** Test-only dependency injection. Production callers must not use this. */
export declare function __setGrokApiTestHooks(hooks: GrokApiTestHooks): void;
/** Reset module state between mock tests. */
export declare function __resetGrokApiForTests(): void;
/** Resolve the official CLI even in Finder/launchd's minimal PATH. */
export declare function findGrokBinary(): string | null;
export interface GrokLocalState {
    available: boolean;
    binaryPath: string | null;
    authPresent: boolean;
    authFresh: boolean;
    modelCacheValid: boolean;
    expiresAt?: number;
    hint: string;
}
/** Synchronous setup-wizard probe; it never invokes the CLI or the network. */
export declare function inspectGrokLocalState(model?: string): GrokLocalState;
export declare function configureGrokRateGuard(config?: RelayRateGuardConfig): void;
export declare function getGrokRateGuardSnapshot(): ReturnType<RateGuard["currentLoad"]> | null;
export declare function preflightGrokApi(config?: RelayRateGuardConfig): Promise<void>;
export interface CallGrokApiOptions {
    prompt?: string;
    passthroughBody?: Record<string, unknown>;
    model: string;
    maxTokens?: number;
    stream?: boolean;
    onRawEvent?: (rawFrame: string) => void;
}
export declare function callGrokApi(opts: CallGrokApiOptions): Promise<ParsedOutput>;
export {};
