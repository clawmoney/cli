import { logger } from "./logger.js";
export class Poller {
    config;
    onServiceCall;
    onEscrowTask;
    isWsConnected;
    timer = null;
    stopping = false;
    constructor(config, onServiceCall, onEscrowTask, isWsConnected) {
        this.config = config;
        this.onServiceCall = onServiceCall;
        this.onEscrowTask = onEscrowTask;
        this.isWsConnected = isWsConnected;
    }
    start() {
        this.stopping = false;
        this.scheduleNext();
    }
    stop() {
        this.stopping = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    scheduleNext() {
        if (this.stopping)
            return;
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
    async poll() {
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
            const data = (await resp.json());
            // Instant service calls
            const serviceCalls = data.service_calls ?? [];
            if (serviceCalls.length > 0) {
                logger.info(`Poll: ${serviceCalls.length} pending service call(s)`);
                for (const call of serviceCalls) {
                    this.onServiceCall(call);
                }
            }
            // Escrow tasks (multi-submission mode, funded)
            const escrowTasks = (data.escrow_tasks ?? []).filter((t) => t.mode === "multi" && t.funded);
            if (escrowTasks.length > 0) {
                logger.info(`Poll: ${escrowTasks.length} open escrow task(s)`);
                for (const task of escrowTasks) {
                    this.onEscrowTask(task);
                }
            }
        }
        catch (err) {
            logger.error("Poll error:", err);
        }
    }
}
