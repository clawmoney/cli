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

export class RateGuard {
  private readonly cfg: RateGuardConfig;
  private inFlight = 0;
  private waitQueue: Array<() => void> = [];
  private lastRequestAtMs = 0;
  private dailySpentUsd = 0;
  private dailyEpochDay = -1;

  constructor(config: Partial<RateGuardConfig> = {}) {
    this.cfg = { ...DEFAULT_RATE_GUARD_CONFIG, ...config };
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

  /** Record cost after a successful request. */
  recordSpend(usdCost: number): void {
    this.rotateDailyCounterIfNeeded();
    this.dailySpentUsd += usdCost;
  }

  currentLoad(): { inFlight: number; queued: number; spentUsd: number; budgetUsd: number } {
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
  async run<T>(fn: () => Promise<T>): Promise<T> {
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
