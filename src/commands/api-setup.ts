/**
 * ClawMoney "API" provider setup.
 *
 * Enables this agent to serve SpareAPI marketplace requests via bnbot
 * browser delegation. End-to-end flow when a customer hits SpareAPI:
 *
 *   customer  →  spareapi.io/v1/<platform>/scrape/...
 *             →  ClawMoney router picks an online "api" operator
 *             →  this operator's bnbot daemon (local WS @ port 18900)
 *             →  real logged-in Chrome on the operator's machine
 *             →  target platform (X / XHS / IG / ...)
 *             ←  JSON results back through the chain
 *
 * This wizard only collects the operator's preferences (which platforms
 * to serve, soft RPM cap) and persists them to ~/.clawmoney/config.yaml.
 * The runtime piece — bnbot listening for ClawMoney router messages and
 * dispatching to the right scrape command — is provided separately by
 * the bnbot CLI (`bnbot serve`).
 */

import { spawn } from "node:child_process";

import {
  intro,
  outro,
  multiselect,
  text,
  confirm,
  spinner,
  isCancel,
  log,
  note,
} from "@clack/prompts";
import chalk from "chalk";

import { loadConfig, saveConfig } from "../utils/config.js";

// Platform catalog kept in sync with SpareAPI's services.ts. `price` is what
// the customer pays per call; operator keeps OPERATOR_SHARE of it.
const OPERATOR_SHARE = 0.7;

interface PlatformRow {
  value: string;             // slug — matches SpareAPI service.slug
  label: string;
  hint: string;
  pricePerCall: number;      // USD that the customer pays
  defaultDailyVolume: number; // estimate used for earnings projection
}

const PLATFORMS: PlatformRow[] = [
  { value: "x",            label: "X (Twitter)",   hint: "search · timeline · threads · DMs",       pricePerCall: 0.002, defaultDailyVolume: 800 },
  { value: "xiaohongshu",  label: "Xiaohongshu",   hint: "小红书 · search · note details",          pricePerCall: 0.010, defaultDailyVolume: 200 },
  { value: "instagram",    label: "Instagram",     hint: "posts · reels · stories · profiles",     pricePerCall: 0.012, defaultDailyVolume: 80 },
  { value: "linkedin",     label: "LinkedIn",      hint: "profiles · search · companies",          pricePerCall: 0.020, defaultDailyVolume: 30 },
  { value: "tiktok",       label: "TikTok",        hint: "search · user videos · trending",        pricePerCall: 0.005, defaultDailyVolume: 200 },
  { value: "reddit",       label: "Reddit",        hint: "threads · subreddit search",             pricePerCall: 0.005, defaultDailyVolume: 120 },
  { value: "google",       label: "Google Search", hint: "web · news · images",                    pricePerCall: 0.003, defaultDailyVolume: 400 },
  { value: "weibo",        label: "Weibo",         hint: "微博 · search · user timelines",         pricePerCall: 0.005, defaultDailyVolume: 60 },
  { value: "douyin",       label: "Douyin",        hint: "抖音 · trending · search",               pricePerCall: 0.005, defaultDailyVolume: 60 },
  { value: "youtube",      label: "YouTube",       hint: "search · channel data · transcripts",    pricePerCall: 0.005, defaultDailyVolume: 200 },
  { value: "bilibili",     label: "Bilibili",      hint: "B 站 · search · UP 主 · 评论",            pricePerCall: 0.005, defaultDailyVolume: 50 },
  { value: "zhihu",        label: "Zhihu",         hint: "知乎 · Q&A · 用户资料 · 热榜",            pricePerCall: 0.005, defaultDailyVolume: 50 },
];

function formatProjectedEarnings(selected: string[]): string {
  let monthly = 0;
  const lines: string[] = [];
  for (const slug of selected) {
    const p = PLATFORMS.find((x) => x.value === slug);
    if (!p) continue;
    const monthlyPlatform = p.pricePerCall * OPERATOR_SHARE * p.defaultDailyVolume * 30;
    monthly += monthlyPlatform;
    lines.push(
      `  ${p.label.padEnd(16)}  $${p.pricePerCall.toFixed(4)}/call  ×  ${p.defaultDailyVolume}/day  →  $${monthlyPlatform.toFixed(2)}/mo`,
    );
  }
  lines.push("");
  lines.push(
    `  ${chalk.bold("Projected total")}: ${chalk.green(`~$${monthly.toFixed(2)}/mo`)} ${chalk.dim(`(${Math.round(OPERATOR_SHARE * 100)}% operator share)`)}`,
  );
  return lines.join("\n");
}

