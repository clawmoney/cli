import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  intro,
  outro,
  multiselect,
  confirm,
  text,
  spinner,
  isCancel,
  cancel,
  log,
} from "@clack/prompts";
import chalk from "chalk";

import { apiPost } from "../utils/api.js";
import { requireConfig } from "../utils/config.js";
import { API_PRICES, RELAY_DISCOUNT, PLATFORM_FEE } from "../relay/pricing.js";

// ── Per-cli_type model catalogs ──
//
// `RECOMMENDED_MODELS` is what gets registered when the user picks "all
// recommended" — it's a curated subset of API_PRICES that maps to the
// models a typical end-user actually wants to expose. Old / preview /
// niche models are intentionally excluded from the default; the user
// can pick them via "select individually" if needed.
//
// `modelsForCli` returns the full set per cli_type drawn directly from
// API_PRICES so every priced model is available in the manual picker.

const RECOMMENDED_MODELS: Record<string, string[]> = {
  claude: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
  codex: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
  antigravity: [
    "antigravity-gemini-3-pro",
    "antigravity-claude-opus-4-6",
    "antigravity-claude-sonnet-4-6",
  ],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
};

function modelsForCli(cli: string): string[] {
  const all = Object.keys(API_PRICES);
  if (cli === "claude") {
    return all.filter((m) => m.startsWith("claude-"));
  }
  if (cli === "codex") {
    return all.filter(
      (m) =>
        m.startsWith("gpt-") || m.startsWith("o3") || m.startsWith("o4")
    );
  }
  if (cli === "antigravity") {
    return all.filter((m) => m.startsWith("antigravity-"));
  }
  if (cli === "gemini") {
    // Exclude antigravity-prefixed gemini variants — those are served by
    // the antigravity cli_type, not the standalone gemini cli_type.
    return all.filter(
      (m) => m.startsWith("gemini-") && !m.startsWith("antigravity-")
    );
  }
  return [];
}

// ── Local CLI detection ──

interface CliDetection {
  cli: string;
  available: boolean;
  hint: string;
}

function detectInstalledClis(): CliDetection[] {
  const results: CliDetection[] = [];

  // Binary-based CLIs: probe `which`. We intentionally don't try to
  // validate OAuth state here — the daemon's preflight does that on
  // first start, and probing OAuth from a sync setup wizard would be
  // brittle (keychain prompts, refresh-token races, etc).
  const binaries: Array<{ cli: string; bin: string }> = [
    { cli: "claude", bin: "claude" },
    { cli: "codex", bin: "codex" },
    { cli: "gemini", bin: "gemini" },
  ];

  for (const { cli, bin } of binaries) {
    let installed = false;
    try {
      execSync(`command -v ${bin}`, { stdio: "pipe" });
      installed = true;
    } catch {
      installed = false;
    }
    results.push({
      cli,
      available: installed,
      hint: installed
        ? "binary in PATH (login state will be validated when daemon starts)"
        : `${bin} not found in PATH`,
    });
  }

  // Antigravity is OAuth-file based — there's no `antigravity` binary
  // installed locally. We check for the OAuth credentials file that
  // `clawmoney antigravity login` writes.
  const antigravityFile = join(
    homedir(),
    ".clawmoney",
    "antigravity-accounts.json"
  );
  const antigravityAvailable = existsSync(antigravityFile);
  results.push({
    cli: "antigravity",
    available: antigravityAvailable,
    hint: antigravityAvailable
      ? "Google OAuth file present"
      : "no Google OAuth linked (run `clawmoney antigravity login` first)",
  });

  return results;
}

// ── Helpers ──

function formatPrice(input: number, output: number): string {
  return `$${input}/$${output} per 1M`;
}

function formatBuyerPrice(input: number, output: number): string {
  const buyerInput = (input * RELAY_DISCOUNT).toFixed(3);
  const buyerOutput = (output * RELAY_DISCOUNT).toFixed(3);
  return `$${buyerInput}/$${buyerOutput} per 1M (after ${Math.round(
    (1 - RELAY_DISCOUNT) * 100
  )}% relay discount)`;
}

// ── Main command ──

