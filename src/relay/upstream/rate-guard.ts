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

export const DEFAULT_RATE_GUARD_CONFIG: RateGuardConfig = {
  maxConcurrency: 2,
  quietHoursMaxConcurrency: 1,
  quietHours: [2, 3, 4, 5, 6, 7],
  minRequestGapMs: 500,
  jitterMs: 1500,
  dailyBudgetUsd: 15,
};

export class RateGuardBudgetExceededError extends Error {
  constructor(spent: number, limit: number) {
    super(`Daily budget exceeded: $${spent.toFixed(4)} / $${limit.toFixed(2)}`);
    this.name = "RateGuardBudgetExceededError";
  }
}

/**
 * Thrown when the rate-guard is in a hard cooldown after observing a real
 * upstream 429. The `untilMs` field is an absolute UNIX ms timestamp — after
 * that point the guard will stop throwing and new requests go through again.
 */
export class RateGuardCooldownError extends Error {
  readonly untilMs: number;
  readonly reason: string;
  constructor(untilMs: number, reason: string) {
    const seconds = Math.max(0, Math.round((untilMs - Date.now()) / 1000));
    super(
      `Rate-guard cooldown (${reason}): ${seconds}s until reset (until ${new Date(untilMs).toISOString()})`
    );
    this.name = "RateGuardCooldownError";
    this.untilMs = untilMs;
    this.reason = reason;
  }
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

export class RateGuard {
  private readonly cfg: RateGuardConfig;
  private inFlight = 0;
  private waitQueue: Array<() => void> = [];
  private lastRequestAtMs = 0;
  private dailySpentUsd = 0;
  private dailyEpochDay = -1;
  // Upstream-imposed cooldown — we got a 429, don't send anything else
  // until this timestamp.
  private cooldownUntilMs = 0;
  private cooldownReason = "";
  // Rolling 5h session window surfaced by Anthropic headers.
  private sessionWindow: SessionWindow | null = null;

  constructor(config: Partial<RateGuardConfig> = {}) {
    this.cfg = { ...DEFAULT_RATE_GUARD_CONFIG, ...config };
  }

  /** Record an upstream-imposed cooldown. Called after parsing a real 429. */
  triggerCooldown(untilMs: number, reason: string): void {
    if (untilMs <= Date.now()) return;
    // Never shrink an existing cooldown — always take the later reset time.
    if (untilMs > this.cooldownUntilMs) {
      this.cooldownUntilMs = untilMs;
      this.cooldownReason = reason;
      const seconds = Math.round((untilMs - Date.now()) / 1000);
      logger.warn(
        `[rate-guard] cooldown engaged (${reason}): ${seconds}s until reset`
      );
    }
  }

  /** Update the 5h session window tracker from parsed upstream headers. */
  setSessionWindow(window: SessionWindow): void {
    this.sessionWindow = window;
    const mins = Math.round((window.endMs - Date.now()) / 60_000);
    logger.info(
      `[rate-guard] session window: ${window.utilization ?? "?"}% used, resets in ${mins}min (status=${window.status ?? "unknown"})`
    );
  }

  getSessionWindow(): SessionWindow | null {
    if (!this.sessionWindow) return null;
    if (this.sessionWindow.endMs <= Date.now()) {
      this.sessionWindow = null;
      return null;
    }
    return this.sessionWindow;
  }

  private currentMaxConcurrency(): number {
    const hour = new Date().getHours();
    return this.cfg.quietHours.includes(hour)
      ? this.cfg.quietHoursMaxConcurrency
      : this.cfg.maxConcurrency;
  }

  private rotateDailyCounterIfNeeded(): void {
    // Use local-time epoch-day so the counter resets at the Provider's midnight.
    const now = new Date();
    const localDay = Math.floor(
      (now.getTime() - now.getTimezoneOffset() * 60_000) / 86_400_000
    );
    if (localDay !== this.dailyEpochDay) {
      if (this.dailyEpochDay !== -1) {
        logger.info(
          `[rate-guard] daily budget reset (prior day spent $${this.dailySpentUsd.toFixed(4)})`
        );
      }
      this.dailyEpochDay = localDay;
      this.dailySpentUsd = 0;
    }
  }

  /** Check whether a new request would exceed the daily budget. */
  checkBudget(): void {
    this.rotateDailyCounterIfNeeded();
    if (this.dailySpentUsd >= this.cfg.dailyBudgetUsd) {
      throw new RateGuardBudgetExceededError(
        this.dailySpentUsd,
        this.cfg.dailyBudgetUsd
      );
    }
  }

  /** Check upstream-imposed cooldown. Throws RateGuardCooldownError if still cooling. */
  checkCooldown(): void {
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
  recordSpend(usdCost: number): void {
    this.rotateDailyCounterIfNeeded();
    this.dailySpentUsd += usdCost;
  }

  currentLoad(): {
    inFlight: number;
    queued: number;
    spentUsd: number;
    budgetUsd: number;
    cooldownUntilMs: number;
    cooldownReason: string;
    sessionWindow: SessionWindow | null;
  } {
    return {
      inFlight: this.inFlight,
      queued: this.waitQueue.length,
      spentUsd: this.dailySpentUsd,
      budgetUsd: this.cfg.dailyBudgetUsd,
      cooldownUntilMs: this.cooldownUntilMs,
      cooldownReason: this.cooldownReason,
      sessionWindow: this.getSessionWindow(),
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
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.checkCooldown();
    this.checkBudget();
    await this.acquireSlot();
    try {
      await this.awaitGap();
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < this.currentMaxConcurrency()) {
      this.inFlight++;
      return;
    }
    logger.info(
      `[rate-guard] concurrency cap reached (${this.inFlight}/${this.currentMaxConcurrency()}), queuing`
    );
    await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    this.inFlight++;
  }

  private releaseSlot(): void {
    this.inFlight--;
    this.lastRequestAtMs = Date.now();
    const next = this.waitQueue.shift();
    if (next) next();
  }

  private async awaitGap(): Promise<void> {
    if (this.lastRequestAtMs === 0) return;
    const elapsed = Date.now() - this.lastRequestAtMs;
    const required = this.cfg.minRequestGapMs + Math.random() * this.cfg.jitterMs;
    const wait = required - elapsed;
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
