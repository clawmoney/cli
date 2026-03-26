import { spawn } from "node:child_process";
import type {
  ProviderConfig,
  ServiceCallEvent,
  TestCallEvent,
  DeliverEvent,
  TestResponseEvent,
} from "./types.js";
import { isProcessed, markProcessed } from "./dedup.js";
import { replaceLocalPaths, uploadFile } from "./media.js";
import { logger } from "./logger.js";

type SendFn = (event: DeliverEvent | TestResponseEvent) => boolean;

const TIMEOUT_BUFFER_S = 15;

// ── Prompt builder ──

function buildPrompt(call: ServiceCallEvent, config: ProviderConfig): string {
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

function runCli(
  command: string,
  prompt: string,
  timeoutMs: number,
  orderId?: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // Build args based on command
    let args: string[];
    if (command === "openclaw") {
      // openclaw agent --message "..." --session-id <order_id> --local --json
      // session-id doesn't need to be pre-created, openclaw auto-creates it
      args = ["agent", "--message", prompt, "--session-id", orderId || "hub-task", "--local", "--json"];
    } else {
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

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
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

function parseJsonOutput(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Ignore
  }

  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      // Ignore
    }
  }

  return null;
}

// ── OpenClaw response parser ──

interface OpenClawResponse {
  result: Record<string, unknown>;
  files: string[];
  meta: Record<string, unknown> | null;
}

function parseOpenClawResponse(raw: Record<string, unknown>): OpenClawResponse {
  const files: string[] = [];
  let result: Record<string, unknown> = raw;
  let meta: Record<string, unknown> | null = null;

  // OpenClaw returns: { payloads: [{ text: "JSON string", mediaUrl }], meta: { ... } }
  const payloads = raw.payloads as Array<{ text?: string; mediaUrl?: string }> | undefined;

  if (payloads && Array.isArray(payloads) && payloads.length > 0) {
    const text = payloads[0].text ?? "";

    // Try to parse the text as JSON (OpenClaw wraps the agent's output in payloads[].text)
    const parsed = parseJsonOutput(text);
    if (parsed) {
      result = parsed;

      // Extract file paths from the parsed result
      const resultFiles = parsed.files as string[] | undefined;
      if (Array.isArray(resultFiles)) {
        files.push(...resultFiles.filter((f): f is string => typeof f === "string" && f.startsWith("/")));
      }
      // Also check common path keys
      for (const key of ["image_path", "video_path", "audio_path", "file_path"]) {
        const val = parsed[key];
        if (typeof val === "string" && val.startsWith("/")) {
          files.push(val);
        }
      }
    } else {
      result = { text: text.trim() };
    }

    // Extract useful meta (strip systemPromptReport which is huge)
    const rawMeta = raw.meta as Record<string, unknown> | undefined;
    if (rawMeta) {
      const agentMeta = rawMeta.agentMeta as Record<string, unknown> | undefined;
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
  private config: ProviderConfig;
  private send: SendFn;
  private activeTasks = new Set<string>();

  constructor(config: ProviderConfig, send: SendFn) {
    this.config = config;
    this.send = send;
  }

  get activeCount(): number {
    return this.activeTasks.size;
  }

  handleServiceCall(call: ServiceCallEvent): void {
    if (isProcessed(call.order_id)) {
      logger.info(`Skipping duplicate order: ${call.order_id}`);
      return;
    }

    if (this.activeTasks.size >= this.config.provider.max_concurrent) {
      logger.warn(
        `Rejecting order ${call.order_id}: at max concurrency (${this.config.provider.max_concurrent})`
      );
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

    logger.info(
      `Processing order=${call.order_id} skill="${call.skill}" from=${call.from}`
    );

    this.executeTask(call).catch((err) => {
      logger.error(
        `Unhandled error in executeTask for ${call.order_id}:`,
        err
      );
    });
  }

  handleTestCall(call: TestCallEvent): void {
    logger.info(`Test call received: order=${call.order_id}`);

    const response: TestResponseEvent = {
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

  private async executeTask(call: ServiceCallEvent): Promise<void> {
    try {
      const prompt = buildPrompt(call, this.config);
      const timeoutS = Math.max(call.timeout - TIMEOUT_BUFFER_S, 30);
      const command = this.config.provider.cli_command;

      logger.info(
        `Executing: ${command} for skill="${call.skill}" order=${call.order_id} (timeout=${timeoutS}s)`
      );

      const { stdout, stderr, exitCode } = await runCli(
        command,
        prompt,
        timeoutS * 1000,
        call.order_id
      );

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
      let output: Record<string, unknown>;

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
            error: (output.error as string).slice(0, 2000),
          });
          return;
        }

        // Upload local files to R2
        for (const filePath of ocResult.files) {
          const cdnUrl = await uploadFile(filePath, this.config);
          if (cdnUrl) {
            // Replace local path with CDN URL in output
            const currentFiles = (output.files as string[]) ?? [];
            const idx = currentFiles.indexOf(filePath);
            if (idx >= 0) {
              currentFiles[idx] = cdnUrl;
              output.files = currentFiles;
            }
            // Also set a convenience url key
            if (!output.image_url && filePath.match(/\.(png|jpg|jpeg|webp|gif)$/i)) {
              output.image_url = cdnUrl;
            } else if (!output.video_url && filePath.match(/\.(mp4|webm|mov)$/i)) {
              output.video_url = cdnUrl;
            }
          }
        }

        // Attach compact meta
        if (ocResult.meta) {
          output._meta = ocResult.meta;
        }
      } else {
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
      } else {
        logger.warn(
          `Failed to send delivery for order=${call.order_id} (WS disconnected)`
        );
      }
    } catch (err) {
      logger.error(`Execution error for order=${call.order_id}:`, err);

      this.send({
        event: "deliver",
        order_id: call.order_id,
        error: err instanceof Error ? err.message : "Unknown execution error",
      });
    } finally {
      this.activeTasks.delete(call.order_id);
    }
  }
}
