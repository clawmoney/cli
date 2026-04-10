import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ParsedOutput } from "./types.js";
import { relayLogger as logger } from "./logger.js";

// Pure-LLM system prompt. Tools are physically disabled via --tools "" and
// an empty MCP config, so this prompt only needs to set the assistant role.
const RELAY_SYSTEM_PROMPT =
  "You are a helpful AI assistant. Respond with text only.";

// Empty MCP config — written once at startup and passed via --mcp-config.
// Combined with --strict-mcp-config this disables all MCP tools without
// depending on the user's global/project MCP configuration.
const CLAWMONEY_DIR = join(homedir(), ".clawmoney");
const EMPTY_MCP_CONFIG_PATH = join(CLAWMONEY_DIR, "empty-mcp.json");
const SANDBOX_DIR = join(CLAWMONEY_DIR, "sandbox");

export function ensureEmptyMcpConfig(): string {
  try {
    mkdirSync(CLAWMONEY_DIR, { recursive: true });
    writeFileSync(EMPTY_MCP_CONFIG_PATH, '{"mcpServers":{}}', "utf-8");
  } catch (err) {
    logger.warn(
      `Failed to write empty MCP config at ${EMPTY_MCP_CONFIG_PATH}:`,
      err
    );
  }
  return EMPTY_MCP_CONFIG_PATH;
}

// Ensures an empty sandbox directory exists and is used as the spawn cwd.
// Claude Code auto-injects cwd path, CLAUDE.md, and git status into the
// system prompt based on the spawn directory — running from an empty
// sandbox prevents any of the provider's real project data from leaking
// to the consumer side.
export function ensureSandboxDir(): string {
  try {
    mkdirSync(SANDBOX_DIR, { recursive: true });
  } catch (err) {
    logger.warn(`Failed to create sandbox dir at ${SANDBOX_DIR}:`, err);
  }
  return SANDBOX_DIR;
}

const DEFAULT_TIMEOUT_MS = 120_000;

// ── Spawn CLI process ──

export function spawnCli(
  cliType: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  cwd?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    logger.info(`  │ Exec:   ${cliType} ${args.slice(0, 3).join(" ")}...`);

    const child = spawn(cliType, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env: { ...process.env },
      cwd,
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
      if (code !== 0 && code !== null) {
        const errMsg = stderr.trim() || `CLI exited with code ${code}`;
        logger.error(`${cliType} failed (code=${code}): ${errMsg.slice(0, 500)}`);
        reject(new Error(errMsg.slice(0, 2000)));
        return;
      }
      resolve(stdout);
    });

    child.on("error", (err) => {
      logger.error(`${cliType} spawn error:`, err.message);
      reject(err);
    });
  });
}

// ── Build CLI arguments ──

export function buildCliArgs(
  cliType: string,
  prompt: string,
  sessionId?: string,
  maxBudgetUsd?: number,
  model?: string
): string[] {
  let args: string[];

  if (cliType === "claude") {
    // Pure-LLM relay mode: strip all tool access, MCP servers, user/project
    // settings, CLAUDE.md auto-discovery, and the default system prompt.
    // Combined with spawning the process in an empty sandbox cwd, this
    // ensures the consumer never sees the provider's filesystem, project
    // context, or CLAUDE.md contents.
    args = [
      "-p", prompt,
      "--output-format", "json",
      "--tools", "",
      "--strict-mcp-config",
      "--mcp-config", EMPTY_MCP_CONFIG_PATH,
      "--setting-sources", "",
      "--system-prompt", RELAY_SYSTEM_PROMPT,
    ];
    if (model) {
      args.push("--model", model);
    }
    if (maxBudgetUsd) {
      args.push("--max-budget-usd", String(maxBudgetUsd));
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    }
  } else if (cliType === "codex") {
    if (sessionId) {
      args = ["exec", "resume", sessionId, "--json", "--skip-git-repo-check"];
    } else {
      args = ["exec", "--json", "--skip-git-repo-check"];
    }
    if (model) {
      args.push("-m", model);
    }
    args.push(prompt);
  } else if (cliType === "gemini") {
    args = ["-p", prompt, "-o", "json"];
    if (model) {
      args.push("-m", model);
    }
    if (sessionId) {
      args.push("--resume", sessionId);
    }
  } else {
    throw new Error(`Unsupported CLI type: ${cliType}`);
  }

  return args;
}

// ── Parse Claude Code JSON output ──

