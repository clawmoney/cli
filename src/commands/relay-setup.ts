import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  intro,
  outro,
  multiselect,
  confirm,
  select,
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
// recommended" — it's a curated subset of API_PRICES that mirrors what
// each CLI's NATIVE /model picker exposes by default. Cross-checked
// against:
//   - Claude Code 2.1.x /model menu (4 entries → 3 unique IDs;
//     Sonnet 1M is the same model + context-1m beta header)
//   - Codex CLI 0.117.x /model menu (4 entries: gpt-5.4 current,
//     gpt-5.4-mini, gpt-5.3-codex, gpt-5.2)
//   - sub2api backend/internal/pkg/gemini/models.go DefaultModels()
//     for the Gemini CLI catalog
//   - sub2api backend/internal/pkg/antigravity/claude_types.go
//     claudeModels + geminiModels for the Antigravity catalog
//
// The "manual select" path (when the user says no to recommended)
// falls through to modelsForCli(cli) which returns EVERY priced
// model in that family.

const RECOMMENDED_MODELS: Record<string, string[]> = {
  // Claude Code /model menu: Default(Sonnet 4.6) / Sonnet(1M) / Opus(1M) / Haiku
  // → 3 unique model IDs (Sonnet 1M = same model + context-1m beta)
  claude: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],

  // Codex CLI /model menu: gpt-5.4 (current frontier) / gpt-5.4-mini /
  // gpt-5.3-codex (Codex-optimized) / gpt-5.2 (long-running pro)
  codex: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"],

  // Gemini CLI exposes a long list; mainstream picks are the production-
  // stable 2.5 line (pro + flash) and the latest 3.x preview (pro + flash).
  // Image / thinking variants and lite/customtools are intentionally
  // skipped from the recommended set — users can pick them manually.
  gemini: [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
  ],

  // Antigravity exposes Claude Opus/Sonnet AND Gemini Pro/Flash via the
  // SAME Google Antigravity OAuth token (one of its main selling points
  // for providers). Recommended set spans both halves so a single
  // antigravity provider serves both Anthropic and Google buyers.
  antigravity: [
    "antigravity-claude-sonnet-4-6",
    "antigravity-claude-opus-4-6",
    "antigravity-gemini-3-pro",
    "antigravity-gemini-3-flash",
    "antigravity-gemini-2.5-pro",
  ],
};

