import { intro, outro, multiselect, text, confirm, spinner, isCancel, cancel, log, note, } from "@clack/prompts";
import chalk from "chalk";
import { apiPost } from "../utils/api.js";
import { loadConfig } from "../utils/config.js";
import { setupCommand } from "./setup.js";
const CATEGORIES = [
    { value: "generation/image", routing: "instant", timeoutS: 120, suggestedPrice: 0.02, priceRange: [0.01, 0.50], defaultName: "gen-image", placeholderDesc: "Generate a 1024x1024 image from a text prompt" },
    { value: "generation/video", routing: "instant", timeoutS: 300, suggestedPrice: 0.10, priceRange: [0.05, 1.00], defaultName: "gen-video", placeholderDesc: "Generate a short AI video clip from a text prompt" },
    { value: "generation/video_long", routing: "escrow", timeoutS: null, suggestedPrice: 5.00, priceRange: [1.00, 50.00], defaultName: "gen-video-long", placeholderDesc: "Generate long-form narrated video (escrow)" },
    { value: "generation/text", routing: "instant", timeoutS: 120, suggestedPrice: 0.01, priceRange: [0.005, 0.20], defaultName: "gen-text", placeholderDesc: "Generate text from a prompt" },
    { value: "generation/audio", routing: "instant", timeoutS: 180, suggestedPrice: 0.05, priceRange: [0.02, 0.50], defaultName: "gen-audio", placeholderDesc: "Generate music or sound effects from a prompt" },
    { value: "transformation/translate", routing: "instant", timeoutS: 60, suggestedPrice: 0.01, priceRange: [0.005, 0.10], defaultName: "translate", placeholderDesc: "Translate text between languages" },
    { value: "transformation/tts", routing: "instant", timeoutS: 120, suggestedPrice: 0.02, priceRange: [0.01, 0.20], defaultName: "tts", placeholderDesc: "Convert text to natural-sounding speech" },
    { value: "transformation/stt", routing: "instant", timeoutS: 120, suggestedPrice: 0.02, priceRange: [0.01, 0.20], defaultName: "stt", placeholderDesc: "Transcribe speech to text" },
    { value: "search/web", routing: "instant", timeoutS: 60, suggestedPrice: 0.01, priceRange: [0.005, 0.10], defaultName: "web-search", placeholderDesc: "Search the web and return relevant results" },
    { value: "analysis/data", routing: "instant", timeoutS: 180, suggestedPrice: 0.05, priceRange: [0.02, 0.50], defaultName: "data-analysis", placeholderDesc: "Analyze a dataset and return insights" },
    { value: "coding/generation", routing: "instant", timeoutS: 240, suggestedPrice: 0.05, priceRange: [0.02, 0.50], defaultName: "code-gen", placeholderDesc: "Generate code from a natural-language spec" },
    { value: "coding/review", routing: "instant", timeoutS: 180, suggestedPrice: 0.05, priceRange: [0.02, 0.50], defaultName: "code-review", placeholderDesc: "Review a diff or PR for bugs and style issues" },
    { value: "other", routing: "auto", timeoutS: null, suggestedPrice: 0.02, priceRange: [0.01, 1.00], defaultName: "", placeholderDesc: "Describe what this skill does" },
];
const PRICE_THRESHOLD_FOR_ESCROW = 1.0; // mirrors backend constant
function formatHint(row) {
    if (row.routing === "escrow")
        return "escrow  · manual approve";
    if (row.routing === "auto")
        return "auto    · by price";
    return `instant · ${String(row.timeoutS).padStart(3, " ")}s timeout`;
}
// What skill_type will the backend resolve this to? Used for the review
// screen — the user gets to see and confirm the routing decision before
// commit. Keep this in sync with app/core/market_skill_routing.py.
function resolveSkillType(category, price) {
    const row = CATEGORIES.find((c) => c.value === category);
    if (!row)
        return "instant";
    if (row.routing === "instant")
        return "instant";
    if (row.routing === "escrow")
        return "escrow";
    return price > PRICE_THRESHOLD_FOR_ESCROW ? "escrow" : "instant";
}
function routingExplanation(skillType) {
    if (skillType === "escrow") {
        return [
            "Callers fund the task up front, you accept, deliver,",
            "and they approve to release funds. Good for tasks that",
            "take minutes to hours.",
        ].join("\n");
    }
    return [
        "Callers invoke with x402 payment, you respond via WebSocket,",
        "they poll for the result. Good for tasks that finish in",
        "seconds to a few minutes.",
    ].join("\n");
}
// ── Validators ──
// Skill names live in URLs (market/<agent_slug>/<skill_name>) and config
// files, so we keep them URL-safe and short. Same regex as backend slugs.
function validateSkillName(value) {
    const v = value.trim();
    if (!v)
        return "Skill name is required";
    if (v.length > 100)
        return "Skill name must be 100 characters or fewer";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) {
        return "Use lowercase letters, digits, and hyphens only (e.g. gen-image)";
    }
    return undefined;
}
function validateDescription(value) {
    const v = value.trim();
    if (!v)
        return "Description is required";
    if (v.length > 1000)
        return "Description must be 1000 characters or fewer";
    return undefined;
}
function validatePrice(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return "Price is required";
    const n = Number(trimmed);
    if (!Number.isFinite(n))
        return "Price must be a number";
    if (n < 0)
        return "Price cannot be negative";
    if (n > 10_000)
        return "Price looks unreasonable (> $10,000)";
    return undefined;
}
export async function marketSetupCommand(opts = {}) {
    // Step 0: ensure the agent is logged in. Mirrors relaySetupCommand's
    // handoff to setupCommand so first-time users get a clean flow instead
    // of "No config found" mid-wizard. Skipped when nested under
    // `clawmoney setup` since that command already guarantees a config.
    let existing = loadConfig();
    if (!existing) {
        await setupCommand();
        existing = loadConfig();
        if (!existing) {
            console.log(chalk.red("\n  Login did not complete. Run `clawmoney setup` manually, then re-run `clawmoney market setup`.\n"));
            process.exit(1);
        }
        console.log("");
    }
    const config = existing;
    if (!opts.nested) {
        intro(chalk.cyan(" ClawMoney Market Setup "));
    }
    log.message("Register one or more skills on the Market so other agents can call (and pay) you.");
    // ── Step 1: multiselect categories. Grouped visually: Instant first,
    // then Escrow, then Auto. clack's multiselect has no native separators,
    // so we fake them with disabled-looking header rows whose value is a
    // sentinel — selecting one is a no-op (filtered out downstream). ──
    const INSTANT_HEADER = "__hdr_instant__";
    const ESCROW_HEADER = "__hdr_escrow__";
    const AUTO_HEADER = "__hdr_auto__";
    const HEADERS = new Set([INSTANT_HEADER, ESCROW_HEADER, AUTO_HEADER]);
    const instantRows = CATEGORIES.filter((c) => c.routing === "instant");
    const escrowRows = CATEGORIES.filter((c) => c.routing === "escrow");
    const autoRows = CATEGORIES.filter((c) => c.routing === "auto");
    const groupedOptions = [
        { value: INSTANT_HEADER, label: chalk.dim("── Instant · poll for result ──"), hint: "" },
        ...instantRows.map((row) => ({ value: row.value, label: `  ${row.value}`, hint: formatHint(row) })),
        { value: ESCROW_HEADER, label: chalk.dim("── Escrow · manual approve ──"), hint: "" },
        ...escrowRows.map((row) => ({ value: row.value, label: `  ${row.value}`, hint: formatHint(row) })),
        { value: AUTO_HEADER, label: chalk.dim("── Auto · routed by price ──"), hint: "" },
        ...autoRows.map((row) => ({ value: row.value, label: `  ${row.value}`, hint: formatHint(row) })),
    ];
    const picked = await multiselect({
        message: "Pick the skill categories to register (space to toggle, enter to confirm):",
        options: groupedOptions,
        required: true,
    });
    if (isCancel(picked)) {
        cancel("Setup cancelled");
        process.exit(0);
    }
    // Strip header sentinels — they're visual-only group separators.
    const pickedCategories = picked.filter((v) => !HEADERS.has(v));
    if (pickedCategories.length === 0) {
        cancel("No categories selected");
        process.exit(0);
    }
    // Preserve the canonical CATEGORIES order rather than the click order —
    // makes the per-skill prompts and the review table read consistently.
    const orderedRows = CATEGORIES.filter((c) => pickedCategories.includes(c.value));
    // ── Step 2: for each category, collect name / description / price ──
    const drafts = [];
    for (let i = 0; i < orderedRows.length; i++) {
        const row = orderedRows[i];
        log.step(`${chalk.cyan(row.value)}  (${i + 1}/${orderedRows.length})  ${chalk.dim(formatHint(row))}`);
        const skillName = await text({
            message: "  Skill name:",
            placeholder: row.defaultName || "my-skill",
            initialValue: row.defaultName,
            validate: validateSkillName,
        });
        if (isCancel(skillName)) {
            cancel("Setup cancelled — nothing was registered");
            process.exit(0);
        }
        const description = await text({
            message: "  Description:",
            placeholder: row.placeholderDesc,
            validate: validateDescription,
        });
        if (isCancel(description)) {
            cancel("Setup cancelled — nothing was registered");
            process.exit(0);
        }
        const priceInput = await text({
            message: `  Price per call in USDC ${chalk.dim(`(suggested $${row.suggestedPrice.toFixed(2)}, range $${row.priceRange[0]}–$${row.priceRange[1]})`)}:`,
            placeholder: row.suggestedPrice.toFixed(2),
            initialValue: row.suggestedPrice.toFixed(2),
            validate: validatePrice,
        });
        if (isCancel(priceInput)) {
            cancel("Setup cancelled — nothing was registered");
            process.exit(0);
        }
        drafts.push({
            category: row.value,
            name: skillName.trim(),
            description: description.trim(),
            price: Number(priceInput.trim()),
        });
    }
    // ── Step 3: review the batch (show resolved skill_type for each so the
    // user knows which ones will go through escrow before they confirm) ──
    const reviewLines = drafts.map((d, idx) => {
        const skillType = resolveSkillType(d.category, d.price);
        return `  ${String(idx + 1).padStart(2, " ")}. ${chalk.cyan(d.name.padEnd(18))} ${d.category.padEnd(26)} ${chalk.green(`$${d.price.toFixed(2)}`.padStart(6, " "))}  ${skillType === "escrow" ? chalk.yellow("escrow") : chalk.dim("instant")}`;
    });
    // Tell the user only if escrow skills are in the batch — otherwise the
    // extra explanation is noise.
    const hasEscrow = drafts.some((d) => resolveSkillType(d.category, d.price) === "escrow");
    note([
        ...reviewLines,
        ...(hasEscrow
            ? [
                "",
                chalk.dim(`Escrow skills require manual approve from the caller — funds`),
                chalk.dim(`stay locked until you deliver and they release. Good for tasks`),
                chalk.dim(`that take minutes to hours (e.g. long video).`),
            ]
            : []),
    ].join("\n"), `Review · ${drafts.length} ${drafts.length === 1 ? "skill" : "skills"} to register`);
    const proceed = await confirm({
        message: `Confirm and register ${drafts.length === 1 ? "this skill" : `all ${drafts.length} skills`}?`,
        initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
        cancel("Setup cancelled — nothing was registered");
        process.exit(0);
    }
    // ── Step 4: sequential register. One failure does not abort the rest;
    // we show a per-skill summary at the end so the user can re-run for the
    // failures. Atomicity would need a backend batch endpoint we don't have. ──
    const results = [];
    for (const draft of drafts) {
        const s = spinner();
        s.start(`Registering ${chalk.cyan(draft.name)}...`);
        // Backend's AgentSkillCreate has extra='forbid', so we send ONLY the
        // four allowed fields. skill_type is intentionally not sent — the
        // server derives it from category and the routing rule previewed above.
        const resp = await apiPost("/api/v1/market/skills", {
            skill_name: draft.name,
            category: draft.category,
            description: draft.description,
            price: draft.price,
        }, config.api_key);
        if (resp.ok) {
            s.stop(`${chalk.green("✓")} ${draft.name}`);
            results.push({ draft, ok: true });
        }
        else {
            const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                ? resp.data.detail
                : resp.data;
            const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
            s.stop(`${chalk.red("✗")} ${draft.name} ${chalk.dim(`(${detail})`)}`);
            results.push({ draft, ok: false, detail });
        }
    }
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    const summary = [
        failCount === 0
            ? chalk.green(`All ${okCount} skills registered.`)
            : okCount === 0
                ? chalk.red(`None registered (${failCount} failed).`)
                : chalk.yellow(`${okCount} registered, ${failCount} failed.`),
        "",
        chalk.dim(`Next: run ${chalk.cyan("clawmoney market start")} to accept incoming calls in the background.`),
        chalk.dim(`      See your skills listed: ${chalk.cyan("clawmoney market skills")}`),
    ].join("\n");
    if (opts.nested) {
        // Don't close the parent wizard's intro frame — emit the summary as a
        // log message and let the parent wrap up the whole flow at the end.
        log.message(summary);
    }
    else {
        outro(summary);
    }
    if (failCount > 0 && !opts.nested) {
        process.exit(1);
    }
}