export function parseClaudeOutput(raw: string): ParsedOutput {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;

    // Claude Code JSON: { result, session_id, total_cost_usd, modelUsage }
    const text = typeof obj.result === "string"
      ? obj.result
      : JSON.stringify(obj.result ?? "");

    const sessionId = (obj.session_id as string) ?? "";
    const costUsd = (obj.total_cost_usd as number) ?? 0;

    // modelUsage is a dict: { "model-name": { inputTokens, outputTokens, cacheReadInputTokens, ... } }
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let model = "";

    const modelUsage = obj.modelUsage as Record<string, Record<string, number>> | undefined;
    if (modelUsage) {
      for (const [modelName, usage] of Object.entries(modelUsage)) {
        model = modelName;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
        cacheCreationTokens += usage.cacheCreationInputTokens ?? 0;
        cacheReadTokens += usage.cacheReadInputTokens ?? 0;
      }
    }

    return {
      text,
      sessionId,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_tokens: cacheCreationTokens, cache_read_tokens: cacheReadTokens },
      model,
      costUsd,
    };
  } catch {
    return {
      text: raw.trim().slice(0, 5000),
      sessionId: "",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
      model: "",
      costUsd: 0,
    };
  }
}

// ── Parse Codex JSONL output ──

export function parseCodexOutput(raw: string): ParsedOutput {
  let text = "";
  let threadId = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let model = "";

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;

      // thread.started -> thread_id
      if (event.type === "thread.started") {
        const thread = event.thread as Record<string, unknown> | undefined;
        threadId = (thread?.id as string) ?? threadId;
      }

      // item.completed -> result text
      if (event.type === "item.completed") {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.text && typeof item.text === "string") {
          text += (text ? "\n" : "") + item.text;
        }
      }

      // turn.completed -> usage
      if (event.type === "turn.completed") {
        const usage = event.usage as Record<string, number> | undefined;
        if (usage) {
          inputTokens += usage.input_tokens ?? 0;
          outputTokens += usage.output_tokens ?? 0;
        }
        model = (event.model as string) ?? model;
      }
    } catch {
      // skip non-JSON lines
    }
  }

  return {
    text: text || raw.trim().slice(0, 5000),
    sessionId: threadId,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_tokens: 0, cache_read_tokens: 0 },
    model,
    costUsd: 0,
  };
}

// ── Parse Gemini JSON output ──

export function parseGeminiOutput(raw: string): ParsedOutput {
  try {
    // Gemini may prefix output with non-JSON lines (e.g. "Loaded cached credentials.")
    const lines = raw.split("\n");
    const jsonStart = lines.findIndex((l) => l.trimStart().startsWith("{"));
    const cleanRaw = jsonStart >= 0 ? lines.slice(jsonStart).join("\n") : raw;
    const obj = JSON.parse(cleanRaw) as Record<string, unknown>;

    // Gemini JSON: { response, session_id, stats: { models: { "<model>": { tokens: { input, output } } } } }
    const text = typeof obj.response === "string"
      ? obj.response
      : JSON.stringify(obj.response ?? "");

    const sessionId = (obj.session_id as string) ?? "";

    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let model = "";

    const stats = obj.stats as Record<string, unknown> | undefined;
    const models = stats?.models as Record<string, Record<string, unknown>> | undefined;
    if (models) {
      for (const [modelName, modelStats] of Object.entries(models)) {
        model = modelName;
        const tokens = modelStats.tokens as Record<string, number> | undefined;
        if (tokens) {
          inputTokens += tokens.input ?? tokens.prompt ?? 0;
          outputTokens += tokens.candidates ?? tokens.output ?? 0;
          cachedTokens += tokens.cached ?? 0;
        }
      }
    }

    return {
      text,
      sessionId,
      usage: { input_tokens: inputTokens - cachedTokens, output_tokens: outputTokens, cache_creation_tokens: 0, cache_read_tokens: cachedTokens },
      model,
      costUsd: 0,
    };
  } catch {
    return {
      text: raw.trim().slice(0, 5000),
      sessionId: "",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 },
      model: "",
      costUsd: 0,
    };
  }
}

// ── Parse CLI output based on type ──

export function parseCliOutput(cliType: string, raw: string): ParsedOutput {
  if (cliType === "claude") return parseClaudeOutput(raw);
  if (cliType === "codex") return parseCodexOutput(raw);
  if (cliType === "gemini") return parseGeminiOutput(raw);
  throw new Error(`Unsupported CLI type: ${cliType}`);
}
