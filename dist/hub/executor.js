import { spawn } from "node:child_process";
import { isProcessed, markProcessed } from "./dedup.js";
import { replaceLocalPaths, uploadFile } from "./media.js";
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
    const lines = [
        "You received a paid service request via ClawMoney Hub.",
        `Skill: ${call.skill}`,
        `Category: ${call.category}`,
        `From: ${call.from}`,
        `Price: $${call.price}`,
        `Input: ${JSON.stringify(call.input, null, 2)}`,
        "",
    ];
    // Category-specific instructions
    if (call.category?.startsWith("generation/image")) {
        lines.push("IMPORTANT: Use the nano-banana-pro skill (or any image generation tool) to generate a real PNG/JPG image.", "Do NOT write SVG, HTML, or any code to fake an image.", "If no image generation tool is available, return {\"success\": false, \"error\": \"No image generation tool available\"}.", "Save the generated image and include the file path in your output.");
    }
    lines.push("Execute this task and return the result as JSON.", "If you generate any files (images, videos, etc.), save them and include their file paths in the output.", "Return ONLY the JSON result, no other text.");
    return lines.join("\n");
}
// ── CLI execution (openclaw agent / claude -p) ──
function runCli(command, prompt, timeoutMs, orderId) {
    return new Promise((resolve) => {
        // Build args based on command
        let args;
        if (command === "openclaw") {
            // openclaw agent --message "..." --session-id <order_id> --json
            // Route through Gateway (not --local) so skills like nano-banana-pro are available
            args = ["agent", "--message", prompt, "--session-id", orderId || "hub-task", "--json"];
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
function parseOpenClawResponse(raw) {
    const files = [];
    let result = raw;
    let meta = null;
    // OpenClaw returns: { payloads: [{ text: "JSON string", mediaUrl }], meta: { ... } }
    const payloads = raw.payloads;
    if (payloads && Array.isArray(payloads) && payloads.length > 0) {
        const text = payloads[0].text ?? "";
        // Try to parse the text as JSON (OpenClaw wraps the agent's output in payloads[].text)
        const parsed = parseJsonOutput(text);
        if (parsed) {
            result = parsed;
            // Extract file paths from the parsed result
            const resultFiles = parsed.files;
            if (Array.isArray(resultFiles)) {
                files.push(...resultFiles.filter((f) => typeof f === "string" && f.startsWith("/")));
            }
            // Also check common path keys
            for (const key of ["image_path", "video_path", "audio_path", "file_path"]) {
                const val = parsed[key];
                if (typeof val === "string" && val.startsWith("/")) {
                    files.push(val);
                }
            }
        }
        else {
            result = { text: text.trim() };
        }
        // Extract useful meta (strip systemPromptReport which is huge)
        const rawMeta = raw.meta;
        if (rawMeta) {
            const agentMeta = rawMeta.agentMeta;
            meta = {
                duration_ms: rawMeta.durationMs,
                model: agentMeta?.model,
                provider: agentMeta?.provider,
                usage: agentMeta?.usage,
            };
        }
    }
    return { result, files, meta };
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
            const { stdout, stderr, exitCode } = await runCli(command, prompt, timeoutS * 1000, call.order_id);
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
            let output;
            if (command === "openclaw" && parsed) {
                // Parse OpenClaw's response format: { payloads, meta }
                const ocResult = parseOpenClawResponse(parsed);
                output = ocResult.result;
                // Check if the agent explicitly reported failure
                if (output.success === false && typeof output.error === "string") {
                    logger.error(`Agent reported failure for order=${call.order_id}: ${output.error}`);
                    this.send({
                        event: "deliver",
                        order_id: call.order_id,
                        error: output.error.slice(0, 2000),
                    });
                    return;
                }
                // Also extract file paths from nested result.files / result.primary_file
                const allFiles = [...ocResult.files];
                const nested = output.result;
                if (nested && typeof nested === "object") {
                    const nestedFiles = nested.files;
                    if (Array.isArray(nestedFiles)) {
                        for (const f of nestedFiles) {
                            if (typeof f === "string" && f.startsWith("/") && !allFiles.includes(f)) {
                                allFiles.push(f);
                            }
                        }
                    }
                    for (const key of ["primary_file", "image_path", "file_path"]) {
                        const val = nested[key];
                        if (typeof val === "string" && val.startsWith("/") && !allFiles.includes(val)) {
                            allFiles.push(val);
                        }
                    }
                }
                // Upload local files to R2
                for (const filePath of allFiles) {
                    const cdnUrl = await uploadFile(filePath, this.config);
                    if (cdnUrl) {
                        // Replace local path with CDN URL in output (top-level and nested)
                        const replaceInArray = (arr) => {
                            const idx = arr.indexOf(filePath);
                            if (idx >= 0)
                                arr[idx] = cdnUrl;
                        };
                        if (Array.isArray(output.files))
                            replaceInArray(output.files);
                        if (nested && Array.isArray(nested.files)) {
                            replaceInArray(nested.files);
                        }
                        if (nested && nested.primary_file === filePath) {
                            nested.primary_file = cdnUrl;
                        }
                        // Set convenience url key
                        if (!output.image_url && filePath.match(/\.(png|jpg|jpeg|webp|gif)$/i)) {
                            output.image_url = cdnUrl;
                        }
                        else if (!output.video_url && filePath.match(/\.(mp4|webm|mov)$/i)) {
                            output.video_url = cdnUrl;
                        }
                    }
                }
                // Validate: generation/image must produce real image files, not SVG/code
                if (call.category?.startsWith("generation/image")) {
                    const hasRealImage = allFiles.some((f) => /\.(png|jpg|jpeg|webp|gif)$/i.test(f));
                    if (!hasRealImage) {
                        const errMsg = "No real image generated. Image generation tool may not be available.";
                        logger.error(`Validation failed for order=${call.order_id}: ${errMsg}`);
                        this.send({
                            event: "deliver",
                            order_id: call.order_id,
                            error: errMsg,
                        });
                        return;
                    }
                }
                // Attach compact meta
                if (ocResult.meta) {
                    output._meta = ocResult.meta;
                }
            }
            else {
                output = parsed ?? { result: stdout.trim().slice(0, 5000) };
                // Upload local files via generic path replacement
                output = await replaceLocalPaths(output, this.config);
            }
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
