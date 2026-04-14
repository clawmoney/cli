import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  intro,
  outro,
  multiselect,
  select,
  spinner,
  isCancel,
  cancel,
  log,
} from "@clack/prompts";
import chalk from "chalk";

import { apiPost } from "../utils/api.js";
import { loadConfig, requireConfig } from "../utils/config.js";
import { setupCommand } from "./setup.js";
import { API_PRICES, PLATFORM_FEE } from "../relay/pricing.js";
import {
  hasClaudeFingerprint,
  bootstrapClaudeFingerprint,
} from "../relay/upstream/claude-bootstrap.js";

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

  // Codex CLI /model menu (verified April 2026, v0.12x):
  //   gpt-5.3-codex (default)  — latest frontier agentic coding
  //   gpt-5.4 (current)        — latest frontier agentic coding
  //   gpt-5.2-codex            — prior frontier agentic coding
  //   gpt-5.1-codex-max        — Codex-optimized flagship (deep+fast)
  //   gpt-5.2                  — latest frontier general model
  //   gpt-5.1-codex-mini       — cheap/fast/smaller Codex
  // gpt-5.4-mini is NOT in Codex CLI's menu — ChatGPT's Plus API offers
  // it but Codex CLI doesn't expose it, so serving it as a Codex-family
  // provider would never see traffic. Dropped from the recommended list.
  codex: [
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.2",
    "gpt-5.1-codex-mini",
  ],

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

// ── Main command ──

