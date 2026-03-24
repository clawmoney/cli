import { logger } from "./logger.js";
export class Poller {
    config;
    onServiceCall;
    isWsConnected;
    timer = null;
    stopping = false;
    constructor(config, onServiceCall, isWsConnected) {
        this.config = config;
        this.onServiceCall = onServiceCall;
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
            const tasks = data.tasks ?? [];
            if (tasks.length > 0) {
                logger.info(`Poll: received ${tasks.length} pending task(s)`);
            }
            for (const task of tasks) {
                this.onServiceCall(task);
            }
        }
        catch (err) {
            logger.error("Poll error:", err);
        }
    }
}
