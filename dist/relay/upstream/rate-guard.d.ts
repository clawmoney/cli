/**
 * Rate-guard: anti-ban safety net for api-mode relay.
 *
 * Provider accounts are real human subscriptions (Claude Max etc.) — the
 * goal is to look like the Provider's own normal use pattern, not a bot.
 *
 * Three layers of protection:
 *   1. Hard concurrency cap (≤ 2 by default) — waits in queue, never rejects.
 *   2. Jittered min-gap between consecutive requests.
 *   3. Quiet hours: at night in the Provider's local time zone, downgrade
 *      to 1 concurrent request (or pause entirely).
 *   4. Daily budget: stop accepting once daily-accumulated cost exceeds a
 *      configured cap (reset at local midnight).
 *
 * All of these are configurable per-provider but default to conservative
 * values known to be safe from real-user observation.
 */
export interface RateGuardConfig {
    /** Hard concurrency ceiling during active hours. Default 2. */
    maxConcurrency: number;
    /** Concurrency during quiet hours (night). Default 1. */
    quietHoursMaxConcurrency: number;
    /** Local hours [0-23] treated as "night". Default [2..8). */
    quietHours: number[];
    /** Minimum gap (ms) between two consecutive upstream requests. Default 500ms. */
    minRequestGapMs: number;
    /** Random jitter added on top of min gap. Default 1500ms. */
    jitterMs: number;
    /** Hard daily cost cap in USD. Default 15. */
    dailyBudgetUsd: number;
}
export declare const DEFAULT_RATE_GUARD_CONFIG: RateGuardConfig;
export declare class RateGuardBudgetExceededError extends Error {
    constructor(spent: number, limit: number);
}
export declare class RateGuard {
    private readonly cfg;
    private inFlight;
    private waitQueue;
    private lastRequestAtMs;
    private dailySpentUsd;
    private dailyEpochDay;
    constructor(config?: Partial<RateGuardConfig>);
    private currentMaxConcurrency;
    private rotateDailyCounterIfNeeded;
    /** Check whether a new request would exceed the daily budget. */
    checkBudget(): void;
    /** Record cost after a successful request. */
    recordSpend(usdCost: number): void;
    currentLoad(): {
        inFlight: number;
        queued: number;
        spentUsd: number;
        budgetUsd: number;
    };
    /**
     * Wrap an upstream call. Blocks until:
     *   - concurrency slot is available
     *   - min request gap (+jitter) has elapsed since previous release
     * Throws RateGuardBudgetExceededError if the daily cap is already hit.
     */
    run<T>(fn: () => Promise<T>): Promise<T>;
    private acquireSlot;
    private releaseSlot;
    private awaitGap;
}
