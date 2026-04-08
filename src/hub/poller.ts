import type {
  ProviderConfig,
  ServiceCallEvent,
  EscrowTaskEvent,
  PendingTasksResponse,
} from "./types.js";
import { logger } from "./logger.js";

export type ServiceCallCallback = (event: ServiceCallEvent) => void;
export type EscrowTaskCallback = (task: EscrowTaskEvent) => void;

export class Poller {
  private config: ProviderConfig;
  private onServiceCall: ServiceCallCallback;
  private onEscrowTask: EscrowTaskCallback;
  private isWsConnected: () => boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(
    config: ProviderConfig,
    onServiceCall: ServiceCallCallback,
    onEscrowTask: EscrowTaskCallback,
    isWsConnected: () => boolean
  ) {
    this.config = config;
    this.onServiceCall = onServiceCall;
    this.onEscrowTask = onEscrowTask;
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

      const data = (await resp.json()) as PendingTasksResponse;

      // Instant service calls
      const serviceCalls = data.service_calls ?? [];
      if (serviceCalls.length > 0) {
        logger.info(`Poll: ${serviceCalls.length} pending service call(s)`);
        for (const call of serviceCalls) {
          this.onServiceCall(call);
        }
      }

      // Escrow tasks (multi-submission mode, funded) — only if auto_accept is enabled
      const escrowTasks = (data.escrow_tasks ?? []).filter((t) => t.mode === "multi" && t.funded);
      if (escrowTasks.length > 0) {
        if (this.config.provider.auto_accept) {
          logger.info(`Auto-accepting ${escrowTasks.length} escrow task(s)`);
          for (const task of escrowTasks) {
            this.onEscrowTask(task);
          }
        } else {
          logger.info(`Poll: ${escrowTasks.length} open escrow task(s) (auto_accept off, skipping)`);
        }
      }
    } catch (err) {
      logger.error("Poll error:", err);
    }
  }
}
