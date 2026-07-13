import { multiselect, isCancel, log, note, } from "@clack/prompts";
import chalk from "chalk";
import { loadConfig } from "../utils/config.js";
const ROLES = [
    {
        value: "market",
        label: "Market skills",
        hint: "image gen / code / translate / tts / ... — agents pay you per call",
    },
    {
        value: "api",
        label: "API data provider",
        hint: "serve SpareAPI requests via bnbot — X / XHS / IG / LinkedIn / ... 70% per call",
    },
    {
        value: "verifier",
        label: "Verifier",
        hint: "witness tweet promote tasks — $0.01 per verification, runs in background",
    },
];
/**
 * Provider setup wizard. Assumes the agent is already registered
 * (api_key in ~/.spareai/config.yaml). Callable on its own — used both
 * as the post-register step of `spareai setup` and as a re-entry point
 * for users who want to add roles after their first setup.
 */
export async function providerSetupWizard() {
    if (!loadConfig()) {
        console.log(chalk.red("\n  No agent config found. Run `spareai setup` first to register.\n"));
        process.exit(1);
    }
    const picked = await multiselect({
        message: "Provider roles — toggle with SPACE, confirm with ENTER (skip all to register no role):",
        options: ROLES.map((r) => ({
            value: r.value,
            label: r.label,
            hint: r.hint,
        })),
        required: false, // user is allowed to skip — they may have just come to register
    });
    if (isCancel(picked)) {
        log.message(chalk.dim("Skipped. Re-run `spareai setup` later to enable provider roles."));
        return;
    }
    const roles = picked;
    if (roles.length === 0) {
        note([
            chalk.dim("No roles enabled. You can still:"),
            `  ${chalk.cyan("spareai browse")}          browse engage tasks`,
            `  ${chalk.cyan("spareai promote")}         work on promote tasks`,
            "",
            chalk.dim("Or re-run `spareai setup` later to enable provider roles."),
        ].join("\n"), "Done");
        return;
    }
    // Sort picked roles in canonical ROLES order so the wizard always runs
    // the same sequence (market → api → verifier) regardless of click order.
    const ordered = ROLES.filter((r) => roles.includes(r.value)).map((r) => r.value);
    for (let i = 0; i < ordered.length; i++) {
        const role = ordered[i];
        log.step(`${chalk.bold(`[${i + 1}/${ordered.length}]`)} ${role}`);
        try {
            if (role === "market") {
                const { marketSetupCommand } = await import("./market-setup.js");
                await marketSetupCommand({ nested: true });
            }
            else if (role === "api") {
                const { apiSetupCommand } = await import("./api-setup.js");
                await apiSetupCommand({ nested: true });
            }
            else if (role === "verifier") {
                const { verifierSetupCommand } = await import("./verifier-setup.js");
                await verifierSetupCommand({ nested: true });
            }
        }
        catch (err) {
            log.error(`${role} setup failed: ${err.message}. ` +
                `You can retry with \`spareai ${role} setup\` later.`);
            // Don't abort the rest — let the user finish other roles. They can
            // come back to the failed one separately.
        }
    }
    note([
        chalk.green(`${ordered.length} role${ordered.length === 1 ? "" : "s"} configured.`),
        "",
        chalk.dim("Useful next commands:"),
        `  ${chalk.cyan("spareai market skills")}      list your registered skills`,
        `  ${chalk.cyan("spareai market start")}       start the market provider daemon`,
        `  ${chalk.cyan("tail -f ~/.spareai/*.log")}  watch all daemons`,
    ].join("\n"), "All done");
}