export async function relaySetupCommand(): Promise<void> {
  // ── Step 0: ensure the agent is logged in ──
  //
  // Relay setup relies on an ACTIVE ClawMoney agent (api_key + agent_id
  // in ~/.clawmoney/config.yaml) to register provider rows and to auth
  // the daemon's WS connection. If the user runs `clawmoney relay setup`
  // before ever running `clawmoney setup`, we inline the login flow
  // here instead of throwing a raw "No config found" error. The nested
  // setupCommand uses its own ora/prompt UI — visually different from
  // the clack wizard below, but that's acceptable since it only runs on
  // the first-time-user path.
  let existing = loadConfig();
  if (!existing) {
    // setup prints its own "ClawMoney Agent Setup" header so the
    // handoff is self-explanatory — no extra narration needed.
    await setupCommand();
    existing = loadConfig();
    if (!existing) {
      console.log(
        chalk.red(
          "\n  Login did not complete. Run `clawmoney setup` manually, then re-run `clawmoney relay setup`.\n"
        )
      );
      process.exit(1);
    }
    console.log("");
  }

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

  // Collapse per-CLI rows into one summary line — users only care
  // about "which ones can I lend" at this step, not per-binary hints.
  // When the user is missing some families we don't name them (negative
  // framing — they came to provide what they have, not hear what they
  // lack); instead we add a soft note that ClawMoney supports more
  // platforms than what was detected locally.
  const available = detected.filter((d) => d.available);
  const hasMissing = detected.some((d) => !d.available);

  if (available.length > 0) {
    log.success(
      `Found: ${chalk.bold(available.map((d) => d.cli).join(", "))}`
    );
    if (hasMissing) {
      log.message(
        chalk.dim(
          "(ClawMoney supports claude, codex, gemini, and antigravity — only these were detected on this machine)"
        )
      );
    }
  }
  if (available.length === 0) {
    log.error(
      "No supported CLI clients found locally. Install at least one of: " +
        chalk.cyan("claude, codex, gemini") +
        " — or run `clawmoney antigravity login` to link a Google account."
    );
    cancel("Setup aborted");
    process.exit(1);
  }

  // ── Step 2: pick which subscriptions to register ──
  const familyChoice = await multiselect({
    message:
      "Which subscriptions do you want to provide? (space to toggle, enter to confirm)",
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

  // ── Step 2b: bootstrap per-cli fingerprints if missing ──
  //
  // Claude / Codex / Gemini daemons each need a fingerprint file
  // (~/.clawmoney/<cli>-fingerprint.json) to mimic the real CLI's
  // device_id + account_uuid when relaying requests. Without it,
  // every relay request fails at execution time and the buyer sees
  // 502s.
  //
  // Previously users had to run a two-terminal capture dance
  // manually. Now we do it inline: start a local proxy, invoke
  // `claude -p hi` (etc) against it, intercept the first
  // /v1/messages request, extract the fingerprint, forward the
  // request upstream so the CLI call still succeeds.
  //
  // Only claude is wired up for now; codex/gemini will follow the
  // same pattern.
  if (selectedClis.includes("claude") && !hasClaudeFingerprint()) {
    const bootSpin = spinner();
    bootSpin.start(
      "Capturing Claude fingerprint (runs `claude -p hi` once, ~5-15s)..."
    );
    try {
      const fp = await bootstrapClaudeFingerprint({ timeoutMs: 45_000 });
      bootSpin.stop(
        `${chalk.green("✓")} Claude fingerprint captured ` +
          chalk.dim(
            `(device=${fp.device_id.slice(0, 8)}… cc_version=${fp.cc_version || "?"})`
          )
      );
    } catch (err) {
      bootSpin.stop(
        chalk.yellow(
          `⚠ Claude fingerprint capture failed: ${(err as Error).message}`
        )
      );
      log.warn(
        "Claude providers will be registered but the daemon won't be able " +
          "to serve them until you run `clawmoney relay setup` again or bootstrap " +
          "manually. Make sure `claude` is installed and logged in first."
      );
    }
  }

  // ── Step 3: auto-register recommended models per family ──
  //
  // We deliberately don't ask the user to pick individual models here.
  // Providers care about lending their subscription's quota to earn,
  // not about which model IDs are registered — from their POV it's
  // all just "Claude Max tokens" or "ChatGPT Pro tokens". Registering
  // the curated recommended set per CLI covers the models that each
  // CLI's own /model picker actually exposes, so buyer traffic lines
  // up naturally with what the provider's subscription can serve.
  //
  // Advanced users who want a narrower set can edit
  // ~/.clawmoney/config.yaml or call `clawmoney relay register`
  // manually after setup — we don't expose a selector here because
  // it was pure friction for the common case.
  type Registration = { cli: string; model: string; input: number; output: number };
  const registrations: Registration[] = [];

  for (const cli of selectedClis) {
    const allModels = modelsForCli(cli);
    const recommended = (RECOMMENDED_MODELS[cli] ?? []).filter((m) =>
      allModels.includes(m)
    );

    if (allModels.length === 0 || recommended.length === 0) {
      log.warn(`${cli}: no recommended models found — skipping`);
      continue;
    }

    log.success(
      `${chalk.bold(cli)}: ${recommended.length} models ${chalk.dim("— " + recommended.join(", "))}`
    );

    for (const model of recommended) {
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

  // ── Step 5: register everything under one spinner ──
  //
  // We deliberately skip the old per-model Summary block: pricing is on
  // the website, and Step 3 already listed which models were queued per
  // subscription. The remaining signal (quota share + earn %) goes into
  // the spinner's final message so users see it exactly once.
  //
  // Also: one spinner for the whole batch, not N. Sequential per-model
  // spinners produced 7+ rows of clack vertical whitespace for what's
  // really a single bulk action.
  //
  // No "Register all N providers now?" confirm either — the user picked
  // subscriptions + quota share above; Ctrl-C still aborts, and the
  // backend is idempotent so mid-way aborts are safe to re-run.
  const limitLabel: Record<number, string> = {
    15: "~25%", 30: "~50%", 45: "~75%", 60: "~100%",
  };
  const earnPct = Math.round((1 - PLATFORM_FEE) * 100);

  // Single batch POST — one round-trip, one DB session, no
  // client-side fan-out. The earlier sequential loop paid 7× the
  // TLS/bcrypt/CF overhead, and parallelizing with Promise.all
  // tripped over client- or proxy-level concurrency limits on some
  // machines. Batch endpoint is the right architecture.
  let succeeded = 0;
  let failed = 0;
  const failures: Array<{ cli: string; model: string; error: string }> = [];

  const regSpin = spinner();
  regSpin.start(`Registering ${registrations.length} providers...`);

  const batchBody = {
    providers: registrations.map((r) => ({
      cli_type: r.cli,
      model: r.model,
      mode: "chat",
      concurrency,
      daily_limit_usd: dailyLimit,
      price_input_per_m: r.input,
      price_output_per_m: r.output,
    })),
  };

  try {
    const resp = await apiPost<{
      created: Array<Record<string, unknown>>;
      skipped: Array<{ cli_type: string; model: string; reason: string }>;
      failed: Array<{ cli_type: string; model: string; error: string }>;
    }>("/api/v1/relay/providers/batch", batchBody, config.api_key);

    if (!resp.ok) {
      const raw =
        resp.data && typeof resp.data === "object" && "detail" in resp.data
          ? (resp.data as Record<string, unknown>).detail
          : resp.data;
      const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
      regSpin.stop(chalk.red(`✗ Batch registration failed: ${detail}`));
      cancel("Setup aborted");
      process.exit(1);
    }

    // Per-row counts from the batch result.
    succeeded = (resp.data.created?.length ?? 0) + (resp.data.skipped?.length ?? 0);
    failed = resp.data.failed?.length ?? 0;
    for (const f of resp.data.failed ?? []) {
      failures.push({ cli: f.cli_type, model: f.model, error: f.error });
    }
  } catch (err) {
    regSpin.stop(
      chalk.red(`✗ Batch registration failed: ${(err as Error).message}`)
    );
    cancel("Setup aborted");
    process.exit(1);
  }

  if (failed === 0) {
    regSpin.stop(
      `${chalk.green(`✓ ${succeeded} providers registered`)}  ` +
        chalk.dim(
          `(${limitLabel[dailyLimit] ?? `$${dailyLimit}`} quota share · you earn ~${earnPct}%)`
        )
    );
  } else {
    regSpin.stop(
      `${chalk.yellow(`${succeeded} registered, ${failed} failed`)}`
    );
  }

  // ── Step 6: on failure, list which ones broke ──
  //
  // On success we say nothing — the spinner's final message is already
  // the "registered" summary. On failure we dump a per-row detail line
  // so the user can tell what to fix.
  if (failed > 0) {
    for (const f of failures) {
      log.warn(`${f.cli}/${f.model}: ${chalk.dim(f.error.slice(0, 120))}`);
    }
  }

  // ── Step 7: prune — implement "pick-what-you-run" semantics ──
  //
  // setup is declarative: the (cli_type, model) pairs the user just
  // picked are the complete set of what the daemon should serve.
  // Earlier test runs that registered different subscriptions
  // (antigravity, gemini, etc.) OR stale model versions
  // (claude-sonnet-4-5 before the recommended list moved to 4-6)
  // would otherwise linger in the DB and get preflighted every
  // daemon start.
  //
  // We only prune AFTER registration succeeds, so a failed batch
  // doesn't wipe the user's existing state. We pass the EXACT
  // (cli_type, model) pairs from `registrations` so prune is
  // grain-safe and cleans stale per-model rows too.
  try {
    const pruneResp = await apiPost<{
      deleted: Array<{ id: string; cli_type: string; model: string }>;
      kept: number;
    }>(
      "/api/v1/relay/providers/prune",
      {
        keep: registrations.map((r) => ({
          cli_type: r.cli,
          model: r.model,
        })),
      },
      config.api_key
    );
    if (
      pruneResp.ok &&
      pruneResp.data?.deleted &&
      pruneResp.data.deleted.length > 0
    ) {
      log.success(
        `Cleaned up ${pruneResp.data.deleted.length} provider(s) from earlier runs ` +
          chalk.dim(
            "(" +
              Array.from(
                new Set(pruneResp.data.deleted.map((d) => d.cli_type))
              ).join(", ") +
              ")"
          )
      );
    }
  } catch (err) {
    // Non-fatal: worst case is the daemon preflights extra cli_types,
    // which is annoying but doesn't break anything.
    log.warn(
      `Could not prune old providers: ${(err as Error).message} — ` +
        `run \`clawmoney relay status\` and clean manually if needed`
    );
  }

  // ── Step 8: auto-start the daemon ──
  //
  // The daemon now runs in multi-cli auto mode by default: it fetches
  // every provider this agent has registered, preflights each distinct
  // cli_type, and dispatches requests to the right upstream based on
  // the `cli_type` field in each incoming relay_request. A single
  // daemon process can serve Claude + Codex + Gemini + Antigravity
  // simultaneously, so there's no need to pick one here.
  const uniqueClis = Array.from(new Set(selectedClis));
  const { relayStartCommand } = await import("./relay.js");

  try {
    await relayStartCommand({});
  } catch (err) {
    log.error(
      `Failed to start daemon: ${(err as Error).message}\n` +
        `Try manually: ${chalk.cyan("clawmoney relay start")}`
    );
    outro(chalk.yellow("Setup complete (daemon not started)"));
    return;
  }

  // One multi-line log.message renders each line with a `│` prefix
  // but without clack's inter-call gap — 3 bullets fit in 3 lines
  // instead of 6.
  log.message(
    chalk.dim("Next:") +
      "\n" +
      `  ${chalk.cyan("clawmoney relay status")}   daemon + provider list\n` +
      `  ${chalk.cyan("clawmoney relay logs")}     tail daemon log\n` +
      `  ${chalk.cyan("clawmoney wallet balance")} on-chain + relay earnings\n` +
      `  ${chalk.cyan("clawmoney relay stop")}     stop daemon`
  );
  const cliLabel =
    uniqueClis.length === 1
      ? `${uniqueClis[0]} daemon running`
      : `daemon serving ${uniqueClis.join(" + ")}`;
  outro(chalk.green(`Setup complete · ${cliLabel}`));
}
