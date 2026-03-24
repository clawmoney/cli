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
    `Input: ${JSON.stringify(call.input, null, 2)}`,
    "",
    "Execute this task and return the result as JSON.",
    "If you generate any files, save them and include their paths in the output.",
  ].join("\n");
}

function runCli(
  command: string,
  prompt: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json"];
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
      const timeoutMs = Math.max(
        (call.timeout - TIMEOUT_BUFFER_S) * 1000,
        30_000
      );
      const command = this.config.provider.cli_command;

      logger.info(
        `Executing: ${command} for skill="${call.skill}" order=${call.order_id} (timeout=${Math.round(timeoutMs / 1000)}s)`
      );

      const { stdout, stderr, exitCode } = await runCli(
        command,
        prompt,
        timeoutMs
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
      if (!parsed) {
        logger.warn("CLI output was not valid JSON, wrapping as text");
        this.send({
          event: "deliver",
          order_id: call.order_id,
          output: { result: stdout.trim().slice(0, 5000) },
        });
        return;
      }

      const output = await replaceLocalPaths(parsed, this.config);

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
