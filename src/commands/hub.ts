import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../utils/config.js";
import { apiGet, apiPost } from "../utils/api.js";
import { readPid, isPidAlive, removePid } from "../hub/provider.js";

const LOG_FILE = join(homedir(), ".clawmoney", "provider.log");

// ── hub start ──

export async function hubStartCommand(options: {
  cli?: string;
}): Promise<void> {
  const config = requireConfig();

  // Check if already running
  const existingPid = readPid();
  if (existingPid && isPidAlive(existingPid)) {
    console.log(
      chalk.yellow(
        `Hub Provider is already running (PID ${existingPid}). Use "clawmoney hub stop" first.`
      )
    );
    return;
  }

  const spinner = ora("Starting Hub Provider...").start();

  try {
    // Resolve daemon script path relative to this file's directory
    // Works for both compiled (dist/commands/hub.js) and dev (src/commands/hub.ts)
    const thisDir = import.meta.url.replace("file://", "").replace(/\/[^/]+$/, "");
    const parentDir = thisDir.replace(/\/[^/]+$/, "");
    const daemonScript = join(parentDir, "hub", "daemon.js");

    const args = [daemonScript];
    if (options.cli) {
      args.push("--cli", options.cli);
    }

    const child = spawn(process.execPath, args, {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        CLAWMONEY_DAEMON: "1",
      },
    });

    child.unref();

    // Give the daemon a moment to start and write PID
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const pid = readPid();
    if (pid && isPidAlive(pid)) {
      spinner.succeed(
        chalk.green(`Hub Provider started (PID ${pid})`)
      );
      console.log(chalk.dim(`  Log file: ${LOG_FILE}`));
      console.log(
        chalk.dim(`  CLI command: ${options.cli || "claude"}`)
      );
      console.log(
        chalk.dim(`  API key: ${config.api_key.slice(0, 8)}...`)
      );
    } else {
      spinner.fail(
        chalk.red(
          "Failed to start Hub Provider. Check logs at: " + LOG_FILE
        )
      );
      process.exit(1);
    }
  } catch (err) {
    spinner.fail(chalk.red("Failed to start Hub Provider"));
    throw err;
  }
}

// ── hub stop ──

export async function hubStopCommand(): Promise<void> {
  const pid = readPid();

  if (!pid) {
    console.log(chalk.dim("Hub Provider is not running (no PID file)."));
    return;
  }

  if (!isPidAlive(pid)) {
    console.log(
      chalk.dim(
        `Hub Provider PID ${pid} is not alive. Cleaning up PID file.`
      )
    );
    removePid();
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(chalk.green(`Hub Provider stopped (PID ${pid}).`));
  } catch (err) {
    console.error(
      chalk.red(`Failed to stop process ${pid}:`),
      (err as Error).message
    );
  }

  // Wait briefly for cleanup, then ensure PID file is removed
  await new Promise((resolve) => setTimeout(resolve, 500));
  removePid();
}

// ── hub status ──

export async function hubStatusCommand(): Promise<void> {
  const pid = readPid();

  if (!pid) {
    console.log(chalk.dim("Hub Provider is not running."));
    return;
  }

  if (isPidAlive(pid)) {
    console.log(chalk.green(`Hub Provider is running (PID ${pid}).`));
    console.log(chalk.dim(`  Log file: ${LOG_FILE}`));
  } else {
    console.log(
      chalk.yellow(
        `Hub Provider PID ${pid} is not alive (stale PID file).`
      )
    );
    removePid();
  }
}

// ── hub register ──

interface RegisterOptions {
  name: string;
  category: string;
  description: string;
  price: string;
}

interface SkillResponse {
  id?: string;
  name?: string;
  detail?: string;
}

export async function hubRegisterCommand(
  options: RegisterOptions
): Promise<void> {
  const config = requireConfig();

  const price = parseFloat(options.price);
  if (isNaN(price) || price < 0) {
    console.error(chalk.red("Invalid price. Must be a non-negative number."));
    process.exit(1);
  }

  const spinner = ora("Registering skill...").start();

  try {
    const resp = await apiPost<SkillResponse>(
      "/api/v1/hub/skills",
      {
        skill_name: options.name,
        category: options.category,
        description: options.description,
        price: price,
      },
      config.api_key
    );

    if (!resp.ok) {
      const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
        ? (resp.data as Record<string, unknown>).detail
        : resp.data;
      const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
      spinner.fail(chalk.red(`Failed to register skill (${resp.status}): ${detail}`));
      process.exit(1);
    }

    spinner.succeed(chalk.green("Skill registered successfully!"));
    console.log("");
    console.log(`  ${chalk.bold("Name:")}      ${options.name}`);
    console.log(`  ${chalk.bold("Category:")}  ${options.category}`);
    console.log(`  ${chalk.bold("Price:")}     $${price.toFixed(2)}/call`);
  } catch (err) {
    spinner.fail(chalk.red("Failed to register skill"));
    throw err;
  }
}

// ── hub skills ──

interface Skill {
  id?: string;
  name?: string;
  skill_name?: string;
  category?: string;
  description?: string;
  price?: number;
  price_per_call?: number;
  status?: string;
  is_active?: boolean;
  total_calls?: number;
  call_count?: number;
}

export async function hubSkillsCommand(): Promise<void> {
  const config = requireConfig();

  const spinner = ora("Fetching skills...").start();

  try {
    const resp = await apiGet<{ data?: Skill[] } | Skill[]>(
      "/api/v1/hub/skills/mine",
      config.api_key
    );

    if (!resp.ok) {
      spinner.fail(chalk.red(`Failed to fetch skills (${resp.status})`));
      process.exit(1);
    }

    const skills: Skill[] = Array.isArray(resp.data)
      ? resp.data
      : (resp.data as { data?: Skill[] }).data ?? [];

    spinner.succeed(`My Skills (${skills.length})`);
    console.log("");

    if (skills.length === 0) {
      console.log(
        chalk.dim(
          '  No skills registered. Use "clawmoney hub register" to add one.'
        )
      );
      return;
    }

    // Table header
    console.log(
      chalk.bold(
        `  ${"Name".padEnd(20)} ${"Category".padEnd(20)} ${"Price".padEnd(10)} ${"Calls".padEnd(8)} ${"Status".padEnd(10)}`
      )
    );
    console.log(chalk.dim("  " + "-".repeat(70)));

    for (const skill of skills) {
      const name = (skill.skill_name ?? skill.name ?? "-").slice(0, 19);
      const category = (skill.category ?? "-").slice(0, 19);
      const rawPrice = skill.price ?? skill.price_per_call;
      const price = rawPrice !== undefined ? `$${Number(rawPrice).toFixed(2)}` : "-";
      const calls = String(skill.total_calls ?? skill.call_count ?? "-");
      const status = skill.is_active !== undefined ? (skill.is_active ? "active" : "inactive") : (skill.status ?? "-");

      console.log(
        `  ${chalk.cyan(name.padEnd(20))} ${category.padEnd(20)} ${chalk.green(price.padEnd(10))} ${calls.padEnd(8)} ${status.padEnd(10)}`
      );
    }
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch skills"));
    throw err;
  }
}
