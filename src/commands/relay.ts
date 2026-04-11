import { spawn, execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../utils/config.js";
import { apiGet, apiPost } from "../utils/api.js";
import { readRelayPid, isRelayPidAlive, removeRelayPid } from "../relay/provider.js";
import { API_PRICES, RELAY_DISCOUNT } from "../relay/pricing.js";

const LOG_FILE = join(homedir(), ".clawmoney", "relay.log");

// ── relay register ──

interface RegisterOptions {
  cli: string;
  model: string;
  mode?: string;
  concurrency?: string;
  dailyLimit?: string;
  priceInput?: string;
  priceOutput?: string;
}

export async function relayRegisterCommand(options: RegisterOptions): Promise<void> {
  const config = requireConfig();

  // Validate CLI type
  const validClis = ["claude", "codex", "gemini", "antigravity"];
  if (!validClis.includes(options.cli)) {
    console.error(chalk.red(`Invalid CLI type "${options.cli}". Must be one of: ${validClis.join(", ")}`));
    process.exit(1);
  }

  // Antigravity is api-only — there is no local CLI binary. For the other
  // types we still probe `which` so misconfigured boxes fail fast.
  if (options.cli === "antigravity") {
    const spinner = ora("Checking Antigravity OAuth token...").start();
    try {
      const { loadAccounts } = await import("../relay/upstream/antigravity-api.js");
      const file = loadAccounts();
      if (file.accounts.length === 0) {
        spinner.fail(chalk.red("No Antigravity accounts found."));
        console.log(
          chalk.dim(`  Run "clawmoney antigravity login" first to link a Google account.`)
        );
        process.exit(1);
      }
      spinner.succeed(
        `Antigravity linked (${file.accounts[0]!.email ?? "email unknown"})`
      );
    } catch (err) {
      spinner.fail(chalk.red(`Antigravity token check failed: ${(err as Error).message}`));
      process.exit(1);
    }
  } else {
    const spinner = ora(`Checking if ${options.cli} is installed...`).start();
    try {
      execSync(`which ${options.cli}`, { stdio: "pipe" });
      spinner.succeed(`${options.cli} is available`);
    } catch {
      spinner.fail(chalk.red(`${options.cli} is not installed or not in PATH`));
      console.log(chalk.dim(`  Make sure ${options.cli} CLI is installed and accessible.`));
      process.exit(1);
    }
  }

  // Auto-populate prices from the LiteLLM-sourced pricing table. Providers
  // register at the FULL official API price; the Hub applies RELAY_DISCOUNT
  // at charge time so buyers pay a fixed fraction across all platforms.
  const known = API_PRICES[options.model];
  if (!known && (options.priceInput == null || options.priceOutput == null)) {
    console.error(
      chalk.red(`Unknown model "${options.model}". Pricing table has no entry.`)
    );
    console.log(
      chalk.dim(
        `  Either add it to clawmoney-cli/src/relay/pricing.ts, or pass both ` +
          `--price-input and --price-output explicitly.`
      )
    );
    process.exit(1);
  }
  const priceInput = options.priceInput != null
    ? parseFloat(options.priceInput)
    : known!.input;
  const priceOutput = options.priceOutput != null
    ? parseFloat(options.priceOutput)
    : known!.output;

  const regSpinner = ora("Registering as relay provider...").start();

  try {
    const body = {
      cli_type: options.cli,
      model: options.model,
      mode: options.mode ?? "chat",
      concurrency: parseInt(options.concurrency ?? "5", 10),
      daily_limit_usd: parseFloat(options.dailyLimit ?? "20"),
      price_input_per_m: priceInput,
      price_output_per_m: priceOutput,
    };

    const resp = await apiPost<Record<string, unknown>>(
      "/api/v1/relay/providers",
      body,
      config.api_key
    );

    if (!resp.ok) {
      const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
        ? (resp.data as Record<string, unknown>).detail
        : resp.data;
      const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
      regSpinner.fail(chalk.red(`Registration failed (${resp.status}): ${detail}`));
      process.exit(1);
    }

    const data = resp.data as Record<string, unknown>;
    regSpinner.succeed(chalk.green("Registered as relay provider!"));
    console.log("");
    console.log(`  ${chalk.bold("Provider ID:")}   ${data.id ?? data.provider_id ?? "-"}`);
    console.log(`  ${chalk.bold("CLI:")}           ${options.cli}`);
    console.log(`  ${chalk.bold("Model:")}         ${options.model}`);
    console.log(`  ${chalk.bold("Mode:")}          ${options.mode ?? "chat"}`);
    console.log(`  ${chalk.bold("Concurrency:")}   ${body.concurrency}`);
    console.log(`  ${chalk.bold("Daily Limit:")}   $${body.daily_limit_usd}`);
    console.log(`  ${chalk.bold("Input Price:")}   $${body.price_input_per_m}/1M tokens (official API)`);
    console.log(`  ${chalk.bold("Output Price:")}  $${body.price_output_per_m}/1M tokens (official API)`);
    const discountPct = Math.round(RELAY_DISCOUNT * 100);
    console.log(
      chalk.dim(
        `  Buyers pay ${discountPct}% of the official API price — a ${100 - discountPct}% discount applied by the Hub.`
      )
    );
    console.log("");
    console.log(chalk.bold("  Next steps"));
    console.log(chalk.dim(`    1. Start the daemon:`));
    console.log(chalk.dim(`         clawmoney relay start`));
    if (process.platform === "darwin") {
      console.log(
        chalk.dim(
          `    2. (macOS) Install the daemon as a launchd user agent so it`
        )
      );
      console.log(
        chalk.dim(
          `       survives logouts AND keeps macOS Keychain unlocked for`
        )
      );
      console.log(
        chalk.dim(
          `       Claude API mode (SSH shells can't read a locked Keychain):`
        )
      );
      console.log(
        chalk.dim(
          `         ./scripts/install-daemon-launchd.sh`
        )
      );
      console.log(
        chalk.dim(
          `       (from the clawmoney-cli repo; see scripts/README for details)`
        )
      );
    }
    console.log("");
    console.log(
      chalk.dim(
        `  Tip: the daemon now defaults to direct-API mode (execution_mode: api)`
      )
    );
    console.log(
      chalk.dim(
        `  for ~10x lower latency per request. To fall back to subprocess-per-`
      )
    );
    console.log(
      chalk.dim(
        `  request mode, set \`relay.execution_mode: cli\` in ~/.clawmoney/config.yaml.`
      )
    );
  } catch (err) {
    regSpinner.fail(chalk.red("Registration failed"));
    throw err;
  }
}

// ── relay start ──

export async function relayStartCommand(options: { cli?: string }): Promise<void> {
  const config = requireConfig();

  // Check if already running
  const existingPid = readRelayPid();
  if (existingPid && isRelayPidAlive(existingPid)) {
    console.log(
      chalk.yellow(
        `Relay Provider is already running (PID ${existingPid}). Use "clawmoney relay stop" first.`
      )
    );
    return;
  }

  const spinner = ora("Starting Relay Provider...").start();

  try {
    // Resolve daemon script path relative to this file's directory
    const thisDir = import.meta.url.replace("file://", "").replace(/\/[^/]+$/, "");
    const parentDir = thisDir.replace(/\/[^/]+$/, "");
    const daemonScript = join(parentDir, "relay", "daemon.js");

    const args = [daemonScript];
    if (options.cli) {
      args.push("--cli", options.cli);
    }

    const child = spawn(process.execPath, args, {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        CLAWMONEY_RELAY_DAEMON: "1",
      },
    });

    child.unref();

    // Give the daemon a moment to start and write PID
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const pid = readRelayPid();
    if (pid && isRelayPidAlive(pid)) {
      spinner.succeed(chalk.green(`Relay Provider started (PID ${pid})`));
      console.log(chalk.dim(`  Log file: ${LOG_FILE}`));
      console.log(chalk.dim(`  CLI: ${options.cli || "claude (default)"}`));
      console.log(chalk.dim(`  API key: ${config.api_key.slice(0, 8)}...`));
    } else {
      spinner.fail(
        chalk.red(
          "Failed to start Relay Provider. Check logs at: " + LOG_FILE
        )
      );
      process.exit(1);
    }
  } catch (err) {
    spinner.fail(chalk.red("Failed to start Relay Provider"));
    throw err;
  }
}

