import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import ora from "ora";
import { requireConfig } from "../utils/config.js";
import { apiGet, apiPost } from "../utils/api.js";
import { awalExec } from "../utils/awal.js";
import { readPid, isPidAlive, removePid } from "../hub/provider.js";
const LOG_FILE = join(homedir(), ".clawmoney", "provider.log");
// ── hub start ──
export async function hubStartCommand(options) {
    const config = requireConfig();
    // Check if already running
    const existingPid = readPid();
    if (existingPid && isPidAlive(existingPid)) {
        console.log(chalk.yellow(`Market Provider is already running (PID ${existingPid}). Use "clawmoney market stop" first.`));
        return;
    }
    const spinner = ora("Starting Market Provider...").start();
    try {
        // Resolve daemon script path relative to this file's directory
        // Works for both compiled (dist/commands/hub.js) and dev (src/commands/hub.ts)
        const thisDir = import.meta.url.replace("file://", "").replace(/\/[^/]+$/, "");
        const parentDir = thisDir.replace(/\/[^/]+$/, "");
        const daemonScript = join(parentDir, "hub", "daemon.js");
        const args = [daemonScript];
        if (options.cli) {
            args.push("--cli", options.cli);
        }
        if (options.autoAccept) {
            args.push("--auto-accept");
        }
        const child = spawn(process.execPath, args, {
            stdio: "ignore",
            detached: true,
            env: {
                ...process.env,
                CLAWMONEY_DAEMON: "1",
            },
        });
        child.unref();
        // Give the daemon a moment to start and write PID
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const pid = readPid();
        if (pid && isPidAlive(pid)) {
            spinner.succeed(chalk.green(`Market Provider started (PID ${pid})`));
            console.log(chalk.dim(`  Log file: ${LOG_FILE}`));
            console.log(chalk.dim(`  CLI: ${options.cli || config.provider?.cli_command || "openclaw"}`));
            console.log(chalk.dim(`  Auto-accept: ${options.autoAccept || config.provider?.auto_accept ? "on" : "off"}`));
            console.log(chalk.dim(`  API key: ${config.api_key.slice(0, 8)}...`));
        }
        else {
            spinner.fail(chalk.red("Failed to start Market Provider. Check logs at: " + LOG_FILE));
            process.exit(1);
        }
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to start Market Provider"));
        throw err;
    }
}
// ── hub stop ──
export async function hubStopCommand() {
    const pid = readPid();
    if (!pid) {
        console.log(chalk.dim("Market Provider is not running (no PID file)."));
        return;
    }
    if (!isPidAlive(pid)) {
        console.log(chalk.dim(`Market Provider PID ${pid} is not alive. Cleaning up PID file.`));
        removePid();
        return;
    }
    try {
        process.kill(pid, "SIGTERM");
        console.log(chalk.green(`Market Provider stopped (PID ${pid}).`));
    }
    catch (err) {
        console.error(chalk.red(`Failed to stop process ${pid}:`), err.message);
    }
    // Wait briefly for cleanup, then ensure PID file is removed
    await new Promise((resolve) => setTimeout(resolve, 500));
    removePid();
}
// ── hub status ──
export async function hubStatusCommand() {
    const pid = readPid();
    if (!pid) {
        console.log(chalk.dim("Market Provider is not running."));
        return;
    }
    if (isPidAlive(pid)) {
        console.log(chalk.green(`Market Provider is running (PID ${pid}).`));
        console.log(chalk.dim(`  Log file: ${LOG_FILE}`));
    }
    else {
        console.log(chalk.yellow(`Market Provider PID ${pid} is not alive (stale PID file).`));
        removePid();
    }
}
export async function hubSearchCommand(options) {
    const spinner = ora("Searching Market...").start();
    try {
        const params = new URLSearchParams();
        if (options.query)
            params.set("q", options.query);
        if (options.category)
            params.set("category", options.category);
        if (options.sort)
            params.set("sort", options.sort);
        if (options.limit)
            params.set("limit", options.limit);
        if (options.maxPrice)
            params.set("max_price", options.maxPrice);
        params.set("online_only", "true");
        const resp = await apiGet(`/api/v1/hub/skills/search?${params}`);
        if (!resp.ok) {
            spinner.fail(chalk.red(`Search failed (${resp.status})`));
            process.exit(1);
        }
        const skills = resp.data.data ?? [];
        const count = resp.data.count ?? skills.length;
        spinner.succeed(`Found ${count} service(s)`);
        console.log("");
        if (skills.length === 0) {
            console.log(chalk.dim("  No services found. Try broader search terms."));
            return;
        }
        console.log(chalk.bold(`  ${"Agent".padEnd(18)} ${"Skill".padEnd(18)} ${"Category".padEnd(18)} ${"Price".padEnd(8)} ${"Rating".padEnd(8)} ${"Calls".padEnd(7)}`));
        console.log(chalk.dim("  " + "-".repeat(79)));
        for (const s of skills) {
            const agent = (s.agent_name ?? s.agent_slug ?? "-").slice(0, 17);
            const name = (s.skill_name ?? "-").slice(0, 17);
            const category = (s.category ?? "-").slice(0, 17);
            const price = s.price !== undefined ? `$${s.price.toFixed(3)}` : "-";
            const rating = s.avg_rating != null ? s.avg_rating.toFixed(1) : "-";
            const calls = String(s.total_calls ?? 0);
            const online = s.agent_is_online ? chalk.green("●") : chalk.dim("○");
            console.log(`  ${online} ${chalk.cyan(agent.padEnd(17))} ${name.padEnd(18)} ${category.padEnd(18)} ${chalk.green(price.padEnd(8))} ${rating.padEnd(8)} ${calls.padEnd(7)}`);
        }
    }
    catch (err) {
        spinner.fail(chalk.red("Search failed"));
        throw err;
    }
}
// ── poll order result ──
function getPollInterval(elapsedMs) {
    if (elapsedMs < 30_000)
        return 5_000; // first 30s: every 5s
    if (elapsedMs < 120_000)
        return 10_000; // 30s-2min: every 10s
    return 30_000; // 2min+: every 30s
}
async function pollOrderResult(orderId, apiKey, timeoutS, spinner) {
    const startTime = Date.now();
    const deadline = startTime + timeoutS * 1000;
    while (Date.now() < deadline) {
        const resp = await apiGet(`/api/v1/hub/orders/${orderId}`, apiKey);
        if (!resp.ok) {
            throw new Error(`Failed to poll order: ${resp.status}`);
        }
        const order = resp.data;
        const status = order.status;
        if (status === "completed") {
            return order;
        }
        if (status === "failed" || status === "timeout") {
            throw new Error(order.error_message || `Order ${status}`);
        }
        const remaining = Math.round((deadline - Date.now()) / 1000);
        spinner.text = `Waiting for result... (${remaining}s left)`;
        const interval = getPollInterval(Date.now() - startTime);
        await new Promise((r) => setTimeout(r, interval));
    }
    // Don't throw — task may still be running, tell user to check later
    return { id: orderId, status: "pending", _timeout: true };
}
export async function hubCallCommand(options) {
    const config = requireConfig();
    let inputData = {};
    if (options.input) {
        try {
            inputData = JSON.parse(options.input);
        }
        catch {
            console.error(chalk.red("Invalid JSON for --input. Example: '{\"prompt\":\"hello\"}'"));
            process.exit(1);
        }
    }
    const timeout = options.timeout ? parseInt(options.timeout, 10) : 60;
    const spinner = ora(`Calling ${options.agent}/${options.skill}...`).start();
    try {
        // Look up skill info (price + type)
        spinner.text = `Looking up ${options.agent}/${options.skill}...`;
        const searchResp = await apiGet(`/api/v1/hub/skills/search?q=${encodeURIComponent(options.skill)}&agent_slug=${encodeURIComponent(options.agent)}&limit=1`);
        const skills = searchResp.data?.data ?? [];
        const skillInfo = skills[0];
        const skillType = skillInfo?.skill_type || "instant";
        // Escrow-type skill → auto-create gig instead of invoke
        if (skillType === "escrow") {
            spinner.text = `Creating escrow task for ${options.agent}/${options.skill}...`;
            const budget = skillInfo?.price ?? 0.01;
            const gigResp = await apiPost("/api/v1/hub/escrow", {
                title: `${options.skill} — ${options.agent}`,
                description: JSON.stringify(inputData),
                category: skillInfo?.category || options.skill,
                budget,
            }, config.api_key);
            if (!gigResp.ok) {
                const detail = gigResp.data?.detail ?? gigResp.data;
                spinner.fail(chalk.red(`Failed to create task: ${JSON.stringify(detail)}`));
                process.exit(1);
            }
            const task = gigResp.data;
            const taskId = task.id;
            // Auto-fund if --pay
            if (options.pay) {
                spinner.text = `Funding task $${budget} USDC via x402...`;
                try {
                    await awalExec(["x402", "pay", `https://pay.clawmoney.ai/hub/escrow/${taskId}?price=${budget}`]);
                }
                catch (err) {
                    spinner.fail(chalk.red(`Funding failed: ${err.message}`));
                    process.exit(1);
                }
            }
            spinner.succeed(chalk.green("Escrow task created" + (options.pay ? " & funded!" : "!")));
            console.log("");
            console.log(`  ${chalk.bold("Task:")}     ${taskId}`);
            console.log(`  ${chalk.bold("Budget:")}   $${budget} USDC`);
            console.log(`  ${chalk.bold("Funded:")}   ${options.pay ? "Yes" : "No — pay to fund: npx clawmoney gig fund " + taskId}`);
            console.log(`  ${chalk.bold("Status:")}   ${task.status}`);
            console.log(chalk.dim(`  Check later: npx clawmoney gig detail ${taskId}`));
            return;
        }
        // Instant-type skill → invoke flow
        if (options.pay) {
            // x402 payment flow via pay.clawmoney.ai Worker
            const skillPrice = skillInfo?.price ?? 0.01;
            // Step 2: Pay via awal x402 → pay.clawmoney.ai Worker
            spinner.text = `Paying $${skillPrice} USDC for ${options.agent}/${options.skill}...`;
            const payUrl = `https://pay.clawmoney.ai/hub/${encodeURIComponent(options.agent)}/${encodeURIComponent(options.skill)}?price=${skillPrice}`;
            let payResult;
            try {
                payResult = await awalExec(["x402", "pay", payUrl]);
            }
            catch (err) {
                spinner.fail(chalk.red(`Payment failed: ${err.message}`));
                process.exit(1);
            }
            // Extract payment_token from Worker response
            // awal returns {status, statusText, data: {payment_token, ...}, headers}
            const payData = payResult.data;
            const innerData = payData.data ?? payData;
            const paymentToken = innerData.payment_token ?? payData.payment_token;
            if (!paymentToken) {
                spinner.fail(chalk.red("Payment succeeded but no payment_token returned"));
                console.error(chalk.dim(`  Raw response: ${JSON.stringify(payResult.data).slice(0, 200)}`));
                process.exit(1);
            }
            // Step 3: Invoke with payment_token
            spinner.text = `Executing ${options.agent}/${options.skill}...`;
            const qs = new URLSearchParams({
                agent_id: options.agent,
                skill: options.skill,
                timeout: String(timeout),
                payment_method: "x402",
                payment_token: paymentToken,
            });
            const resp = await apiPost(`/api/v1/hub/gateway/invoke?${qs}`, inputData, config.api_key);
            if (!resp.ok) {
                const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                    ? resp.data.detail
                    : resp.data;
                const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
                spinner.fail(chalk.red(`Call failed (${resp.status}): ${detail}`));
                process.exit(1);
            }
            const invokeResult = resp.data;
            const orderId = invokeResult.id;
            spinner.text = `Order ${orderId?.slice(0, 8)}... submitted, waiting for result...`;
            // Poll for completion
            const result = await pollOrderResult(orderId, config.api_key, timeout, spinner);
            if (result._timeout) {
                spinner.warn(chalk.yellow("Still processing..."));
                console.log(`  ${chalk.bold("Order:")} ${orderId}`);
                console.log(chalk.dim(`  Check later: npx clawmoney market order ${orderId}`));
            }
            else {
                spinner.succeed(chalk.green("Call completed (x402 paid)!"));
                console.log("");
                console.log(`  ${chalk.bold("Order:")}    ${result.id ?? "-"}`);
                console.log(`  ${chalk.bold("Duration:")} ${typeof result.duration === "number" ? result.duration.toFixed(1) + "s" : "-"}`);
                console.log(`  ${chalk.bold("Cost:")}     $${skillPrice} USDC`);
                console.log("");
                console.log(chalk.bold("  Output:"));
                console.log(chalk.cyan("  " + JSON.stringify(result.output_data ?? result.output ?? {}, null, 2).replace(/\n/g, "\n  ")));
            }
        }
        else {
            // Ledger payment (no real USDC transfer)
            const qs = new URLSearchParams({
                agent_id: options.agent,
                skill: options.skill,
                timeout: String(timeout),
                payment_method: "ledger",
            });
            const resp = await apiPost(`/api/v1/hub/gateway/invoke?${qs}`, inputData, config.api_key);
            if (!resp.ok) {
                const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                    ? resp.data.detail
                    : resp.data;
                const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
                spinner.fail(chalk.red(`Call failed (${resp.status}): ${detail}`));
                process.exit(1);
            }
            const invokeResult = resp.data;
            const orderId = invokeResult.id;
            spinner.text = `Order ${orderId?.slice(0, 8)}... submitted, waiting for result...`;
            // Poll for completion
            const result = await pollOrderResult(orderId, config.api_key, timeout, spinner);
            if (result._timeout) {
                spinner.warn(chalk.yellow("Still processing..."));
                console.log(`  ${chalk.bold("Order:")} ${orderId}`);
                console.log(chalk.dim(`  Check later: npx clawmoney market order ${orderId}`));
            }
            else {
                spinner.succeed(chalk.green("Call completed!"));
                console.log("");
                console.log(`  ${chalk.bold("Order:")}    ${result.id ?? "-"}`);
                console.log(`  ${chalk.bold("Duration:")} ${typeof result.duration === "number" ? result.duration.toFixed(1) + "s" : "-"}`);
                console.log(`  ${chalk.bold("Cost:")}     $${typeof result.price === "number" ? result.price.toFixed(3) : "-"}`);
                console.log("");
                console.log(chalk.bold("  Output:"));
                console.log(chalk.cyan("  " + JSON.stringify(result.output_data ?? result.output ?? {}, null, 2).replace(/\n/g, "\n  ")));
            }
        }
    }
    catch (err) {
        spinner.fail(chalk.red("Call failed"));
        throw err;
    }
}
export async function hubRegisterCommand(options) {
    const config = requireConfig();
    const price = parseFloat(options.price);
    if (isNaN(price) || price < 0) {
        console.error(chalk.red("Invalid price. Must be a non-negative number."));
        process.exit(1);
    }
    const spinner = ora("Registering skill...").start();
    try {
        const resp = await apiPost("/api/v1/hub/skills", {
            skill_name: options.name,
            category: options.category,
            description: options.description,
            price: price,
        }, config.api_key);
        if (!resp.ok) {
            const raw = resp.data && typeof resp.data === "object" && "detail" in resp.data
                ? resp.data.detail
                : resp.data;
            const detail = typeof raw === "string" ? raw : JSON.stringify(raw);
            spinner.fail(chalk.red(`Failed to register skill (${resp.status}): ${detail}`));
            process.exit(1);
        }
        spinner.succeed(chalk.green("Skill registered successfully!"));
        console.log("");
        console.log(`  ${chalk.bold("Name:")}      ${options.name}`);
        console.log(`  ${chalk.bold("Category:")}  ${options.category}`);
        console.log(`  ${chalk.bold("Price:")}     $${price.toFixed(2)}/call`);
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to register skill"));
        throw err;
    }
}
export async function hubSkillsCommand() {
    const config = requireConfig();
    const spinner = ora("Fetching skills...").start();
    try {
        const resp = await apiGet("/api/v1/hub/skills/mine", config.api_key);
        if (!resp.ok) {
            spinner.fail(chalk.red(`Failed to fetch skills (${resp.status})`));
            process.exit(1);
        }
        const skills = Array.isArray(resp.data)
            ? resp.data
            : resp.data.data ?? [];
        spinner.succeed(`My Skills (${skills.length})`);
        console.log("");
        if (skills.length === 0) {
            console.log(chalk.dim('  No skills registered. Use "clawmoney market register" to add one.'));
            return;
        }
        // Table header
        console.log(chalk.bold(`  ${"Name".padEnd(20)} ${"Category".padEnd(20)} ${"Price".padEnd(10)} ${"Calls".padEnd(8)} ${"Status".padEnd(10)}`));
        console.log(chalk.dim("  " + "-".repeat(70)));
        for (const skill of skills) {
            const name = (skill.skill_name ?? skill.name ?? "-").slice(0, 19);
            const category = (skill.category ?? "-").slice(0, 19);
            const rawPrice = skill.price ?? skill.price_per_call;
            const price = rawPrice !== undefined ? `$${Number(rawPrice).toFixed(2)}` : "-";
            const calls = String(skill.total_calls ?? skill.call_count ?? "-");
            const status = skill.is_active !== undefined ? (skill.is_active ? "active" : "inactive") : (skill.status ?? "-");
            console.log(`  ${chalk.cyan(name.padEnd(20))} ${category.padEnd(20)} ${chalk.green(price.padEnd(10))} ${calls.padEnd(8)} ${status.padEnd(10)}`);
        }
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to fetch skills"));
        throw err;
    }
}
export async function hubHistoryCommand(options) {
    const config = requireConfig();
    const limit = options.limit ?? 10;
    const showType = options.type ?? "all";
    console.log(chalk.bold("\n  Market Activity History\n"));
    // Escrow tasks I submitted to (assigned)
    if (showType === "all" || showType === "escrow") {
        try {
            const resp = await apiGet(`/api/v1/hub/escrow/assigned?limit=${limit}`, config.api_key);
            if (resp.ok && resp.data.data?.length > 0) {
                console.log(chalk.bold(`  Escrow Tasks (${resp.data.count} total)`));
                console.log(chalk.dim("  ─────────────────────────────────────────────"));
                for (const task of resp.data.data) {
                    const statusColor = task.status === "settled" ? chalk.green :
                        task.status === "open" ? chalk.yellow :
                            task.status === "cancelled" ? chalk.gray :
                                chalk.white;
                    const age = timeAgo(task.created_at);
                    console.log(`  ${statusColor(task.status.toUpperCase().padEnd(9))} ` +
                        `${chalk.bold(task.title.slice(0, 40).padEnd(40))} ` +
                        `${chalk.cyan("$" + task.budget.toFixed(2).padStart(6))} ` +
                        `${chalk.dim(age)}`);
                    if (task.mode === "multi") {
                        console.log(`  ${"".padEnd(9)} ` +
                            `${chalk.dim(`${task.submission_count} submissions · by ${task.creator_agent_name ?? "?"}`)}`);
                    }
                }
                console.log("");
            }
            else {
                console.log(chalk.dim("  No escrow tasks found.\n"));
            }
        }
        catch {
            console.log(chalk.dim("  Could not fetch escrow tasks.\n"));
        }
    }
    // Service call orders (as provider)
    if (showType === "all" || showType === "orders") {
        try {
            const resp = await apiGet(`/api/v1/hub/orders/mine?role=provider&limit=${limit}`, config.api_key);
            if (resp.ok && resp.data.data?.length > 0) {
                console.log(chalk.bold(`  Service Orders (${resp.data.count} total)`));
                console.log(chalk.dim("  ─────────────────────────────────────────────"));
                for (const order of resp.data.data) {
                    const statusColor = order.status === "completed" ? chalk.green :
                        order.status === "pending" ? chalk.yellow :
                            order.status === "failed" ? chalk.red :
                                chalk.gray;
                    const age = timeAgo(order.created_at);
                    const dur = order.duration ? `${order.duration.toFixed(1)}s` : "--";
                    console.log(`  ${statusColor(order.status.toUpperCase().padEnd(9))} ` +
                        `${chalk.dim("from")} ${chalk.bold((order.caller_agent_name ?? "?").slice(0, 15).padEnd(15))} ` +
                        `${chalk.cyan("$" + order.price.toFixed(3).padStart(7))} ` +
                        `${chalk.dim(dur.padStart(6))} ` +
                        `${chalk.dim(age)}`);
                }
                console.log("");
            }
            else {
                console.log(chalk.dim("  No service orders found.\n"));
            }
        }
        catch {
            console.log(chalk.dim("  Could not fetch orders.\n"));
        }
    }
    // Recent provider log
    if (showType === "all" || showType === "log") {
        try {
            const { readFileSync } = await import("node:fs");
            const lines = readFileSync(LOG_FILE, "utf-8").trim().split("\n");
            const recent = lines.slice(-8);
            console.log(chalk.bold("  Recent Provider Log"));
            console.log(chalk.dim("  ─────────────────────────────────────────────"));
            for (const line of recent) {
                const isError = line.includes("[ERROR]");
                const isInfo = line.includes("[INFO]");
                console.log(`  ${isError ? chalk.red(line) : isInfo ? chalk.dim(line) : chalk.yellow(line)}`);
            }
            console.log("");
        }
        catch {
            console.log(chalk.dim("  No provider log found.\n"));
        }
    }
}
function timeAgo(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diff / 60000);
    if (min < 60)
        return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24)
        return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
}
// ── hub order ──
export async function hubOrderCommand(orderId) {
    const config = requireConfig();
    const spinner = ora("Fetching order...").start();
    try {
        const resp = await apiGet(`/api/v1/hub/orders/${orderId}`, config.api_key);
        if (!resp.ok) {
            spinner.fail(chalk.red(`Order not found (${resp.status})`));
            process.exit(1);
        }
        const order = resp.data;
        const status = order.status;
        if (status === "completed") {
            spinner.succeed(chalk.green("Order completed"));
        }
        else if (status === "pending") {
            spinner.info(chalk.yellow("Order still processing..."));
        }
        else {
            spinner.fail(chalk.red(`Order ${status}`));
        }
        console.log("");
        console.log(`  ${chalk.bold("Order:")}    ${order.id ?? "-"}`);
        console.log(`  ${chalk.bold("Status:")}   ${status}`);
        console.log(`  ${chalk.bold("Duration:")} ${typeof order.duration === "number" ? order.duration.toFixed(1) + "s" : "-"}`);
        console.log(`  ${chalk.bold("Price:")}    $${typeof order.price === "number" ? order.price.toFixed(3) : "-"}`);
        if (order.error_message) {
            console.log(`  ${chalk.bold("Error:")}    ${chalk.red(order.error_message)}`);
        }
        if (status === "completed" && order.output_data) {
            console.log("");
            console.log(chalk.bold("  Output:"));
            console.log(chalk.cyan("  " + JSON.stringify(order.output_data, null, 2).replace(/\n/g, "\n  ")));
        }
    }
    catch (err) {
        spinner.fail(chalk.red("Failed to fetch order"));
        throw err;
    }
}
