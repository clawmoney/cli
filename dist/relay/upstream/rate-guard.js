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
import { relayLogger as logger } from "../logger.js";
export const DEFAULT_RATE_GUARD_CONFIG = {
    maxConcurrency: 2,
    quietHoursMaxConcurrency: 1,
    quietHours: [2, 3, 4, 5, 6, 7],
    minRequestGapMs: 500,
    jitterMs: 1500,
    dailyBudgetUsd: 15,
};
export class RateGuardBudgetExceededError extends Error {
    constructor(spent, limit) {
        super(`Daily budget exceeded: $${spent.toFixed(4)} / $${limit.toFixed(2)}`);
        this.name = "RateGuardBudgetExceededError";
    }
}
export class RateGuard {
    cfg;
    inFlight = 0;
    waitQueue = [];
    lastRequestAtMs = 0;
    dailySpentUsd = 0;
    dailyEpochDay = -1;
    constructor(config = {}) {
        this.cfg = { ...DEFAULT_RATE_GUARD_CONFIG, ...config };
    }
    currentMaxConcurrency() {
        const hour = new Date().getHours();
        return this.cfg.quietHours.includes(hour)
            ? this.cfg.quietHoursMaxConcurrency
            : this.cfg.maxConcurrency;
    }
    rotateDailyCounterIfNeeded() {
        // Use local-time epoch-day so the counter resets at the Provider's midnight.
        const now = new Date();
        const localDay = Math.floor((now.getTime() - now.getTimezoneOffset() * 60_000) / 86_400_000);
        if (localDay !== this.dailyEpochDay) {
            if (this.dailyEpochDay !== -1) {
                logger.info(`[rate-guard] daily budget reset (prior day spent $${this.dailySpentUsd.toFixed(4)})`);
            }
            this.dailyEpochDay = localDay;
            this.dailySpentUsd = 0;
        }
    }
    /** Check whether a new request would exceed the daily budget. */
    checkBudget() {
        this.rotateDailyCounterIfNeeded();
        if (this.dailySpentUsd >= this.cfg.dailyBudgetUsd) {
            throw new RateGuardBudgetExceededError(this.dailySpentUsd, this.cfg.dailyBudgetUsd);
        }
    }
    /** Record cost after a successful request. */
    recordSpend(usdCost) {
        this.rotateDailyCounterIfNeeded();
        this.dailySpentUsd += usdCost;
    }
    currentLoad() {
        return {
            inFlight: this.inFlight,
            queued: this.waitQueue.length,
            spentUsd: this.dailySpentUsd,
            budgetUsd: this.cfg.dailyBudgetUsd,
        };
    }
    /**
     * Wrap an upstream call. Blocks until:
     *   - concurrency slot is available
     *   - min request gap (+jitter) has elapsed since previous release
     * Throws RateGuardBudgetExceededError if the daily cap is already hit.
     */
    async run(fn) {
        this.checkBudget();
        await this.acquireSlot();
        try {
            await this.awaitGap();
            return await fn();
        }
        finally {
            this.releaseSlot();
        }
    }
    async acquireSlot() {
        if (this.inFlight < this.currentMaxConcurrency()) {
            this.inFlight++;
            return;
        }
        logger.info(`[rate-guard] concurrency cap reached (${this.inFlight}/${this.currentMaxConcurrency()}), queuing`);
        await new Promise((resolve) => this.waitQueue.push(resolve));
        this.inFlight++;
    }
    releaseSlot() {
        this.inFlight--;
        this.lastRequestAtMs = Date.now();
        const next = this.waitQueue.shift();
        if (next)
            next();
    }
    async awaitGap() {
        if (this.lastRequestAtMs === 0)
            return;
        const elapsed = Date.now() - this.lastRequestAtMs;
        const required = this.cfg.minRequestGapMs + Math.random() * this.cfg.jitterMs;
        const wait = required - elapsed;
        if (wait > 0) {
            await new Promise((r) => setTimeout(r, wait));
        }
    }
}