// ── relay stop ──

export async function relayStopCommand(): Promise<void> {
  const pid = readRelayPid();

  if (!pid) {
    console.log(chalk.dim("Relay Provider is not running (no PID file)."));
    return;
  }

  if (!isRelayPidAlive(pid)) {
    console.log(
      chalk.dim(
        `Relay Provider PID ${pid} is not alive. Cleaning up PID file.`
      )
    );
    removeRelayPid();
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(chalk.green(`Relay Provider stopped (PID ${pid}).`));
  } catch (err) {
    console.error(
      chalk.red(`Failed to stop process ${pid}:`),
      (err as Error).message
    );
  }

  // Wait briefly for cleanup, then ensure PID file is removed
  await new Promise((resolve) => setTimeout(resolve, 500));
  removeRelayPid();
}

// ── relay status ──

interface ProviderStatus {
  id?: string;
  provider_id?: string;
  cli_type?: string;
  model?: string;
  mode?: string;
  status?: string;
  concurrency?: number;
  current_load?: number;
  daily_spent_usd?: number;
  daily_limit_usd?: number;
  total_earned_usd?: number;
  total_requests?: number;
  price_input_per_m?: number;
  price_output_per_m?: number;
  created_at?: string;
  detail?: string;
}

export async function relayStatusCommand(): Promise<void> {
  const config = requireConfig();

  // Local process status
  const pid = readRelayPid();
  if (pid && isRelayPidAlive(pid)) {
    console.log(chalk.green(`  Local process: running (PID ${pid})`));
  } else if (pid) {
    console.log(chalk.yellow(`  Local process: stale PID ${pid}`));
    removeRelayPid();
  } else {
    console.log(chalk.dim("  Local process: not running"));
  }

  // Remote status
  const spinner = ora("Fetching relay provider status...").start();

  try {
    const resp = await apiGet<ProviderStatus>(
      "/api/v1/relay/providers/me",
      config.api_key
    );

    if (!resp.ok) {
      if (resp.status === 404) {
        spinner.info("Not registered as relay provider yet.");
        console.log(chalk.dim(`  Run "clawmoney relay register" to get started.`));
        return;
      }
      const detail = (resp.data as ProviderStatus)?.detail ?? resp.status;
      spinner.fail(chalk.red(`Failed to fetch status: ${detail}`));
      process.exit(1);
    }

    const data = resp.data;
    const statusColor = data.status === "online" ? chalk.green : data.status === "offline" ? chalk.dim : chalk.yellow;

    spinner.succeed("Relay Provider Status");
    console.log("");
    console.log(`  ${chalk.bold("Provider ID:")}   ${data.id ?? data.provider_id ?? "-"}`);
    console.log(`  ${chalk.bold("Status:")}        ${statusColor(data.status ?? "-")}`);
    console.log(`  ${chalk.bold("CLI:")}           ${data.cli_type ?? "-"}`);
    console.log(`  ${chalk.bold("Model:")}         ${data.model ?? "-"}`);
    console.log(`  ${chalk.bold("Mode:")}          ${data.mode ?? "-"}`);
    console.log(`  ${chalk.bold("Concurrency:")}   ${data.concurrency ?? "-"}`);
    console.log(`  ${chalk.bold("Current Load:")}  ${data.current_load ?? 0}`);
    console.log(`  ${chalk.bold("Daily Spent:")}   $${(data.daily_spent_usd ?? 0).toFixed(2)} / $${(data.daily_limit_usd ?? 0).toFixed(2)}`);
    console.log(`  ${chalk.bold("Total Earned:")}  $${(data.total_earned_usd ?? 0).toFixed(2)}`);
    console.log(`  ${chalk.bold("Total Requests:")} ${data.total_requests ?? 0}`);
    console.log(`  ${chalk.bold("Input Price:")}   $${data.price_input_per_m ?? "-"}/1M tokens`);
    console.log(`  ${chalk.bold("Output Price:")}  $${data.price_output_per_m ?? "-"}/1M tokens`);
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch status"));
    throw err;
  }
}