export async function apiSetupCommand(opts: { nested?: boolean } = {}): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) {
    console.log(
      chalk.red(
        "\n  No config found. Run `clawmoney setup` first to register your agent.\n",
      ),
    );
    process.exit(1);
  }

  if (!opts.nested) {
    intro(chalk.cyan(" ClawMoney API Data Provider Setup "));
  }

  log.message(
    [
      "Serve SpareAPI marketplace requests via bnbot browser delegation.",
      "",
      chalk.dim(
        "Customer hits SpareAPI → ClawMoney routes to your agent → bnbot opens",
      ),
      chalk.dim(
        "the target site in real Chrome → JSON returns. You keep 70% per call.",
      ),
    ].join("\n"),
  );

  // Preselect whatever the operator already opted into.
  const previously = cfg.api_provider?.platforms ?? [];

  const picked = await multiselect({
    message: "Pick the platforms you want to serve — SPACE to toggle, ENTER to confirm:",
    options: PLATFORMS.map((p) => ({
      value: p.value,
      label: p.label,
      hint: p.hint,
    })),
    initialValues: previously,
    required: false,
  });

  if (isCancel(picked)) {
    log.message(chalk.dim("Cancelled. Re-run `clawmoney setup` later to enable the API role."));
    if (!opts.nested) outro("");
    return;
  }

  const platforms = picked as string[];

  if (platforms.length === 0) {
    note(
      [
        chalk.dim("No platforms selected. The API role stays disabled."),
        "",
        chalk.dim("You can come back any time:"),
        `  ${chalk.cyan("clawmoney setup")}     re-open the role wizard`,
      ].join("\n"),
      "Skipped",
    );
    if (!opts.nested) outro("");
    return;
  }

  // Show earnings projection so the operator can decide if it's worth it.
  note(formatProjectedEarnings(platforms), "Projected earnings");

  // Optional: let operator tweak RPM cap. Default 60 is conservative —
  // matches "human browsing" rate so platforms don't flag the account.
  const rpmRaw = await text({
    message: "Max requests / minute per platform (60 = human-rate, safe):",
    initialValue: String(cfg.api_provider?.max_rpm ?? 60),
    validate: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 600)
        return "Enter a number between 1 and 600.";
    },
  });
  if (isCancel(rpmRaw)) {
    log.message(chalk.dim("Cancelled."));
    if (!opts.nested) outro("");
    return;
  }
  const maxRpm = Number(rpmRaw);

  // Save to config.
  saveConfig({
    ...cfg,
    api_provider: {
      platforms,
      enabled_at: new Date().toISOString(),
      bnbot_port: cfg.api_provider?.bnbot_port ?? 18900,
      max_rpm: maxRpm,
    },
  });

  log.success(
    `Saved ${platforms.length} platform${platforms.length === 1 ? "" : "s"} to ~/.clawmoney/config.yaml`,
  );

  // Try to verify bnbot is installed + status check. We don't hard-fail
  // here — operator may run the bnbot daemon on a separate machine.
  const checkBnbot = await confirm({
    message: "Check that bnbot is installed and the agent is online?",
    initialValue: true,
  });
  if (!isCancel(checkBnbot) && checkBnbot) {
    const s = spinner();
    s.start("Running `bnbot status`…");
    try {
      await runOnce("bnbot", ["status"], 8000);
      s.stop(`${chalk.green("✓")} bnbot is installed and responsive`);
    } catch (err) {
      s.stop(
        chalk.yellow(
          `bnbot status check failed: ${(err as Error).message}`,
        ),
      );
      log.message(
        [
          chalk.dim("To install bnbot:"),
          `  ${chalk.cyan("npm i -g @bnbot/cli")}`,
          chalk.dim("Then start serving:"),
          `  ${chalk.cyan("bnbot serve")}`,
        ].join("\n"),
      );
    }
  }

  note(
    [
      chalk.bold("Next steps:"),
      "",
      `  1. ${chalk.cyan("bnbot serve")}                                start the local browser daemon`,
      `  2. Log in to selected platforms in the bnbot Chrome (one-time per account)`,
      `  3. ${chalk.cyan("clawmoney wallet balance")}                   confirm USDC wallet is set`,
      "",
      chalk.dim("Earnings settle in USDC every successful served request."),
      chalk.dim("Pause any platform: re-run `clawmoney setup` and uncheck it."),
    ].join("\n"),
    "Ready",
  );

  if (!opts.nested) {
    outro(chalk.green("API provider role enabled."));
  }
}

// Helper: run a child process once and resolve when it exits 0.
function runOnce(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore", shell: false });
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`exit code ${code}`));
    });
  });
}
