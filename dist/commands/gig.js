import { existsSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../utils/config.js";
import { apiGet, apiPost } from "../utils/api.js";
import { uploadFile } from "../hub/media.js";
import { CdpProvider } from "../wallet/cdp-provider.js";
import { x402Fetch } from "../wallet/x402-client.js";
export async function gigCreateCommand(options) {
    const config = requireConfig();
    const budget = parseFloat(options.budget);
    if (isNaN(budget) || budget <= 0) {
        console.error(chalk.red("Invalid budget. Must be a positive number."));
        process.exit(1);
    }
    const spinner = ora("Creating gig...").start();
    try {
        const body = {
            title: options.title,
            description: options.description,
            category: options.category,
            budget,
        };
        if (options.requirements) {
            body.requirements = options.requirements;
        }
        const resp = await apiPost("/api/v1/market/escrow", body, config.api_key);
        if (!resp.ok) {
            const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                ? resp.data.detail
                : resp.data;
            const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
            spinner.fail(chalk.red(`Failed to create gig (${resp.status}): ${detail}`));
            process.exit(1);
        }
        const task = resp.data;
        spinner.succeed(chalk.green("Gig created!"));
        console.log("");
        console.log(`  ${chalk.bold("ID:")}          ${task.id}`);
        console.log(`  ${chalk.bold("Title:")}       ${task.title}`);
        console.log(`  ${chalk.bold("Category:")}    ${task.category}`);
        console.log(`  ${chalk.bold("Budget:")}      $${budget.toFixed(2)}`);
        console.log(`  ${chalk.bold("Status:")}      ${task.status}`);
        // Auto-fund: check wallet balance and pay
        spinner.start("Checking wallet balance...");
        try {
            const wallet = new CdpProvider(config.api_key);
            const bal = await wallet.getBalance("usdc");
            const atomic = BigInt(bal.amount);
            const divisor = 10n ** BigInt(bal.decimals || 6);
            const balance = Number(atomic / divisor) + Number(atomic % divisor) / Number(divisor);
            if (balance >= budget) {
                // Enough USDC — pay via x402
                spinner.text = `Funding $${budget.toFixed(2)} USDC via x402...`;
                try {
                    const res = await x402Fetch(wallet, `https://pay.clawmoney.ai/market/escrow/${task.id}?price=${budget}`, { method: "POST" });
                    if (!res.ok) {
                        throw new Error(`Payment endpoint returned ${res.status}`);
                    }
                    spinner.succeed(chalk.green(`Funded! $${budget.toFixed(2)} USDC`));
                    console.log(chalk.dim("  Task is now live and accepting submissions."));
                }
                catch (err) {
                    spinner.warn(chalk.yellow(`x402 payment failed: ${err.message}`));
                    console.log(chalk.dim(`  Fund manually: npx clawmoney gig fund ${task.id}`));
                }
            }
            else {
                // Not enough USDC — generate Stripe checkout link
                spinner.text = "Generating payment link...";
                const checkoutResp = await apiPost(`/api/v1/market/escrow/${task.id}/checkout?return_base=${encodeURIComponent("https://clawmoney.ai")}`, {}, config.api_key);
                if (checkoutResp.ok && checkoutResp.data) {
                    const checkoutUrl = checkoutResp.data.checkout_url;
                    if (checkoutUrl) {
                        spinner.info(chalk.yellow(`Wallet balance ($${balance.toFixed(2)}) insufficient.`));
                        console.log("");
                        console.log(`  ${chalk.bold("Pay with card:")} ${chalk.cyan(checkoutUrl)}`);
                        console.log(chalk.dim("  Open this link in your browser to complete payment."));
                        console.log(chalk.dim("  Task will go live automatically after payment."));
                    }
                    else {
                        spinner.warn(chalk.yellow("Could not generate payment link."));
                        console.log(chalk.dim(`  Fund manually: npx clawmoney gig fund ${task.id}`));
                    }
                }
                else {
                    spinner.warn(chalk.yellow("Stripe checkout not available."));
                    console.log(chalk.dim(`  Fund via x402 in another client, or use Stripe checkout above.`));
                }
            }
        }
        catch {
            // Wallet check failed — just show manual fund instructions
            console.log("");
            console.log(chalk.dim(`  Fund: npx clawmoney gig fund ${task.id}`));
        }
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to create gig"));
        throw err;
    }
}
export async function gigBrowseCommand(options) {
    const spinner = ora("Browsing gigs...").start();
    try {
        const params = new URLSearchParams();
        if (options.category)
            params.set("category", options.category);
        if (options.status)
            params.set("status", options.status);
        if (options.limit)
            params.set("limit", options.limit);
        const resp = await apiGet(`/api/v1/market/escrow?${params}`);
        if (!resp.ok) {
            spinner.fail(chalk.red(`Failed to browse gigs (${resp.status})`));
            process.exit(1);
        }
        const tasks = resp.data.data ?? [];
        const count = resp.data.count ?? tasks.length;
        spinner.succeed(`Found ${count} gig(s)`);
        console.log("");
        if (tasks.length === 0) {
            console.log(chalk.dim("  No gigs available."));
            return;
        }
        console.log(chalk.bold(`  ${"Title".padEnd(25)} ${"Category".padEnd(18)} ${"Budget".padEnd(10)} ${"Status".padEnd(10)} ${"Creator".padEnd(15)}`));
        console.log(chalk.dim("  " + "-".repeat(80)));
        for (const t of tasks) {
            const title = (t.title ?? "-").slice(0, 24);
            const category = (t.category ?? "-").slice(0, 17);
            const budget = t.budget != null ? `$${t.budget.toFixed(2)}` : "-";
            const status = t.status ?? "-";
            const creator = (t.creator_agent_name ?? t.creator_agent_slug ?? "-").slice(0, 14);
            console.log(`  ${chalk.cyan(title.padEnd(25))} ${category.padEnd(18)} ${chalk.green(budget.padEnd(10))} ${status.padEnd(10)} ${creator.padEnd(15)}`);
        }
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to browse gigs"));
        throw err;
    }
}
// ── gig detail ──
export async function gigDetailCommand(taskId) {
    const spinner = ora("Fetching gig details...").start();
    try {
        const resp = await apiGet(`/api/v1/market/escrow/${taskId}`);
        if (!resp.ok) {
            const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                ? resp.data.detail
                : resp.data;
            const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
            spinner.fail(chalk.red(`Failed (${resp.status}): ${detail}`));
            process.exit(1);
        }
        const t = resp.data;
        spinner.succeed("Gig details");
        console.log("");
        console.log(`  ${chalk.bold("ID:")}            ${t.id}`);
        console.log(`  ${chalk.bold("Title:")}         ${t.title}`);
        console.log(`  ${chalk.bold("Description:")}   ${t.description}`);
        console.log(`  ${chalk.bold("Category:")}      ${t.category}`);
        console.log(`  ${chalk.bold("Requirements:")}  ${t.requirements ?? "None"}`);
        console.log(`  ${chalk.bold("Budget:")}        $${t.budget?.toFixed(2) ?? "-"}`);
        console.log(`  ${chalk.bold("Status:")}        ${t.status}`);
        console.log(`  ${chalk.bold("Creator:")}       ${t.creator_agent_name ?? t.creator_agent_slug ?? "-"}`);
        if (t.assignee_agent_name || t.assignee_agent_slug) {
            console.log(`  ${chalk.bold("Assignee:")}      ${t.assignee_agent_name ?? t.assignee_agent_slug}`);
        }
        if (t.delivery_url) {
            console.log(`  ${chalk.bold("Delivery URL:")} ${t.delivery_url}`);
        }
        if (t.delivery_content) {
            console.log(`  ${chalk.bold("Delivery:")}      ${t.delivery_content.slice(0, 200)}`);
        }
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to fetch gig details"));
        throw err;
    }
}
// ── gig accept ──
export async function gigAcceptCommand(taskId) {
    const config = requireConfig();
    const spinner = ora("Accepting gig...").start();
    try {
        const resp = await apiPost(`/api/v1/market/escrow/${taskId}/accept`, {}, config.api_key);
        if (!resp.ok) {
            const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                ? resp.data.detail
                : resp.data;
            const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
            spinner.fail(chalk.red(`Failed (${resp.status}): ${detail}`));
            process.exit(1);
        }
        const t = resp.data;
        spinner.succeed(chalk.green(`Gig accepted! "${t.title}"`));
        console.log(chalk.dim(`  Budget: $${t.budget?.toFixed(2) ?? "-"}`));
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to accept gig"));
        throw err;
    }
}
export async function gigDeliverCommand(taskId, options) {
    const config = requireConfig();
    if (!options.content && !options.url) {
        console.error(chalk.red("Must provide --content or --url (or both)."));
        process.exit(1);
    }
    let deliveryUrl = options.url;
    // If url is a local file path, upload to R2 first
    if (deliveryUrl && deliveryUrl.startsWith("/") && existsSync(deliveryUrl)) {
        const uploadSpinner = ora(`Uploading ${deliveryUrl}...`).start();
        const providerConfig = {
            api_key: config.api_key,
            provider: {
                cli_command: "openclaw",
                max_concurrent: 3,
                auto_accept: false,
                ws_url: "",
                api_base_url: process.env.CLAWMONEY_API_BASE || "https://api.bnbot.ai/api/v1",
                polling: { connected_interval: 120, disconnected_interval: 15 },
                reconnect: { initial: 5, max: 300, multiplier: 2 },
            },
        };
        const cdnUrl = await uploadFile(deliveryUrl, providerConfig);
        if (cdnUrl) {
            uploadSpinner.succeed(chalk.green(`Uploaded → ${cdnUrl}`));
            deliveryUrl = cdnUrl;
        }
        else {
            uploadSpinner.fail(chalk.yellow("Upload failed, submitting local path as-is"));
        }
    }
    const spinner = ora("Submitting delivery...").start();
    try {
        const body = {};
        if (options.content)
            body.content = options.content;
        if (deliveryUrl)
            body.url = deliveryUrl;
        const resp = await apiPost(`/api/v1/market/escrow/${taskId}/deliver`, body, config.api_key);
        if (!resp.ok) {
            const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                ? resp.data.detail
                : resp.data;
            const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
            spinner.fail(chalk.red(`Failed (${resp.status}): ${detail}`));
            process.exit(1);
        }
        spinner.succeed(chalk.green("Delivery submitted!"));
        console.log(chalk.dim("  Waiting for creator to review and approve."));
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to submit delivery"));
        throw err;
    }
}
// ── gig approve ──
export async function gigApproveCommand(taskId) {
    const config = requireConfig();
    const spinner = ora("Approving delivery...").start();
    try {
        const resp = await apiPost(`/api/v1/market/escrow/${taskId}/approve`, {}, config.api_key);
        if (!resp.ok) {
            const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                ? resp.data.detail
                : resp.data;
            const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
            spinner.fail(chalk.red(`Failed (${resp.status}): ${detail}`));
            process.exit(1);
        }
        spinner.succeed(chalk.green("Delivery approved! Funds released to assignee."));
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to approve delivery"));
        throw err;
    }
}
// ── gig dispute ──
export async function gigDisputeCommand(taskId) {
    const config = requireConfig();
    const spinner = ora("Raising dispute...").start();
    try {
        const resp = await apiPost(`/api/v1/market/escrow/${taskId}/dispute`, {}, config.api_key);
        if (!resp.ok) {
            const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                ? resp.data.detail
                : resp.data;
            const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
            spinner.fail(chalk.red(`Failed (${resp.status}): ${detail}`));
            process.exit(1);
        }
        spinner.succeed(chalk.yellow("Dispute raised. Delivery is under review."));
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to raise dispute"));
        throw err;
    }
}
