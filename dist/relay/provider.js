import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { RelayWsClient } from "./ws-client.js";
import { spawnCli, buildCliArgs, parseCliOutput } from "./executor.js";
import { relayLogger as logger } from "./logger.js";
const CONFIG_DIR = join(homedir(), ".clawmoney");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");
const PID_FILE = join(CONFIG_DIR, "relay.pid");
const DEFAULT_RELAY = {
    cli_type: "claude",
    model: "claude-opus-4-6",
    mode: "chat",
    concurrency: 5,
    daily_limit_usd: 20,
    ws_url: "wss://api.bnbot.ai/api/v1/ws/relay",
    reconnect: {
        initial: 5,
        max: 300,
        multiplier: 2,
    },
};
// ── PID helpers ──
export function readRelayPid() {
    try {
        const content = readFileSync(PID_FILE, "utf-8").trim();
        const pid = parseInt(content, 10);
        return isNaN(pid) ? null : pid;
    }
    catch {
        return null;
    }
}
export function isRelayPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function writeRelayPid() {
    writeFileSync(PID_FILE, String(process.pid), "utf-8");
}
export function removeRelayPid() {
    try {
        unlinkSync(PID_FILE);
    }
    catch {
        // Ignore
    }
}
// ── Config loading ──
function loadRelayConfig(cliOverride) {
    let raw;
    try {
        const content = readFileSync(CONFIG_FILE, "utf-8");
        raw = YAML.parse(content);
    }
    catch (err) {
        logger.error(`Failed to read config from ${CONFIG_FILE}:`, err);
        process.exit(1);
    }
    if (!raw.api_key || typeof raw.api_key !== "string") {
        logger.error("api_key is required in config.yaml. Run 'clawmoney setup' first.");
        process.exit(1);
    }
    const userRelay = (raw.relay ?? {});
    const relay = {
        cli_type: cliOverride ?? userRelay.cli_type ?? DEFAULT_RELAY.cli_type,
        model: userRelay.model ?? DEFAULT_RELAY.model,
        mode: userRelay.mode ?? DEFAULT_RELAY.mode,
        concurrency: userRelay.concurrency ?? DEFAULT_RELAY.concurrency,
        daily_limit_usd: userRelay.daily_limit_usd ?? DEFAULT_RELAY.daily_limit_usd,
        ws_url: userRelay.ws_url ?? DEFAULT_RELAY.ws_url,
        reconnect: {
            initial: userRelay.reconnect?.initial ?? DEFAULT_RELAY.reconnect.initial,
            max: userRelay.reconnect?.max ?? DEFAULT_RELAY.reconnect.max,
            multiplier: userRelay.reconnect?.multiplier ?? DEFAULT_RELAY.reconnect.multiplier,
        },
    };
    return {
        api_key: raw.api_key,
        agent_id: raw.agent_id,
        agent_slug: raw.agent_slug,
        relay,
    };
}
// ── Request handler ──
async function executeRelayRequest(request, config) {
    const { request_id, prompt, session_id, max_budget_usd } = request;
    const cliType = config.relay.cli_type;
    try {
        const args = buildCliArgs(cliType, prompt, session_id, max_budget_usd);
        const raw = await spawnCli(cliType, args);
        const parsed = parseCliOutput(cliType, raw);
        return {
            event: "relay_response",
            request_id,
            result: parsed.text,
            session_id: parsed.sessionId || undefined,
            usage: parsed.usage,
            model_used: parsed.model || config.relay.model,
            cost_usd: parsed.costUsd || undefined,
        };
    }
    catch (err) {
        logger.error(`Relay request ${request_id} failed:`, err);
        return {
            event: "relay_response",
            request_id,
            result: "",
            error: err instanceof Error ? err.message : "Unknown execution error",
        };
    }
}
// ── Main daemon entry point ──
export function runRelayProvider(cliOverride) {
    // Check for existing process
    const existingPid = readRelayPid();
    if (existingPid && isRelayPidAlive(existingPid)) {
        logger.error(`Relay Provider is already running (PID ${existingPid}). Use "relay stop" first.`);
        process.exit(1);
    }
    const config = loadRelayConfig(cliOverride);
    const activeTasks = new Set();
    // Create WS client
    const wsClient = new RelayWsClient(config, (event) => {
        handleEvent(event);
    });
    // Event router
    function handleEvent(event) {
        switch (event.event) {
            case "connected":
                logger.info(`Connected as "${event.agent_name}" (id=${event.agent_id}, provider=${event.provider_id})`);
                break;
            case "relay_request":
                handleRelayRequest(event);
                break;
            case "error":
                logger.error(`Server error: ${event.message}`);
                break;
            default:
                logger.warn("Unknown event:", event);
        }
    }
    function handleRelayRequest(request) {
        if (activeTasks.size >= config.relay.concurrency) {
            logger.warn(`Rejecting request ${request.request_id}: at max concurrency (${config.relay.concurrency})`);
            wsClient.send({
                event: "relay_response",
                request_id: request.request_id,
                result: "",
                error: "Provider is at maximum capacity. Please try again later.",
            });
            return;
        }
        activeTasks.add(request.request_id);
        logger.info(`Processing relay request=${request.request_id} (active=${activeTasks.size}/${config.relay.concurrency})`);
        executeRelayRequest(request, config)
            .then((response) => {
            const sent = wsClient.send(response);
            if (sent) {
                logger.info(`Delivered relay response for request=${request.request_id}`);
            }
            else {
                logger.warn(`Failed to send relay response for ${request.request_id} (WS disconnected)`);
            }
        })
            .catch((err) => {
            logger.error(`Unhandled error for relay request ${request.request_id}:`, err);
        })
            .finally(() => {
            activeTasks.delete(request.request_id);
        });
    }
    // Graceful shutdown
    let shuttingDown = false;
    function shutdown(signal) {
        if (shuttingDown)
            return;
        shuttingDown = true;
        logger.info(`Received ${signal}. Shutting down...`);
        wsClient.stop();
        removeRelayPid();
        logger.info("Relay Provider stopped.");
        process.exit(0);
    }
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    // Write PID and start
    writeRelayPid();
    wsClient.start();
    logger.info("Relay Provider running. Listening for relay requests...");
    logger.info(`Config: cli=${config.relay.cli_type}, model=${config.relay.model}, mode=${config.relay.mode}, concurrency=${config.relay.concurrency}`);
}
