import type { ProviderConfig, ServiceCallEvent } from "./types.js";
import { logger } from "./logger.js";

export type PollCallback = (event: ServiceCallEvent) => void;

export class Poller {
  private config: ProviderConfig;
  private onServiceCall: PollCallback;
  private isWsConnected: () => boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(
    config: ProviderConfig,
    onServiceCall: PollCallback,
    isWsConnected: () => boolean
  ) {
    this.config = config;
    this.onServiceCall = onServiceCall;
    this.isWsConnected = isWsConnected;
  }

  start(): void {
    this.stopping = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopping) return;

    const interval = this.isWsConnected()
      ? this.config.provider.polling.connected_interval
      : this.config.provider.polling.disconnected_interval;

    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.poll();
      this.scheduleNext();
    }, interval * 1000);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    const url = `${this.config.provider.api_base_url}/hub/tasks/pending`;

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.api_key}`,
          "Content-Type": "application/json",
        },
      });

      if (!resp.ok) {
        if (resp.status !== 404) {
          logger.warn(`Poll failed (${resp.status}): ${await resp.text()}`);
        }
        return;
      }

      const data = (await resp.json()) as { tasks?: ServiceCallEvent[] };
      const tasks = data.tasks ?? [];

      if (tasks.length > 0) {
        logger.info(`Poll: received ${tasks.length} pending task(s)`);
      }

      for (const task of tasks) {
        this.onServiceCall(task);
      }
    } catch (err) {
      logger.error("Poll error:", err);
    }
  }
}