function modelsForCli(cli: string): string[] {
  const all = Object.keys(API_PRICES);
  if (cli === "claude") {
    return all.filter((m) => m.startsWith("claude-"));
  }
  if (cli === "codex") {
    // Only gpt-5.x family — o3/o4 reasoning models are public Responses
    // API only, NOT served by Codex CLI's internal ChatGPT WS path.
    // They're in API_PRICES for OpenAI SDK callers via /v1/chat/completions
    // but a `codex` daemon can't actually serve them.
    return all.filter((m) => m.startsWith("gpt-"));
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
    "Sell your spare Claude Max / ChatGPT Pro / Google subscription capacity to other AI agents."
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

  // ── Step 4: per-provider daily quota share ──
  //
  // We deliberately don't show USD earnings projections in this prompt
  // because they'd be misleading:
  //
  // - `daily_limit_usd` is per-provider (per model row), not per-account.
  //   If a user registers 4 codex models on one ChatGPT account, total
  //   daily cap = 4 × this value, not this value. Showing "$15/day cap"
  //   makes them think it's their account-wide total.
  //
  // - Different models have wildly different prices (claude-opus is
  //   $5/$25 per Mtok, haiku is $1/$5). A flat USD cap means very
  //   different token volumes per model — there's no single "fair
  //   share" number we can show.
  //
  // - Multiple CLI families = multiple independent subscriptions. A
  //   user with claude + codex + gemini has three separate quota
  //   pools. A single "% of subscription" framing per the wizard
  //   can't express that cleanly.
  //
  // Solution: ask the user for a percentage (~10/25/50/100) which maps
  // internally to a per-provider USD cap, but only SHOW the percentage
  // in the prompt. Earnings depend on real buyer demand × per-model
  // pricing × number of providers; we can't predict that, so we don't
  // pretend to.
  const concurrency = 5;

  const dailyLimitChoice = await select({
    message:
      "Daily quota share per model? (applies independently to each model you register)",
    options: [
      {
        value: 15,
        label: "~25%  ·  Light",
        hint: "share a quarter, leaves 75% for your personal use",
      },
      {
        value: 30,
        label: "~50%  ·  Balanced  (recommended)",
        hint: "splits each model's quota evenly between you and the relay",
      },
      {
        value: 45,
        label: "~75%  ·  Heavy",
        hint: "most of your subscription goes to relay, 25% reserved for personal use",
      },
      {
        value: 60,
        label: "~100% ·  Full",
        hint: "dedicates your subscription to relay — best for accounts you don't use personally",
      },
    ],
    initialValue: 30,
  });

  if (isCancel(dailyLimitChoice)) {
    cancel("Setup cancelled");
    process.exit(0);
  }

  const dailyLimit = dailyLimitChoice as number;

  // ── Step 5: confirmation summary ──
  // Translate the chosen daily-limit USD value back into the percentage
  // label the user picked, so what they see in the summary matches what
  // they answered in the prompt.
  const limitLabel: Record<number, string> = {
    15: "~25% (Light)",
    30: "~50% (Balanced)",
    45: "~75% (Heavy)",
    60: "~100% (Full)",
  };

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
      `  ${registrations.length} provider(s) · ${limitLabel[dailyLimit] ?? `$${dailyLimit}/day cap`} per model`
    )
  );
  log.message(
    chalk.dim(
      `  You earn ~${Math.round(
        (1 - PLATFORM_FEE) * 100
      )}% of what buyers pay (after platform fee)`
    )
  );
  log.message(
    chalk.dim(
      `  To customize: edit ~/.clawmoney/config.yaml after start`
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

  // ── Step 7: registration done, offer to auto-start ──
  log.step(chalk.bold("Registered"));
  log.message(`${chalk.green(succeeded.toString())} provider(s) registered`);
  if (failed > 0) {
    log.warn(`${failed} registrations failed`);
    for (const f of failures) {
      log.message(chalk.dim(`  ${f.cli}/${f.model}: ${f.error.slice(0, 120)}`));
    }
  }

  // ── Step 8: auto-start the daemon ──
  //
  // Daemon limitation: a single clawmoney process can only serve ONE
  // cli_type today (single ~/.clawmoney/relay.pid file). When the user
  // registered providers across multiple cli_types we can still
  // auto-start ONE of them and tell them how to switch later. Tracked
  // separately as a daemon refactor task.
  const uniqueClis = Array.from(new Set(selectedClis));

  if (uniqueClis.length === 1) {
    // Single cli_type — go straight into the daemon. The user already
    // confirmed "Register all N providers?" above, so asking a second
    // time just adds friction.
    const cli = uniqueClis[0];
    const { relayStartCommand } = await import("./relay.js");
    try {
      await relayStartCommand({ cli });
    } catch (err) {
      log.error(
        `Failed to start daemon: ${(err as Error).message}\n` +
          `Try manually: ${chalk.cyan(`clawmoney relay start --cli ${cli}`)}`
      );
      outro(chalk.yellow("Setup complete (daemon not started)"));
      return;
    }

    log.message("");
    log.message(chalk.dim("Useful follow-up commands:"));
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
    outro(chalk.green("Setup complete · daemon running"));
    return;
  }

  // Multi cli_type — daemon can only host one at a time today. Start
  // the first registered cli_type directly and tell the user how to
  // switch to the others later.
  const firstCli = uniqueClis[0];
  log.warn(
    `You registered providers across ${uniqueClis.length} CLI families ` +
      `(${uniqueClis.join(", ")}). The daemon currently serves ONE cli_type ` +
      `per process — starting ${chalk.cyan(firstCli)} first.`
  );

  const { relayStartCommand } = await import("./relay.js");
  try {
    await relayStartCommand({ cli: firstCli });
  } catch (err) {
    log.error(
      `Failed to start daemon: ${(err as Error).message}\n` +
        `Try manually: ${chalk.cyan(`clawmoney relay start --cli ${firstCli}`)}`
    );
    outro(chalk.yellow("Setup complete (daemon not started)"));
    return;
  }

  log.message("");
  log.message(chalk.dim("To switch to a different cli_type later:"));
  log.message(
    chalk.dim(
      `    ${chalk.cyan("clawmoney relay stop")} && ${chalk.cyan(
        "clawmoney relay start --cli <other-cli>"
      )}`
    )
  );
  outro(chalk.green(`Setup complete · ${firstCli} daemon running`));
}