// ── relay models (consumer view) ──

interface RelayModel {
  model?: string;
  cli_type?: string;
  provider_count?: number;
  avg_price_input?: number;
  avg_price_output?: number;
  min_price_input?: number;
  min_price_output?: number;
  available?: boolean;
}

export async function relayModelsCommand(): Promise<void> {
  const spinner = ora("Fetching available relay models...").start();

  try {
    const resp = await apiGet<{ data?: RelayModel[]; models?: RelayModel[] }>(
      "/api/v1/relay/models"
    );

    if (!resp.ok) {
      spinner.fail(chalk.red(`Failed to fetch models (${resp.status})`));
      process.exit(1);
    }

    const models = (resp.data as { data?: RelayModel[] }).data
      ?? (resp.data as { models?: RelayModel[] }).models
      ?? [];

    spinner.succeed(`Available Relay Models (${models.length})`);
    console.log("");

    if (models.length === 0) {
      console.log(chalk.dim("  No relay models available at the moment."));
      return;
    }

    console.log(
      chalk.bold(
        `  ${"Model".padEnd(28)} ${"CLI".padEnd(10)} ${"Providers".padEnd(12)} ${"Input $/1M".padEnd(14)} ${"Output $/1M".padEnd(14)}`
      )
    );
    console.log(chalk.dim("  " + "-".repeat(80)));

    for (const m of models) {
      const model = (m.model ?? "-").slice(0, 27);
      const cli = (m.cli_type ?? "-").slice(0, 9);
      const providers = String(m.provider_count ?? 0);
      const inputPrice = m.min_price_input != null ? `$${m.min_price_input.toFixed(2)}` : "-";
      const outputPrice = m.min_price_output != null ? `$${m.min_price_output.toFixed(2)}` : "-";
      const available = m.available !== false ? chalk.green("●") : chalk.dim("○");

      console.log(
        `  ${available} ${chalk.cyan(model.padEnd(27))} ${cli.padEnd(10)} ${providers.padEnd(12)} ${chalk.green(inputPrice.padEnd(14))} ${chalk.green(outputPrice.padEnd(14))}`
      );
    }
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch models"));
    throw err;
  }
}

