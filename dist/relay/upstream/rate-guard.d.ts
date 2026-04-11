/**
 * Rate-guard: anti-ban safety net for api-mode relay.
 *
 * Provider accounts are real human subscriptions (Claude Max etc.) — the
 * goal is to look like the Provider's own normal use pattern, not a bot.
 *
 * Protection layers:
 *   1. Hard concurrency cap (≤ 2 by default) — waits in queue, never rejects.
 *   2. Jittered min-gap between consecutive requests.
 *   3. Quiet hours: at night in the Provider's local time zone, downgrade
 *      to 1 concurrent request (or pause entirely).
 *   4. Daily budget: stop accepting once daily-accumulated cost exceeds a
 *      configured cap (reset at local midnight).
 *   5. Upstream rate-limit cooldown: when we see a real 429 from the
 *      upstream, remember the reset time and refuse all further requests
 *      until that point — so we don't keep hammering an already-limited
 *      account and risk a deeper ban.
 *   6. Anthropic 5-hour session window tracking: when upstream headers
 *      expose the rolling 5h window state, we track it so future work can
 *      predictively slow down before the window gets saturated.
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
/**
 * Thrown when the rate-guard is in a hard cooldown after observing a real
 * upstream 429. The `untilMs` field is an absolute UNIX ms timestamp — after
 * that point the guard will stop throwing and new requests go through again.
 */
export declare class RateGuardCooldownError extends Error {
    readonly untilMs: number;
    readonly reason: string;
    constructor(untilMs: number, reason: string);
}
/** Tracks the rolling 5-hour session window that Anthropic surfaces in response headers. */
export interface SessionWindow {
    /** Window end (= reset time) as UNIX ms. */
    endMs: number;
    /** Window start (= endMs - 5h) as UNIX ms. */
    startMs: number;
    /** 0-100 if upstream tells us the utilization, otherwise undefined. */
    utilization?: number;
    /** "ok" | "surpassed" | "rejected" | whatever the upstream header says. */
    status?: string;
}
export declare class RateGuard {
    private readonly cfg;
    private inFlight;
    private waitQueue;
    private lastRequestAtMs;
    private dailySpentUsd;
    private dailyEpochDay;
    private cooldownUntilMs;
    private cooldownReason;
    private sessionWindow;
    constructor(config?: Partial<RateGuardConfig>);
    /** Record an upstream-imposed cooldown. Called after parsing a real 429. */
    triggerCooldown(untilMs: number, reason: string): void;
    /** Update the 5h session window tracker from parsed upstream headers. */
    setSessionWindow(window: SessionWindow): void;
    getSessionWindow(): SessionWindow | null;
    private currentMaxConcurrency;
    private rotateDailyCounterIfNeeded;
    /** Check whether a new request would exceed the daily budget. */
    checkBudget(): void;
    /** Check upstream-imposed cooldown. Throws RateGuardCooldownError if still cooling. */
    checkCooldown(): void;
    /** Record cost after a successful request. */
    recordSpend(usdCost: number): void;
    currentLoad(): {
        inFlight: number;
        queued: number;
        spentUsd: number;
        budgetUsd: number;
        cooldownUntilMs: number;
        cooldownReason: string;
        sessionWindow: SessionWindow | null;
    };
    /**
     * Wrap an upstream call. Blocks until:
     *   - we're not in an upstream 429 cooldown
     *   - daily budget is not exhausted
     *   - concurrency slot is available
     *   - min request gap (+jitter) has elapsed since previous release
     * Throws RateGuardCooldownError / RateGuardBudgetExceededError as appropriate.
     */
    run<T>(fn: () => Promise<T>): Promise<T>;
    private acquireSlot;
    private releaseSlot;
    private awaitGap;
}
