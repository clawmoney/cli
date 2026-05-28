#!/usr/bin/env tsx
/**
 * Task-protocol daemon entry. Connects to spareai-hub and dispatches
 * incoming `task_request` frames to the local skill registry.
 *
 * Run for local development against `wrangler dev`:
 *
 *   HUB_URL=ws://127.0.0.1:8787/ws/relay \
 *   AGENT_ID=clawmoney-dev \
 *   SKILLS=echo,x.search \
 *   npx tsx src/task/daemon.ts
 *
 * Run against production:
 *
 *   HUB_URL=wss://api.spareapi.ai/ws/relay \
 *   API_KEY=$CLAWMONEY_API_KEY \
 *   SKILLS=x.search \
 *   npx tsx src/task/daemon.ts
 *
 * No CLI integration yet — that lands in Phase 3 alongside the proper
 * `clawmoney task start` command.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
const TASK_LOG_FILE = join(homedir(), ".clawmoney", "task.log");
function tsLine(level, msg) {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    return `${ts} [${level}] ${msg}\n`;
}
function logToFile(level, ...args) {
    const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    const line = tsLine(level, msg);
    try {
        mkdirSync(join(homedir(), ".clawmoney"), { recursive: true });
        appendFileSync(TASK_LOG_FILE, line, "utf-8");
    }
    catch {
        /* best effort */
    }
}
function installFileLogger() {
    console.log = (...args) => logToFile("INFO", ...args);
    console.warn = (...args) => logToFile("WARN", ...args);
    console.error = (...args) => logToFile("ERROR", ...args);
}
import { TaskWsClient } from "./ws-client.js";
import { getSkill, listSkills } from "./skills/index.js";
const CONFIG_DIR = join(homedir(), ".clawmoney");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");
const PID_FILE = join(CONFIG_DIR, "task.pid");
function loadYamlConfig() {
    if (!existsSync(CONFIG_FILE))
        return {};
    try {
        return (YAML.parse(readFileSync(CONFIG_FILE, "utf-8")) ?? {});
    }
    catch {
        return {};
    }
}
function pickString(...candidates) {
    for (const c of candidates) {
        if (typeof c === "string" && c)
            return c;
    }
    return undefined;
}
function loadConfig() {
    const yaml = loadYamlConfig();
    const skillsEnv = process.env.SKILLS ?? "";
    const requested = skillsEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const skills = requested.length > 0 ? requested : listSkills();
    // Sanity-check: drop anything we can't actually serve so we don't
    // advertise dead skills to the hub.
    const supported = new Set(listSkills());
    const filtered = skills.filter((s) => {
        if (!supported.has(s)) {
            console.warn(`[task] skill "${s}" not registered, skipping`);
            return false;
        }
        return true;
    });
    return {
        hub_url: process.env.HUB_URL ?? "wss://api.spareapi.ai/ws/relay",
        api_key: pickString(process.env.API_KEY, yaml.api_key) ?? "",
        agent_id: pickString(process.env.AGENT_ID, yaml.agent_id),
        agent_name: pickString(process.env.AGENT_NAME, yaml.agent_slug) ?? "clawmoney-task",
        skills: filtered,
        max_concurrency: process.env.MAX_CONCURRENCY
            ? Number.parseInt(process.env.MAX_CONCURRENCY, 10)
            : 5,
        heartbeat_ms: 5000,
        reconnect: { initial_ms: 1000, max_ms: 60_000, multiplier: 2 },
    };
}
export function readTaskPid() {
    try {
        const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        return Number.isFinite(pid) ? pid : null;
    }
    catch {
        return null;
    }
}
export function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function writePid() {
    writeFileSync(PID_FILE, String(process.pid), "utf-8");
}
function removePid() {
    try {
        unlinkSync(PID_FILE);
    }
    catch {
        // ignore
    }
}
async function handleTaskRequest(ws, req) {
    const startedAtMs = Date.now();
    const handler = getSkill(req.skill_id);
    if (!handler) {
        ws.send({
            event: "task_response",
            request_id: req.request_id,
            error: `skill "${req.skill_id}" not implemented on this provider`,
            cost_usd: 0,
            duration_ms: Date.now() - startedAtMs,
        });
        return;
    }
    const ctx = {
        request_id: req.request_id,
        buyer_id: req.buyer_id,
        report: (progress) => {
            ws.send({
                event: "task_progress",
                request_id: req.request_id,
                ...progress,
            });
        },
    };
    // Per-task timeout — the hub also enforces this, but the local
    // wrapper avoids leaking a hung skill into our concurrency budget.
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`skill timeout after ${req.timeout_ms}ms`)), req.timeout_ms);
        timer.unref();
    });
    try {
        const output = await Promise.race([handler.run(req.input, ctx), timeoutPromise]);
        const costUsd = typeof handler.price_usd === "function"
            ? handler.price_usd(req.input)
            : handler.price_usd;
        ws.send({
            event: "task_response",
            request_id: req.request_id,
            output,
            cost_usd: costUsd,
            duration_ms: Date.now() - startedAtMs,
        });
    }
    catch (err) {
        ws.send({
            event: "task_response",
            request_id: req.request_id,
            error: err instanceof Error ? err.message : String(err),
            cost_usd: 0,
            duration_ms: Date.now() - startedAtMs,
        });
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function main() {
    // Daemon was started as a script (stdio:"ignore"); from here on, all
    // log lines should land in ~/.clawmoney/task.log.
    installFileLogger();
    const existing = readTaskPid();
    if (existing !== null && isPidAlive(existing)) {
        console.error(`[task] already running (PID ${existing})`);
        process.exit(1);
    }
    const config = loadConfig();
    if (!config.api_key) {
        console.error("[task] api_key missing — set API_KEY env or run `clawmoney setup`");
        process.exit(1);
    }
    console.log(`[task] starting daemon hub=${config.hub_url} skills=[${config.skills.join(",")}]`);
    if (config.skills.length === 0) {
        console.error("[task] no skills to advertise — refusing to start");
        process.exit(1);
    }
    writePid();
    // Belt-and-suspenders: even if every other handle (WS, heartbeat,
    // reconnect timer) somehow goes away simultaneously, this interval
    // is unref-less and ref-counted into the event loop, so the daemon
    // never silently exits. Cost: a no-op tick every 60s.
    const keepAlive = setInterval(() => undefined, 60_000);
    process.on("exit", () => clearInterval(keepAlive));
    // Last-ditch: log unhandled async errors instead of letting Node's
    // default abort the process. (uncaught promise rejection is the
    // most likely silent killer in this WS-heavy loop.)
    process.on("unhandledRejection", (err) => {
        console.error(`[task] unhandledRejection: ${err instanceof Error ? err.stack : String(err)}`);
    });
    process.on("uncaughtException", (err) => {
        console.error(`[task] uncaughtException: ${err.stack ?? err.message}`);
    });
    const ws = new TaskWsClient(config, (frame) => {
        switch (frame.event) {
            case "connected":
                console.log(`[task] connected agent_id=${frame.agent_id} name="${frame.agent_name}"`);
                break;
            case "task_request":
                void handleTaskRequest(ws, frame);
                break;
            case "heartbeat_ack":
                // Silent — the hub bumps KV TTL for us.
                break;
            case "error":
                console.error(`[task] hub error: ${frame.message}`);
                break;
        }
    });
    const shutdown = (signal) => {
        console.log(`[task] ${signal} — shutting down`);
        ws.stop();
        removePid();
        setTimeout(() => process.exit(0), 200);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    ws.start();
}
// Only run main() when invoked as a script (`node daemon.js`), not when
// the module is imported (e.g. by src/commands/task.ts which only wants
// to use readTaskPid / isPidAlive helpers).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}