export async function relaySetupCommand(): Promise<void> {
  const config = requireConfig();

  intro(chalk.cyan(" ClawMoney Relay Setup "));
  log.message(
    "Sell your idle Claude Max / ChatGPT Pro / Google subscription capacity to other AI agents."
  );

  // ── Step 1: detect installed CLIs ──
  const detectSpin = spinner();
  detectSpin.start("Scanning for installed CLI clients...");
  const detected = detectInstalledClis();
  detectSpin.stop("Scan complete");

  for (const d of detected) {
    if (d.available) {
      log.success(`${chalk.bold(d.cli.padEnd(12))} ${chalk.dim(d.hint)}`);
    } else {
      log.warn(`${chalk.bold(d.cli.padEnd(12))} ${chalk.dim(d.hint)}`);
    }
  }

  const available = detected.filter((d) => d.available);
  if (available.length === 0) {
    log.error(
      "No supported CLI clients found locally. Install at least one of: " +
        chalk.cyan("claude, codex, gemini") +
        " — or run `clawmoney antigravity login` to link a Google account."
    );
    cancel("Setup aborted");
    process.exit(1);
  }

  // ── Step 2: pick which families to register ──
  const familyChoice = await multiselect({
    message:
      "Which CLI families do you want to provide? (space to toggle, enter to confirm)",
    options: available.map((d) => ({
      value: d.cli,
      label: d.cli,
      hint: d.hint,
    })),
    initialValues: available.map((d) => d.cli),
    required: true,
  });

  if (isCancel(familyChoice)) {
    cancel("Setup cancelled");
    process.exit(0);
  }

  const selectedClis = familyChoice as string[];

  // ── Step 3: per-family model selection ──
  type Registration = { cli: string; model: string; input: number; output: number };
  const registrations: Registration[] = [];

  for (const cli of selectedClis) {
    const allModels = modelsForCli(cli);
    const recommended = (RECOMMENDED_MODELS[cli] ?? []).filter((m) =>
      allModels.includes(m)
    );

    if (allModels.length === 0) {
      log.warn(`${cli}: no models found in pricing table — skipping`);
      continue;
    }

    log.step(`${chalk.bold(cli)}: choose models`);

    const useRecommended = await confirm({
      message: `Register the ${recommended.length} recommended ${cli} models? (${recommended.join(
        ", "
      )})`,
      initialValue: true,
    });

    if (isCancel(useRecommended)) {
      cancel("Setup cancelled");
      process.exit(0);
    }

    let chosen: string[];
    if (useRecommended) {
      chosen = recommended;
    } else {
      const picked = await multiselect({
        message: `Pick ${cli} models to register:`,
        options: allModels.map((m) => {
          const p = API_PRICES[m];
          return {
            value: m,
            label: m,
            hint: formatPrice(p.input, p.output),
          };
        }),
        initialValues: recommended,
        required: true,
      });

      if (isCancel(picked)) {
        cancel("Setup cancelled");
        process.exit(0);
      }
      chosen = picked as string[];
    }

    for (const model of chosen) {
      const p = API_PRICES[model];
      registrations.push({
        cli,
        model,
        input: p.input,
        output: p.output,
      });
    }
  }

  if (registrations.length === 0) {
    cancel("No models selected — nothing to register");
    process.exit(0);
  }

  // ── Step 4: global concurrency + daily budget ──
  const concurrencyAns = await text({
    message:
      "Concurrency cap per provider? (1-5 recommended; higher looks less like a single power user to upstream fingerprint detection)",
    placeholder: "5",
    defaultValue: "5",
    validate: (v) => {
      const n = parseInt(v || "5", 10);
      if (Number.isNaN(n) || n < 1 || n > 20) {
        return "Must be a number between 1 and 20";
      }
      return undefined;
    },
  });

  if (isCancel(concurrencyAns)) {
    cancel("Setup cancelled");
    process.exit(0);
  }

  const dailyLimitAns = await text({
    message:
      "Daily API spend cap per provider in USD? (the daemon stops accepting requests when exceeded)",
    placeholder: "15",
    defaultValue: "15",
    validate: (v) => {
      const n = parseFloat(v || "15");
      if (Number.isNaN(n) || n < 0) {
        return "Must be a non-negative number";
      }
      return undefined;
    },
  });

  if (isCancel(dailyLimitAns)) {
    cancel("Setup cancelled");
    process.exit(0);
  }

  const concurrency = parseInt(concurrencyAns as string, 10);
  const dailyLimit = parseFloat(dailyLimitAns as string);

  // ── Step 5: confirmation summary ──
  log.step(chalk.bold("Summary"));
  for (const r of registrations) {
    log.message(
      `  ${chalk.cyan(r.cli + "/" + r.model).padEnd(50)} ${chalk.dim(
        formatBuyerPrice(r.input, r.output)
      )}`
    );
  }
  log.message(
    chalk.dim(
      `  ${registrations.length} providers · concurrency=${concurrency} · daily_limit=$${dailyLimit}`
    )
  );
  log.message(
    chalk.dim(
      `  You earn ~${Math.round(
        (1 - PLATFORM_FEE) * 100
      )}% of what buyers pay (after platform fee)`
    )
  );

  const proceed = await confirm({
    message: `Register all ${registrations.length} providers now?`,
    initialValue: true,
  });

  if (isCancel(proceed) || !proceed) {
    cancel("Setup cancelled");
    process.exit(0);
  }

  // ── Step 6: register each (idempotent — "already registered" counts as success) ──
  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ cli: string; model: string; error: string }> = [];

  for (const r of registrations) {
    const regSpin = spinner();
    regSpin.start(`Registering ${r.cli}/${r.model}...`);

    try {
      const body = {
        cli_type: r.cli,
        model: r.model,
        mode: "chat",
        concurrency,
        daily_limit_usd: dailyLimit,
        price_input_per_m: r.input,
        price_output_per_m: r.output,
      };

      const resp = await apiPost<Record<string, unknown>>(
        "/api/v1/relay/providers",
        body,
        config.api_key
      );

      if (resp.ok) {
        regSpin.stop(`${chalk.green("✓")} ${r.cli}/${r.model}`);
        succeeded++;
      } else {
        const raw =
          resp.data && typeof resp.data === "object" && "detail" in resp.data
            ? (resp.data as Record<string, unknown>).detail
            : resp.data;
        const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
        // Already-registered is a soft success — idempotent re-run.
        if (detail.includes("Already registered")) {
          regSpin.stop(
            `${chalk.yellow("~")} ${r.cli}/${r.model} ${chalk.dim(
              "(already registered, no change)"
            )}`
          );
          succeeded++;
        } else {
          regSpin.stop(
            `${chalk.red("✗")} ${r.cli}/${r.model} ${chalk.dim(
              "(" + detail.slice(0, 80) + ")"
            )}`
          );
          failed++;
          failures.push({ cli: r.cli, model: r.model, error: detail });
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      regSpin.stop(
        `${chalk.red("✗")} ${r.cli}/${r.model} ${chalk.dim("(" + msg + ")")}`
      );
      failed++;
      failures.push({ cli: r.cli, model: r.model, error: msg });
    }
  }

  // ── Step 7: next steps ──
  log.step(chalk.bold("Done"));
  log.message(`${chalk.green(succeeded.toString())} providers registered`);
  if (failed > 0) {
    log.warn(`${failed} registrations failed`);
    for (const f of failures) {
      log.message(chalk.dim(`  ${f.cli}/${f.model}: ${f.error.slice(0, 120)}`));
    }
  }

  log.message("");
  log.message(chalk.bold("Next steps"));
  log.message("  Start the daemon for each cli_type you registered:");
  for (const cli of selectedClis) {
    log.message(`    ${chalk.cyan(`clawmoney relay start --cli ${cli}`)}`);
  }
  log.message("");
  log.message("  Useful follow-up commands:");
  log.message(
    `    ${chalk.cyan(
      "clawmoney relay status"
    )}        # check daemon health + provider list`
  );
  log.message(
    `    ${chalk.cyan(
      "clawmoney relay credits"
    )}       # check earnings + payout balance`
  );
  log.message(
    `    ${chalk.cyan(
      "clawmoney relay stop"
    )}          # stop the daemon`
  );

  outro(chalk.green("Setup complete"));
}
