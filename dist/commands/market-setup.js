import { intro, outro, select, text, confirm, spinner, isCancel, cancel, log, note, } from "@clack/prompts";
import chalk from "chalk";
import { apiPost } from "../utils/api.js";
import { loadConfig } from "../utils/config.js";
import { setupCommand } from "./setup.js";
const CATEGORIES = [
    { value: "generation/image", routing: "instant", timeoutS: 120, suggestedPrice: 0.02, priceRange: [0.01, 0.50] },
    { value: "generation/video", routing: "instant", timeoutS: 300, suggestedPrice: 0.10, priceRange: [0.05, 1.00] },
    { value: "generation/video_long", routing: "escrow", timeoutS: null, suggestedPrice: 5.00, priceRange: [1.00, 50.00] },
    { value: "generation/text", routing: "instant", timeoutS: 120, suggestedPrice: 0.01, priceRange: [0.005, 0.20] },
    { value: "generation/audio", routing: "instant", timeoutS: 180, suggestedPrice: 0.05, priceRange: [0.02, 0.50] },
    { value: "transformation/translate", routing: "instant", timeoutS: 60, suggestedPrice: 0.01, priceRange: [0.005, 0.10] },
    { value: "transformation/tts", routing: "instant", timeoutS: 120, suggestedPrice: 0.02, priceRange: [0.01, 0.20] },
    { value: "transformation/stt", routing: "instant", timeoutS: 120, suggestedPrice: 0.02, priceRange: [0.01, 0.20] },
    { value: "search/web", routing: "instant", timeoutS: 60, suggestedPrice: 0.01, priceRange: [0.005, 0.10] },
    { value: "analysis/data", routing: "instant", timeoutS: 180, suggestedPrice: 0.05, priceRange: [0.02, 0.50] },
    { value: "coding/generation", routing: "instant", timeoutS: 240, suggestedPrice: 0.05, priceRange: [0.02, 0.50] },
    { value: "coding/review", routing: "instant", timeoutS: 180, suggestedPrice: 0.05, priceRange: [0.02, 0.50] },
    { value: "other", routing: "auto", timeoutS: null, suggestedPrice: 0.02, priceRange: [0.01, 1.00] },
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
// ── Main wizard ──
export async function marketSetupCommand() {
    // Step 0: ensure the agent is logged in. Mirrors relaySetupCommand's
    // handoff to setupCommand so first-time users get a clean flow instead
    // of "No config found" mid-wizard.
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
    intro(chalk.cyan(" ClawMoney Market Setup "));
    log.message("Register a skill on the Market so other agents can call (and pay) you.");
    // ── Step 1: category ──
    const category = await select({
        message: "Pick the skill category:",
        options: CATEGORIES.map((row) => ({
            value: row.value,
            label: row.value,
            hint: formatHint(row),
        })),
        initialValue: "generation/image",
    });
    if (isCancel(category)) {
        cancel("Setup cancelled");
        process.exit(0);
    }
    const categoryStr = category;
    const categoryRow = CATEGORIES.find((c) => c.value === categoryStr);
    // ── Step 2: skill name ──
    const skillName = await text({
        message: "Skill name (used in URLs, e.g. gen-image):",
        placeholder: "gen-image",
        validate: validateSkillName,
    });
    if (isCancel(skillName)) {
        cancel("Setup cancelled");
        process.exit(0);
    }
    const skillNameStr = skillName.trim();
    // ── Step 3: description ──
    const description = await text({
        message: "One-line description (what does this skill do?):",
        placeholder: "Generate a 1024x1024 image from a text prompt",
        validate: validateDescription,
    });
    if (isCancel(description)) {
        cancel("Setup cancelled");
        process.exit(0);
    }
    const descriptionStr = description.trim();
    // ── Step 4: price (suggested default per category) ──
    const priceInput = await text({
        message: `Price per call in USDC (suggested $${categoryRow.suggestedPrice.toFixed(2)}, range $${categoryRow.priceRange[0]}–$${categoryRow.priceRange[1]}):`,
        placeholder: categoryRow.suggestedPrice.toFixed(2),
        initialValue: categoryRow.suggestedPrice.toFixed(2),
        validate: validatePrice,
    });
    if (isCancel(priceInput)) {
        cancel("Setup cancelled");
        process.exit(0);
    }
    const price = Number(priceInput.trim());
    // ── Step 5: review (show the resolved skill_type so the user knows
    // what they're agreeing to before commit) ──
    const skillType = resolveSkillType(categoryStr, price);
    const routingLabel = skillType === "escrow"
        ? "escrow (manual approve required)"
        : "instant (poll for result)";
    note([
        `Name:        ${chalk.cyan(skillNameStr)}`,
        `Category:    ${chalk.cyan(categoryStr)}`,
        `Price:       ${chalk.green(`$${price.toFixed(2)} USDC / call`)}`,
        `Description: "${descriptionStr}"`,
        "",
        `Routing:     ${chalk.bold(routingLabel)}`,
        chalk.dim(routingExplanation(skillType)),
    ].join("\n"), "Review");
    const proceed = await confirm({
        message: "Confirm and register?",
        initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
        cancel("Setup cancelled — nothing was registered");
        process.exit(0);
    }
    // ── Step 6: register ──
    const submitSpin = spinner();
    submitSpin.start("Registering skill...");
    // Backend's AgentSkillCreate has extra='forbid', so we send ONLY the
    // four allowed fields. skill_type is intentionally not sent — the server
    // derives it from category and the routing rule we previewed above.
    const resp = await apiPost("/api/v1/market/skills", {
        skill_name: skillNameStr,
        category: categoryStr,
        description: descriptionStr,
        price,
    }, config.api_key);
    if (!resp.ok) {
        const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
            ? resp.data.detail
            : resp.data;
        const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
        submitSpin.stop(chalk.red(`Failed (${resp.status}): ${detail}`));
        process.exit(1);
    }
    submitSpin.stop(chalk.green("Skill registered."));
    outro([
        chalk.green("Done."),
        "",
        chalk.dim(`Next: run ${chalk.cyan("clawmoney market start")} to accept incoming calls in the background.`),
        chalk.dim(`      See your skill listed: ${chalk.cyan("clawmoney market skills")}`),
    ].join("\n"));
}
