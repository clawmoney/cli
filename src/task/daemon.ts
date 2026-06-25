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
import { execFileSync } from "node:child_process";
import YAML from "yaml";

const TASK_LOG_FILE = join(homedir(), ".clawmoney", "task.log");

function tsLine(level: string, msg: string): string {
  const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
  return `${ts} [${level}] ${msg}\n`;
}

function logToFile(level: string, ...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = tsLine(level, msg);
  try {
    mkdirSync(join(homedir(), ".clawmoney"), { recursive: true });
    appendFileSync(TASK_LOG_FILE, line, "utf-8");
  } catch {
    /* best effort */
  }
}

function installFileLogger(): void {
  console.log = (...args: unknown[]) => logToFile("INFO", ...args);
  console.warn = (...args: unknown[]) => logToFile("WARN", ...args);
  console.error = (...args: unknown[]) => logToFile("ERROR", ...args);
}
import { TaskWsClient } from "./ws-client.js";
import { getSkill, listSkills, defaultAdvertiseSkills } from "./skills/index.js";
import { runPreflight, writePreflightReport } from "./preflight.js";
import type {
  HubFrame,
  SkillContext,
  TaskDaemonConfig,
  TaskRequest,
} from "./types.js";

const CONFIG_DIR = join(homedir(), ".clawmoney");
const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");
const PID_FILE = join(CONFIG_DIR, "task.pid");
const TASK_STATE_FILE = join(CONFIG_DIR, "task-state.json");

function loadYamlConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return (YAML.parse(readFileSync(CONFIG_FILE, "utf-8")) ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
}

