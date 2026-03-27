import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { WsClient } from "./ws-client.js";
import { Poller } from "./poller.js";
import { Executor } from "./executor.js";
import { startDedup, stopDedup } from "./dedup.js";
import { logger } from "./logger.js";
import type {
  ProviderConfig,
  ProviderSettings,
  IncomingEvent,
  ServiceCallEvent,
  EscrowTaskEvent,
} from "./types.js";

const CONFIG_DIR = join(homedir(), ".clawmoney");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");
const PID_FILE = join(CONFIG_DIR, "provider.pid");

const DEFAULT_PROVIDER: ProviderSettings = {
  cli_command: "openclaw",
  max_concurrent: 3,
  ws_url: "wss://api.bnbot.ai/api/v1/ws/agent",
  api_base_url: "https://api.bnbot.ai/api/v1",
  polling: {
    connected_interval: 120,
    disconnected_interval: 15,
  },
  reconnect: {
    initial: 5,
    max: 300,
    multiplier: 2,
  },
};

// ── PID helpers ──

export function readPid(): number | null {
  try {
    const content = readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writePid(): void {
  writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

export function removePid(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Ignore
  }
}

// ── Config loading ──

function loadProviderConfig(cliCommand?: string): ProviderConfig {
  let raw: Record<string, unknown>;

  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    raw = YAML.parse(content) as Record<string, unknown>;
  } catch (err) {
    logger.error(`Failed to read config from ${CONFIG_FILE}:`, err);
    process.exit(1);
  }

  if (!raw.api_key || typeof raw.api_key !== "string") {
    logger.error("api_key is required in config.yaml. Run 'clawmoney setup' first.");
    process.exit(1);
  }

  const userProvider = (raw.provider ?? {}) as Partial<ProviderSettings>;

  const provider: ProviderSettings = {
    cli_command:
      cliCommand ?? userProvider.cli_command ?? DEFAULT_PROVIDER.cli_command,
    max_concurrent:
      userProvider.max_concurrent ?? DEFAULT_PROVIDER.max_concurrent,
    ws_url: userProvider.ws_url ?? DEFAULT_PROVIDER.ws_url,
    api_base_url:
      userProvider.api_base_url ?? DEFAULT_PROVIDER.api_base_url,
    polling: {
      connected_interval:
        userProvider.polling?.connected_interval ??
        DEFAULT_PROVIDER.polling.connected_interval,
      disconnected_interval:
        userProvider.polling?.disconnected_interval ??
        DEFAULT_PROVIDER.polling.disconnected_interval,
    },
    reconnect: {
      initial:
        userProvider.reconnect?.initial ?? DEFAULT_PROVIDER.reconnect.initial,
      max: userProvider.reconnect?.max ?? DEFAULT_PROVIDER.reconnect.max,
      multiplier:
        userProvider.reconnect?.multiplier ??
        DEFAULT_PROVIDER.reconnect.multiplier,
    },
    skills: userProvider.skills,
  };

  return {
    api_key: raw.api_key as string,
    agent_id: raw.agent_id as string | undefined,
    agent_slug: raw.agent_slug as string | undefined,
    provider,
  };
}

// ── Main daemon entry point ──

export function runProvider(cliCommand?: string): void {
  // Check for existing process
  const existingPid = readPid();
  if (existingPid && isPidAlive(existingPid)) {
    logger.error(
      `Hub Provider is already running (PID ${existingPid}). Use "hub stop" first.`
    );
    process.exit(1);
  }

  const config = loadProviderConfig(cliCommand);

  // Initialize dedup
  startDedup();

  // Create WS client
  const wsClient = new WsClient(config, (event: IncomingEvent) => {
    handleEvent(event);
  });

  // Create executor
  const executor = new Executor(config, (event) => wsClient.send(event));

  // Event router
  function handleEvent(event: IncomingEvent): void {
    switch (event.event) {
      case "connected":
        logger.info(
          `Connected as "${event.agent_name}" (id=${event.agent_id}, hub_level=${event.hub_level})`
        );
        break;

      case "service_call":
        executor.handleServiceCall(event);
        break;

      case "test_call":
        executor.handleTestCall(event);
        break;

      case "error":
        logger.error(`Server error: ${event.message}`);
        break;

      default:
        logger.warn("Unknown event:", event);
    }
  }

  // Create poller
  const poller = new Poller(
    config,
    (call: ServiceCallEvent) => {
      handleEvent(call);
    },
    (task: EscrowTaskEvent) => {
      executor.handleEscrowTask(task);
    },
    () => wsClient.connected
  );

  // Graceful shutdown
  let shuttingDown = false;

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`Received ${signal}. Shutting down...`);

    wsClient.stop();
    poller.stop();
    stopDedup();
    removePid();

    logger.info("Hub Provider stopped.");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Write PID and start
  writePid();
  wsClient.start();
  poller.start();

  logger.info("Hub Provider running. Listening for service calls...");
  logger.info(
    `Config: cli=${config.provider.cli_command}, max_concurrent=${config.provider.max_concurrent}`
  );
}
