import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../utils/config.js";
import { apiGet, apiPost } from "../utils/api.js";
import { isRecord, parseNonNegativeNumber, parsePositiveInteger } from "../utils/validation.js";
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
    // Resolve daemon script path relative to this file's directory.
    // fileURLToPath correctly handles spaces and URL-escaped characters.
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const parentDir = dirname(thisDir);
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
      console.log(chalk.dim(`  CLI: ${options.cli || config.provider?.cli_command || "openclaw"}`));
      console.log(chalk.dim(`  API key: ${config.api_key.slice(0, 8)}...`));
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

// ── hub search ──

interface SearchOptions {
  query?: string;
  category?: string;
  sort?: string;
  limit?: string;
  maxPrice?: string;
}

interface SearchSkill {
  id?: string;
  skill_name?: string;
  description?: string;
  category?: string;
  price?: number;
  avg_rating?: number;
  total_calls?: number;
  avg_response_time?: number;
  agent_name?: string;
  agent_slug?: string;
  agent_is_online?: boolean;
}

export async function hubSearchCommand(options: SearchOptions): Promise<void> {
  const spinner = ora("Searching Hub...").start();

  try {
    const params = new URLSearchParams();
    if (options.query) params.set("q", options.query);
    if (options.category) params.set("category", options.category);
    if (options.sort) params.set("sort", options.sort);
    if (options.limit) params.set("limit", options.limit);
    if (options.maxPrice) params.set("max_price", options.maxPrice);
    params.set("online_only", "true");

    const resp = await apiGet<{ data?: SearchSkill[]; count?: number }>(
      `/api/v1/hub/skills/search?${params}`
    );

    if (!resp.ok) {
      spinner.fail(chalk.red(`Search failed (${resp.status})`));
      process.exit(1);
    }

    const skills = (resp.data as { data?: SearchSkill[] }).data ?? [];
    const count = (resp.data as { count?: number }).count ?? skills.length;

    spinner.succeed(`Found ${count} service(s)`);
    console.log("");

    if (skills.length === 0) {
      console.log(chalk.dim("  No services found. Try broader search terms."));
      return;
    }

    console.log(
      chalk.bold(
        `  ${"Agent".padEnd(18)} ${"Skill".padEnd(18)} ${"Category".padEnd(18)} ${"Price".padEnd(8)} ${"Rating".padEnd(8)} ${"Calls".padEnd(7)}`
      )
    );
    console.log(chalk.dim("  " + "-".repeat(79)));

    for (const s of skills) {
      const agent = (s.agent_name ?? s.agent_slug ?? "-").slice(0, 17);
      const name = (s.skill_name ?? "-").slice(0, 17);
      const category = (s.category ?? "-").slice(0, 17);
      const price = s.price !== undefined ? `$${s.price.toFixed(3)}` : "-";
      const rating = s.avg_rating != null ? s.avg_rating.toFixed(1) : "-";
      const calls = String(s.total_calls ?? 0);
      const online = s.agent_is_online ? chalk.green("●") : chalk.dim("○");

      console.log(
        `  ${online} ${chalk.cyan(agent.padEnd(17))} ${name.padEnd(18)} ${category.padEnd(18)} ${chalk.green(price.padEnd(8))} ${rating.padEnd(8)} ${calls.padEnd(7)}`
      );
    }
  } catch (err) {
    spinner.fail(chalk.red("Search failed"));
    throw err;
  }
}

// ── hub call ──

interface CallOptions {
  agent: string;
  skill: string;
  input?: string;
  timeout?: string;
}

export async function hubCallCommand(options: CallOptions): Promise<void> {
  const config = requireConfig();

  let inputData: Record<string, unknown> = {};
  if (options.input) {
    try {
      const parsed = JSON.parse(options.input) as unknown;
      if (!isRecord(parsed)) {
        console.error(chalk.red("Invalid JSON for --input. Expected a JSON object like '{\"prompt\":\"hello\"}'."));
        process.exit(1);
      }
      inputData = parsed;
    } catch {
      console.error(chalk.red("Invalid JSON for --input. Expected a JSON object like '{\"prompt\":\"hello\"}'."));
      process.exit(1);
    }
  }

  const timeout = parsePositiveInteger(options.timeout, 60, 'timeout', { min: 1, max: 3600 });
  const spinner = ora(`Calling ${options.agent}/${options.skill}...`).start();

  try {
    // gateway/invoke takes agent_id, skill, timeout as query params; input_data as POST body
    const qs = new URLSearchParams({
      agent_id: options.agent,
      skill: options.skill,
      timeout: String(timeout),
      payment_method: "ledger",
    });
    const resp = await apiPost<Record<string, unknown>>(
      `/api/v1/hub/gateway/invoke?${qs}`,
      inputData,
      config.api_key
    );

    if (!resp.ok) {
      const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
        ? (resp.data as Record<string, unknown>).detail
        : resp.data;
      const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
      spinner.fail(chalk.red(`Call failed (${resp.status}): ${detail}`));
      process.exit(1);
    }

    const result = resp.data as Record<string, unknown>;
    spinner.succeed(chalk.green("Call completed!"));
    console.log("");
    console.log(`  ${chalk.bold("Order:")}    ${result.id ?? "-"}`);
    console.log(`  ${chalk.bold("Duration:")} ${typeof result.duration === "number" ? result.duration.toFixed(1) + "s" : "-"}`);
    console.log(`  ${chalk.bold("Cost:")}     $${typeof result.price === "number" ? result.price.toFixed(3) : "-"}`);
    console.log("");
    console.log(chalk.bold("  Output:"));
    console.log(chalk.cyan("  " + JSON.stringify(result.output_data ?? result.output ?? {}, null, 2).replace(/\n/g, "\n  ")));
  } catch (err) {
    spinner.fail(chalk.red("Call failed"));
    throw err;
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

  let price: number;
  try {
    price = parseNonNegativeNumber(options.price, 'price');
  } catch (err) {
    console.error(chalk.red((err as Error).message));
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
