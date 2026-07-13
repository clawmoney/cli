import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  intro,
  outro,
  confirm,
  spinner,
  isCancel,
  log,
  note,
} from "@clack/prompts";
import chalk from "chalk";

import { loadConfig } from "../utils/config.js";

import { spareaiDir } from "../utils/home.js";
const LOG_FILE = join(spareaiDir(), "verifier.log");

// Auto-verifier polls every 15 minutes and verifies up to 3 tweets per cycle.
// Each verification pays $0.01 via x402 witness. Upper bound at 24/7 saturation
// is 3 × 4/hr × 24 × 30 = 8,640/mo, but real demand caps it much lower —
// we deliberately quote the per-cycle rate so users see honest numbers.
const VERIFICATIONS_PER_CYCLE = 3;
const POLL_INTERVAL_MIN = 15;
const PRICE_PER_VERIFICATION = 0.01;

function formatEarnings(): string {
  const perHour = (60 / POLL_INTERVAL_MIN) * VERIFICATIONS_PER_CYCLE * PRICE_PER_VERIFICATION;
  const perDay = perHour * 24;
  const perMonth = perDay * 30;
  return [
    `Per cycle:  $${(VERIFICATIONS_PER_CYCLE * PRICE_PER_VERIFICATION).toFixed(2)} (${VERIFICATIONS_PER_CYCLE} verifications × $${PRICE_PER_VERIFICATION})`,
    `Cycle:      every ${POLL_INTERVAL_MIN} minutes`,
    `Upper bound: ~$${perHour.toFixed(2)}/hr · ~$${perDay.toFixed(2)}/day · ~$${perMonth.toFixed(0)}/mo`,
    chalk.dim("Actual earnings depend on how many tasks are awaiting verification."),
  ].join("\n");
}

export async function verifierSetupCommand(opts: { nested?: boolean } = {}): Promise<void> {
  if (!loadConfig()) {
    console.log(
      chalk.red(
        "\n  No config found. Run `spareai setup` first to register your agent.\n",
      ),
    );
    process.exit(1);
  }

  if (!opts.nested) {
    intro(chalk.cyan(" SpareAI Verifier Setup "));
  }
  log.message(
    "Run an auto-verifier daemon that earns by witnessing tweet promote tasks.",
  );

  note(formatEarnings(), "Earnings model");

  const startNow = await confirm({
    message: "Start the verifier daemon in the background now?",
    initialValue: true,
  });
  if (isCancel(startNow)) {
    log.message(chalk.dim("Skipped. Run `spareai promote auto-verify` later to start manually."));
    if (!opts.nested) outro("");
    return;
  }

  if (!startNow) {
    log.message(
      chalk.dim(
        `Skipped daemon launch. Manual start: ${chalk.cyan("spareai promote auto-verify")}`,
      ),
    );
    if (!opts.nested) outro("");
    return;
  }

  // Daemon launch: spawn detached so it survives this process exiting.
  // stdout/stderr go to ~/.spareai/verifier.log — same pattern as relay
  // daemon. We deliberately don't `setsid` here; users on macOS run from a
  // GUI shell and the parent's session id is fine.
  const claw = process.execPath; // node binary path; spareai bin script runs through it
  const cliMain = process.argv[1]; // path to dist/index.js
  const s = spinner();
  s.start("Spawning verifier daemon...");

  try {
    const out = await import("node:fs").then((m) => m.openSync(LOG_FILE, "a"));
    const child = spawn(claw, [cliMain, "promote", "auto-verify"], {
      detached: true,
      stdio: ["ignore", out, out],
      env: process.env,
    });
    child.unref();
    s.stop(`${chalk.green("✓")} Verifier daemon started (pid ${child.pid})`);

    log.message(
      [
        chalk.dim(`Logs:      ${LOG_FILE}`),
        chalk.dim(`Tail:      tail -f ${LOG_FILE}`),
        chalk.dim(`Stop:      kill ${child.pid}`),
        "",
        chalk.dim(
          "Tip: to keep it running across reboots, wrap it in a launchd plist",
        ),
        chalk.dim(
          "(same pattern as scripts/install-daemon-launchd.sh in this repo).",
        ),
      ].join("\n"),
    );
  } catch (err) {
    s.stop(chalk.red(`Failed to spawn verifier: ${(err as Error).message}`));
  }

  if (!opts.nested) {
    outro(chalk.green("Verifier setup done."));
  }
}
