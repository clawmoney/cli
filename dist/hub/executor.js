import { isProcessed, markProcessed } from "./dedup.js";
import { logger } from "./logger.js";
import { getSkill } from "../task/skills/index.js";
const TIMEOUT_BUFFER_S = 15;
// ── Executor ──
export class Executor {
    config;
    send;
    activeTasks = new Set();
    constructor(config, send) {
        this.config = config;
        this.send = send;
    }
    get activeCount() {
        return this.activeTasks.size;
    }
    /**
     * Fire a progress update for an in-flight order. The buyer-facing UI
     * (clawmoney-web playground) polls /market/orders/{id} and reads the
     * `progress` field that backend Redis-caches from these events.
     * Best-effort: failed sends are non-fatal (the UI just sees a slightly
     * stale stage label until the next progress fires).
     */
    sendProgress(orderId, text) {
        try {
            this.send({ event: "progress", order_id: orderId, progress: text });
        }
        catch {
            // Ignore — WS may be reconnecting; the next progress event will
            // pick up where we left off.
        }
    }
    handleServiceCall(call) {
        if (isProcessed(call.order_id)) {
            logger.info(`Skipping duplicate order: ${call.order_id}`);
            return;
        }
        if (this.activeTasks.size >= this.config.provider.max_concurrent) {
            logger.warn(`Rejecting order ${call.order_id}: at max concurrency (${this.config.provider.max_concurrent})`);
            this.send({
                event: "deliver",
                order_id: call.order_id,
                error: "Provider is at maximum capacity. Please try again later.",
            });
            markProcessed(call.order_id);
            return;
        }
        markProcessed(call.order_id);
        this.activeTasks.add(call.order_id);
        logger.info(`Processing order=${call.order_id} skill="${call.skill}" from=${call.from}`);
        this.executeTask(call).catch((err) => {
            logger.error(`Unhandled error in executeTask for ${call.order_id}:`, err);
        });
    }
    handleEscrowTask(task) {
        const dedupKey = `escrow:${task.id}`;
        if (isProcessed(dedupKey))
            return;
        markProcessed(dedupKey);
        logger.warn(`Ignoring marketplace multi task=${task.id.slice(0, 8)} "${task.title}": external CLI spawning is disabled`);
    }
    handleTestCall(call) {
        logger.info(`Test call received: order=${call.order_id}`);
        const response = {
            event: "test_response",
            order_id: call.order_id,
            output: {
                echo: call.input,
                provider_status: "ok",
                active_tasks: this.activeTasks.size,
                max_concurrent: this.config.provider.max_concurrent,
            },
        };
        this.send(response);
    }
    async executeTask(call) {
        try {
            const timeoutS = Math.max(call.timeout - TIMEOUT_BUFFER_S, 30);
            const registeredSkill = getSkill(call.skill);
            if (registeredSkill) {
                await this.executeRegisteredSkill(call, registeredSkill, timeoutS);
                return;
            }
            const errMsg = `skill "${call.skill}" is not implemented by the built-in provider registry; external CLI fallback is disabled`;
            logger.error(`Rejecting order=${call.order_id}: ${errMsg}`);
            this.send({
                event: "deliver",
                order_id: call.order_id,
                error: errMsg,
            });
        }
        catch (err) {
            logger.error(`Execution error for order=${call.order_id}:`, err);
            this.send({
                event: "deliver",
                order_id: call.order_id,
                error: err instanceof Error ? err.message : "Unknown execution error",
            });
        }
        finally {
            this.activeTasks.delete(call.order_id);
        }
    }
    async executeRegisteredSkill(call, handler, timeoutS) {
        logger.info(`Executing built-in skill="${call.skill}" order=${call.order_id} (timeout=${timeoutS}s)`);
        this.sendProgress(call.order_id, `Running ${call.skill}…`);
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`skill timeout after ${timeoutS}s`)), timeoutS * 1000);
            timer.unref();
        });
        const ctx = {
            request_id: call.order_id,
            buyer_id: call.from,
            report: (progress) => {
                const parts = [
                    progress.stage,
                    progress.percent == null ? undefined : `${progress.percent}%`,
                    progress.note,
                ].filter(Boolean);
                this.sendProgress(call.order_id, parts.join(" — ") || `Running ${call.skill}…`);
            },
        };
        try {
            const rawOutput = await Promise.race([handler.run(call.input, ctx), timeoutPromise]);
            const output = normalizeSkillOutput(rawOutput);
            const sent = this.send({
                event: "deliver",
                order_id: call.order_id,
                output,
            });
            if (sent) {
                logger.info(`Delivered order=${call.order_id} via built-in skill="${call.skill}"`);
            }
            else {
                logger.warn(`Failed to send delivery for order=${call.order_id} (WS disconnected)`);
            }
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
}
function normalizeSkillOutput(output) {
    if (output && typeof output === "object" && !Array.isArray(output)) {
        return output;
    }
    return { result: output };
}
