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
    }
    async poll() {
        const url = `${this.config.provider.api_base_url}/market/tasks/pending`;
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
                    const normalized = normalizeServiceCall(call);
                    if (normalized) {
                        this.onServiceCall(normalized);
                    }
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
                }
                else {
                    logger.info(`Poll: ${escrowTasks.length} open escrow task(s) (auto_accept off, skipping)`);
                }
            }
        }
        catch (err) {
            logger.error("Poll error:", err);
        }
    }
}
function normalizeServiceCall(raw) {
    const obj = raw;
    if (obj.event === "service_call" && stringValue(obj.order_id) && stringValue(obj.skill)) {
        return raw;
    }
    const id = stringValue(obj.order_id) ?? stringValue(obj.id);
    const skill = stringValue(obj.skill) ?? stringValue(obj.skill_name);
    if (!id || !skill) {
        return null;
    }
    return {
        event: "service_call",
        order_id: id,
        from: stringValue(obj.from) ?? stringValue(obj.caller_agent_id) ?? "poller",
        skill,
        category: stringValue(obj.category) ?? "",
        input: objectValue(obj.input) ?? objectValue(obj.input_data) ?? {},
        price: numberValue(obj.price) ?? 0,
        timeout: numberValue(obj.timeout) ?? 300,
        payment_method: stringValue(obj.payment_method) ?? "ledger",
    };
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function numberValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
