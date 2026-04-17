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
import { relayLogger as logger } from "../logger.js";
export const DEFAULT_RATE_GUARD_CONFIG = {
    maxConcurrency: 2,
    quietHoursMaxConcurrency: 1,
    quietHours: [2, 3, 4, 5, 6, 7],
    minRequestGapMs: 500,
    jitterMs: 1500,
    dailyBudgetUsd: 15,
    maxRelayUtilization: 50,
};
export class RateGuardBudgetExceededError extends Error {
    constructor(spent, limit) {
        super(`Daily budget exceeded: $${spent.toFixed(4)} / $${limit.toFixed(2)}`);
        this.name = "RateGuardBudgetExceededError";
    }
}
export class RateGuardRelayUtilizationExceededError extends Error {
    constructor(used, limit, resetMins) {
        super(`Relay utilization quota reached: ${used.toFixed(1)}% / ${limit}% of 5h window used by relay (resets in ${resetMins}min)`);
        this.name = "RateGuardRelayUtilizationExceededError";
    }
}
/**
 * Thrown when the rate-guard is in a hard cooldown after observing a real
 * upstream 429. The `untilMs` field is an absolute UNIX ms timestamp — after
 * that point the guard will stop throwing and new requests go through again.
 */
export class RateGuardCooldownError extends Error {
    untilMs;
    reason;
    constructor(untilMs, reason) {
        const seconds = Math.max(0, Math.round((untilMs - Date.now()) / 1000));
        super(`Rate-guard cooldown (${reason}): ${seconds}s until reset (until ${new Date(untilMs).toISOString()})`);
        this.name = "RateGuardCooldownError";
        this.untilMs = untilMs;
        this.reason = reason;
    }
}
export class RateGuard {
    cfg;
    inFlight = 0;
    waitQueue = [];
    lastRequestAtMs = 0;
    dailySpentUsd = 0;
    dailyEpochDay = -1;
    // Upstream-imposed cooldown — we got a 429, don't send anything else
    // until this timestamp.
    cooldownUntilMs = 0;
    cooldownReason = "";
    // Rolling 5h session window surfaced by Anthropic headers.
    sessionWindow = null;
    // Relay utilization tracking — accumulated delta of session_window
    // utilization across relay requests within the current 5h window.
    // Resets when the window resets (endMs changes).
    relayWindowUsed = 0; // accumulated relay % (0-100)
    relayWindowEndMs = 0; // which window we're tracking
    lastSeenUtilization = null; // for delta computation
    constructor(config = {}) {
        this.cfg = { ...DEFAULT_RATE_GUARD_CONFIG, ...config };
    }
    /** Record an upstream-imposed cooldown. Called after parsing a real 429. */
    triggerCooldown(untilMs, reason) {
        if (untilMs <= Date.now())
            return;
        // Never shrink an existing cooldown — always take the later reset time.
        if (untilMs > this.cooldownUntilMs) {
            this.cooldownUntilMs = untilMs;
            this.cooldownReason = reason;
            const seconds = Math.round((untilMs - Date.now()) / 1000);
            logger.warn(`[rate-guard] cooldown engaged (${reason}): ${seconds}s until reset`);
        }
    }
    /** Update the 5h session window tracker from parsed upstream headers.
     *  Also accumulates relay's own utilization delta for quota enforcement. */
    setSessionWindow(window) {
        // Detect window reset — if endMs changed, we're in a new window.
        if (window.endMs !== this.relayWindowEndMs) {
            if (this.relayWindowEndMs > 0 && this.relayWindowUsed > 0) {
                logger.info(`[rate-guard] relay window reset (previous relay_used=${this.relayWindowUsed.toFixed(1)}%)`);
            }
            this.relayWindowUsed = 0;
            this.relayWindowEndMs = window.endMs;
            this.lastSeenUtilization = null;
        }
        // Compute relay delta: how much utilization increased since last observation.
        // This is called AFTER each relay request, so the delta is (approximately)
        // the utilization cost of that one relay request. If the provider was also
        // using the account directly during this request, the delta includes their
        // usage too — accepted trade-off (see design discussion).
        if (typeof window.utilization === "number" &&
            this.lastSeenUtilization !== null) {
            const delta = window.utilization - this.lastSeenUtilization;
            if (delta > 0) {
                this.relayWindowUsed += delta;
            }
        }
        this.lastSeenUtilization = window.utilization ?? null;
        this.sessionWindow = window;
        const mins = Math.round((window.endMs - Date.now()) / 60_000);
        logger.info(`[rate-guard] session window: ${window.utilization ?? "?"}% used (relay_used=${this.relayWindowUsed.toFixed(1)}%/${this.cfg.maxRelayUtilization}%), resets in ${mins}min (status=${window.status ?? "unknown"})`);
    }
    getSessionWindow() {
        if (!this.sessionWindow)
            return null;
        if (this.sessionWindow.endMs <= Date.now()) {
            this.sessionWindow = null;
            return null;
        }
        return this.sessionWindow;
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
    /** Check whether a new request would exceed the daily budget or relay utilization cap. */
    checkBudget() {
        this.rotateDailyCounterIfNeeded();
        if (this.dailySpentUsd >= this.cfg.dailyBudgetUsd) {
            throw new RateGuardBudgetExceededError(this.dailySpentUsd, this.cfg.dailyBudgetUsd);
        }
        // Check relay utilization cap against 5h window.
        // Only enforce if we've seen at least one session window update
        // (otherwise we don't know the utilization yet — fail open).
        if (this.relayWindowEndMs > 0 &&
            this.relayWindowUsed >= this.cfg.maxRelayUtilization) {
            const resetMins = Math.max(0, Math.round((this.relayWindowEndMs - Date.now()) / 60_000));
            throw new RateGuardRelayUtilizationExceededError(this.relayWindowUsed, this.cfg.maxRelayUtilization, resetMins);
        }
    }
    /** Check upstream-imposed cooldown. Throws RateGuardCooldownError if still cooling. */
    checkCooldown() {
        if (this.cooldownUntilMs > 0 && Date.now() < this.cooldownUntilMs) {
            throw new RateGuardCooldownError(this.cooldownUntilMs, this.cooldownReason);
        }
        // Auto-clear once the reset time has passed.
        if (this.cooldownUntilMs > 0 && Date.now() >= this.cooldownUntilMs) {
            logger.info(`[rate-guard] cooldown cleared (${this.cooldownReason})`);
            this.cooldownUntilMs = 0;
            this.cooldownReason = "";
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
            cooldownUntilMs: this.cooldownUntilMs,
            cooldownReason: this.cooldownReason,
            sessionWindow: this.getSessionWindow(),
            relayWindowUsed: this.relayWindowUsed,
            maxRelayUtilization: this.cfg.maxRelayUtilization,
        };
    }
    /**
     * Wrap an upstream call. Blocks until:
     *   - we're not in an upstream 429 cooldown
     *   - daily budget is not exhausted
     *   - concurrency slot is available
     *   - min request gap (+jitter) has elapsed since previous release
     * Throws RateGuardCooldownError / RateGuardBudgetExceededError as appropriate.
     */
    async run(fn) {
        this.checkCooldown();
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