function loadConfig(): TaskDaemonConfig {
  const yaml = loadYamlConfig();

  const skillsEnv = process.env.SKILLS ?? "";
  const requested = skillsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Default advertise set excludes skills the SpareAPI backend now fetches
  // directly (YC / IndieHackers / Hacker News); an explicit SKILLS= can still
  // opt into them since `supported` below is the full registry.
  const skills = requested.length > 0 ? requested : defaultAdvertiseSkills();

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

export function readTaskPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
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

function removePid(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

// Lifecycle phase the desktop app reads to show "service running, checking
// logins…" during the (possibly slow first-run) preflight, vs "online" once
// the hub connection is up. Distinct from the pid file, which only says the
// process exists.
function writeTaskState(phase: "probing" | "online"): void {
  try {
    writeFileSync(
      TASK_STATE_FILE,
      JSON.stringify({ phase, pid: process.pid, ts: new Date().toISOString() }),
      "utf-8",
    );
  } catch {
    /* best effort */
  }
}

function clearTaskState(): void {
  try {
    unlinkSync(TASK_STATE_FILE);
  } catch {
    // ignore
  }
}

async function handleTaskRequest(
  ws: TaskWsClient,
  req: TaskRequest,
): Promise<void> {
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

  const ctx: SkillContext = {
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
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`skill timeout after ${req.timeout_ms}ms`)),
      req.timeout_ms,
    );
    timer.unref();
  });

  try {
    const output = await Promise.race([handler.run(req.input, ctx), timeoutPromise]);
    const costUsd =
      typeof handler.price_usd === "function"
        ? handler.price_usd(req.input)
        : handler.price_usd;
    ws.send({
      event: "task_response",
      request_id: req.request_id,
      output,
      cost_usd: costUsd,
      duration_ms: Date.now() - startedAtMs,
    });
  } catch (err) {
    ws.send({
      event: "task_response",
      request_id: req.request_id,
      error: err instanceof Error ? err.message : String(err),
      cost_usd: 0,
      duration_ms: Date.now() - startedAtMs,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function applySystemProxy(): void {
  // bnbot's publicScrapers honor https_proxy/http_proxy/all_proxy to reach
  // censored public APIs (wiki/google/...). The daemon's own WS uses the
  // `ws` lib which ignores these env vars, so this only routes child bnbot
  // fetches through the proxy. Auto-detect the macOS system proxy when the
  // operator hasn't set one explicitly.
  if (
    process.env.https_proxy || process.env.HTTPS_PROXY ||
    process.env.all_proxy || process.env.ALL_PROXY
  ) {
    return;
  }
  if (process.platform !== "darwin") return;
  try {
    const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 3000 });
    const get = (key: string): string | undefined =>
      out.match(new RegExp(`\\b${key}\\s*:\\s*(\\S+)`))?.[1];
    let url: string | undefined;
    if (get("HTTPSEnable") === "1" && get("HTTPSProxy")) {
      url = `http://${get("HTTPSProxy")}:${get("HTTPSPort") ?? "0"}`;
    } else if (get("HTTPEnable") === "1" && get("HTTPProxy")) {
      url = `http://${get("HTTPProxy")}:${get("HTTPPort") ?? "0"}`;
    } else if (get("SOCKSEnable") === "1" && get("SOCKSProxy")) {
      url = `socks5://${get("SOCKSProxy")}:${get("SOCKSPort") ?? "0"}`;
    }
    if (url) {
      process.env.https_proxy = url;
      process.env.http_proxy = url;
      process.env.all_proxy = url;
      console.log(`[task] auto-detected system proxy ${url} (routing skill fetches through it)`);
    }
  } catch (err) {
    console.error(
      `[task] system proxy detection skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function main(): Promise<void> {
  // Daemon was started as a script (stdio:"ignore"); from here on, all
  // log lines should land in ~/.clawmoney/task.log.
  installFileLogger();
  applySystemProxy();

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

  // Mark the service up the moment config checks out — BEFORE the (possibly
  // slow first-run) preflight. Two reasons: the app can show "service running,
  // checking logins…" instead of "not started", and the app's self-heal keys
  // off the pid file, so writing it now stops it from re-spawning us mid-probe.
  writePid();
  writeTaskState("probing");

  // Preflight: probe each platform's external dependency and drop the ones
  // that would fail every task (Codex not installed, X not logged in, the
  // Chrome extension down, …). Writes ~/.clawmoney/preflight.json so the
  // desktop app can surface a home-screen notice. Re-runs every start, so
  // fixing the dependency recovers the platform on the next boot.
  console.log(`[task] preflight on ${config.skills.length} skills…`);
  const { skills: keptSkills, report } = await runPreflight(config.skills);
  writePreflightReport(report);
  config.skills = keptSkills;
  if (report.summary.droppedSkills > 0) {
    console.warn(
      `[task] preflight dropped ${report.summary.droppedSkills} skill(s) across ` +
        `${report.summary.failed} platform(s): ${report.dropped.join(", ")}`,
    );
  }

  console.log(
    `[task] starting daemon hub=${config.hub_url} skills=[${config.skills.join(",")}]`,
  );

  if (config.skills.length === 0) {
    console.error("[task] no skills to advertise — refusing to start");
    removePid();
    clearTaskState();
    process.exit(1);
  }

  // Belt-and-suspenders: even if every other handle (WS, heartbeat,
  // reconnect timer) somehow goes away simultaneously, this interval
  // is unref-less and ref-counted into the event loop, so the daemon
  // never silently exits. Cost: a no-op tick every 60s.
  const keepAlive = setInterval(() => undefined, 60_000);
  process.on("exit", () => clearInterval(keepAlive));

  // Last-ditch: log unhandled async errors instead of letting Node's
  // default abort the process. (uncaught promise rejection is the
  // most likely silent killer in this WS-heavy loop.)
  process.on("unhandledRejection", (err: unknown) => {
    console.error(
      `[task] unhandledRejection: ${err instanceof Error ? err.stack : String(err)}`,
    );
  });
  process.on("uncaughtException", (err: Error) => {
    console.error(`[task] uncaughtException: ${err.stack ?? err.message}`);
  });

  const ws = new TaskWsClient(config, (frame: HubFrame) => {
    switch (frame.event) {
      case "connected":
        console.log(
          `[task] connected agent_id=${frame.agent_id} name="${frame.agent_name}"`,
        );
        writeTaskState("online");
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

  const shutdown = (signal: string): void => {
    console.log(`[task] ${signal} — shutting down`);
    ws.stop();
    removePid();
    clearTaskState();
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
  main().catch((err) => {
    console.error(`[task] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
