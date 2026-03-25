import { spawn } from "node:child_process";
import { isProcessed, markProcessed } from "./dedup.js";
import { replaceLocalPaths } from "./media.js";
import { logger } from "./logger.js";
const TIMEOUT_BUFFER_S = 15;
// ── Prompt builder ──
function buildPrompt(call, config) {
    const skillConfig = config.provider.skills?.[call.skill];
    if (skillConfig?.prompt_template) {
        return skillConfig.prompt_template
            .replace("{{skill}}", call.skill)
            .replace("{{input}}", JSON.stringify(call.input, null, 2));
    }
    return [
        "You received a paid service request via ClawMoney Hub.",
        `Skill: ${call.skill}`,
        `Category: ${call.category}`,
        `From: ${call.from}`,
        `Price: $${call.price}`,
        `Input: ${JSON.stringify(call.input, null, 2)}`,
        "",
        "Execute this task and return the result as JSON.",
        "If you generate any files (images, videos, etc.), save them and include their file paths in the output.",
        "Return ONLY the JSON result, no other text.",
    ].join("\n");
}
// ── CLI execution (openclaw agent / claude -p) ──
function runCli(command, prompt, timeoutMs) {
    return new Promise((resolve) => {
        // Build args based on command
        let args;
        if (command === "openclaw") {
            // openclaw agent --message "..." --local
            args = ["agent", "--message", prompt, "--local"];
        }
        else {
            // claude -p "..." --output-format json
            args = ["-p", prompt, "--output-format", "json"];
        }
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: timeoutMs,
            env: { ...process.env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("close", (code) => {
            resolve({ stdout, stderr, exitCode: code });
        });
        child.on("error", (err) => {
            stderr += err.message;
            resolve({ stdout, stderr, exitCode: null });
        });
    });
}
// ── JSON parser ──
function parseJsonOutput(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        // Ignore
    }
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            return JSON.parse(match[0]);
        }
        catch {
            // Ignore
        }
    }
    return null;
}
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
            const prompt = buildPrompt(call, this.config);
            const timeoutS = Math.max(call.timeout - TIMEOUT_BUFFER_S, 30);
            const command = this.config.provider.cli_command;
            logger.info(`Executing: ${command} for skill="${call.skill}" order=${call.order_id} (timeout=${timeoutS}s)`);
            const { stdout, stderr, exitCode } = await runCli(command, prompt, timeoutS * 1000);
            if (exitCode !== 0) {
                const errMsg = stderr.trim() || `CLI exited with code ${exitCode}`;
                logger.error(`CLI failed (code=${exitCode}):`, errMsg);
                this.send({
                    event: "deliver",
                    order_id: call.order_id,
                    error: errMsg.slice(0, 2000),
                });
                return;
            }
            const parsed = parseJsonOutput(stdout);
            let output = parsed ?? {
                result: stdout.trim().slice(0, 5000),
            };
            // Upload local files to R2 if any
            output = await replaceLocalPaths(output, this.config);
            const sent = this.send({
                event: "deliver",
                order_id: call.order_id,
                output,
            });
            if (sent) {
                logger.info(`Delivered order=${call.order_id} (success)`);
            }
            else {
                logger.warn(`Failed to send delivery for order=${call.order_id} (WS disconnected)`);
            }
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
}
