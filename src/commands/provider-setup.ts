import {
  multiselect,
  isCancel,
  cancel,
  log,
  note,
} from "@clack/prompts";
import chalk from "chalk";

import { loadConfig } from "../utils/config.js";

// Provider roles enabled from this wizard. Each delegates to an existing
// per-role setup command — we don't re-implement those flows here, just
// dispatch in canonical order so the user sees a predictable sequence.
type ProviderRole = "market" | "relay" | "verifier";

interface RoleSpec {
  value: ProviderRole;
  label: string;
  hint: string;
}

const ROLES: RoleSpec[] = [
  {
    value: "market",
    label: "Market skills",
    hint: "image gen / code / translate / tts / ... — agents pay you per call",
  },
  {
    value: "relay",
    label: "Relay",
    hint: "sell idle Claude Max / ChatGPT Pro / Gemini quota at 20% of API price",
  },
  {
    value: "verifier",
    label: "Verifier",
    hint: "witness tweet promote tasks — $0.01 per verification, runs in background",
  },
];

/**
 * Provider setup wizard. Assumes the agent is already registered
 * (api_key in ~/.clawmoney/config.yaml). Callable on its own — used both
 * as the post-register step of `clawmoney setup` and as a re-entry point
 * for users who want to add roles after their first setup.
 */
export async function providerSetupWizard(): Promise<void> {
  if (!loadConfig()) {
    console.log(
      chalk.red(
        "\n  No agent config found. Run `clawmoney setup` first to register.\n",
      ),
    );
    process.exit(1);
  }

  log.message(
    chalk.bold("Provider roles") +
      chalk.dim(" — pick what you want to earn from. You can re-run this anytime."),
  );

  const picked = await multiselect({
    message: "Provider roles (space to toggle, enter to confirm):",
    options: ROLES.map((r) => ({
      value: r.value,
      label: r.label,
      hint: r.hint,
    })),
    required: false,  // user is allowed to skip — they may have just come to register
  });

  if (isCancel(picked)) {
    log.message(
      chalk.dim("Skipped. Re-run `clawmoney setup` later to enable provider roles."),
    );
    return;
  }

  const roles = picked as ProviderRole[];

  if (roles.length === 0) {
    note(
      [
        chalk.dim("No roles enabled. You can still:"),
        `  ${chalk.cyan("clawmoney browse")}          browse engage tasks`,
        `  ${chalk.cyan("clawmoney promote")}         work on promote tasks`,
        "",
        chalk.dim("Or re-run `clawmoney setup` later to enable provider roles."),
      ].join("\n"),
      "Done",
    );
    return;
  }

  // Sort picked roles in canonical ROLES order so the wizard always runs
  // the same sequence (market → relay → verifier) regardless of click order.
  const ordered = ROLES.filter((r) => roles.includes(r.value)).map((r) => r.value);

  for (let i = 0; i < ordered.length; i++) {
    const role = ordered[i];
    log.step(
      `${chalk.bold(`[${i + 1}/${ordered.length}]`)} ${role}`,
    );

    try {
      if (role === "market") {
        const { marketSetupCommand } = await import("./market-setup.js");
        await marketSetupCommand({ nested: true });
      } else if (role === "relay") {
        const { relaySetupCommand } = await import("./relay-setup.js");
        await relaySetupCommand();
      } else if (role === "verifier") {
        const { verifierSetupCommand } = await import("./verifier-setup.js");
        await verifierSetupCommand({ nested: true });
      }
    } catch (err) {
      log.error(
        `${role} setup failed: ${(err as Error).message}. ` +
          `You can retry with \`clawmoney ${role} setup\` later.`,
      );
      // Don't abort the rest — let the user finish other roles. They can
      // come back to the failed one separately.
    }
  }

  note(
    [
      chalk.green(`${ordered.length} role${ordered.length === 1 ? "" : "s"} configured.`),
      "",
      chalk.dim("Useful next commands:"),
      `  ${chalk.cyan("clawmoney market skills")}      list your registered skills`,
      `  ${chalk.cyan("clawmoney market start")}       start the market provider daemon`,
      `  ${chalk.cyan("clawmoney relay start")}        start the relay daemon`,
      `  ${chalk.cyan("tail -f ~/.clawmoney/*.log")}  watch all daemons`,
    ].join("\n"),
    "All done",
  );
}
