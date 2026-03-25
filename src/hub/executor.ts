import { spawn } from "node:child_process";
import type {
  ProviderConfig,
  ServiceCallEvent,
  TestCallEvent,
  DeliverEvent,
  TestResponseEvent,
} from "./types.js";
import { isProcessed, markProcessed } from "./dedup.js";
import { replaceLocalPaths } from "./media.js";
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
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // Build args based on command
    let args: string[];
    if (command === "openclaw") {
      // openclaw agent --message "..." --local
      args = ["agent", "--message", prompt, "--local"];
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
        timeoutS * 1000
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
      let output: Record<string, unknown> = parsed ?? {
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