// ── relay credits (consumer view) ──

interface RelayCredits {
  balance_usd?: number;
  total_spent_usd?: number;
  total_requests?: number;
  last_used_at?: string;
  detail?: string;
}

export async function relayCreditsCommand(): Promise<void> {
  const config = requireConfig();

  const spinner = ora("Fetching relay credits...").start();

  try {
    const resp = await apiGet<RelayCredits>(
      "/api/v1/relay/credits",
      config.api_key
    );

    if (!resp.ok) {
      const detail = (resp.data as RelayCredits)?.detail ?? resp.status;
      spinner.fail(chalk.red(`Failed to fetch credits: ${detail}`));
      process.exit(1);
    }

    const data = resp.data;
    spinner.succeed("Relay Credits");
    console.log("");
    console.log(`  ${chalk.bold("Balance:")}        $${(data.balance_usd ?? 0).toFixed(2)}`);
    console.log(`  ${chalk.bold("Total Spent:")}    $${(data.total_spent_usd ?? 0).toFixed(2)}`);
    console.log(`  ${chalk.bold("Total Requests:")} ${data.total_requests ?? 0}`);
    if (data.last_used_at) {
      console.log(`  ${chalk.bold("Last Used:")}      ${data.last_used_at}`);
    }
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch credits"));
    throw err;
  }
}
