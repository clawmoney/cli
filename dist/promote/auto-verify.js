import { apiGet, apiPost } from "../utils/api.js";
import { awalExec } from "../utils/awal.js";
import { requireConfig } from "../utils/config.js";
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_PER_CYCLE = 3;
const MIN_BALANCE_USD = 0.05;
const WITNESS_COST_USD = 0.01;
function log(msg) {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    console.log(`[${ts}] ${msg}`);
}
async function getUsdcBalance() {
    try {
        const result = await awalExec(["balance"]);
        const base = result.data.base;
        const balances = base?.balances;
        const usdc = balances?.USDC;
        return parseFloat(String(usdc?.formatted || "0"));
    }
    catch {
        return 0;
    }
}
async function getActivePromoteTasks(apiKey) {
    const resp = await apiGet("/api/v1/promote?status=active&limit=20", apiKey);
    if (!resp.ok)
        return [];
    return resp.data.data ?? [];
}
async function getNextToVerify(taskId, apiKey) {
    const resp = await apiGet(`/api/v1/promote/${taskId}/next-to-verify`, apiKey);
    if (!resp.ok)
        return null;
    return resp.data;
}
async function scoreSubmission(task, submission) {
    // Simple heuristic scoring — if content exists and is non-trivial, approve
    const content = submission.content_text || "";
    const hasContent = content.length > 20;
    const hasProof = !!submission.proof_url;
    if (!hasProof) {
        return { vote: "reject", relevance: 2, quality: 1 };
    }
    if (!hasContent) {
        // Has proof but no content text — moderate approval
        return { vote: "approve", relevance: 5, quality: 5 };
    }
    // Check relevance to task description/requirements
    const taskWords = (task.description + " " + task.requirements).toLowerCase().split(/\s+/);
    const contentWords = content.toLowerCase().split(/\s+/);
    const overlap = contentWords.filter((w) => taskWords.includes(w) && w.length > 3).length;
    const relevance = Math.min(10, Math.max(3, Math.round(overlap * 1.5 + 4)));
    const quality = Math.min(10, Math.max(3, Math.round(content.length / 50 + 4)));
    return { vote: "approve", relevance, quality };
}
async function verifySubmission(task, submission, apiKey) {
    // 1. Get witness proof via x402
    const tweetMatch = submission.proof_url.match(/status\/(\d+)/);
    if (!tweetMatch) {
        log(`  Skip: cannot extract tweet ID from ${submission.proof_url}`);
        return false;
    }
    const tweetId = tweetMatch[1];
    let witnessData;
    try {
        witnessData = await awalExec([
            "x402",
            "pay",
            `https://witness.bnbot.ai/x/${tweetId}`,
        ]);
    }
    catch (err) {
        log(`  Witness failed: ${err.message}`);
        return false;
    }
    const wd = witnessData.data;
    const wdInner = wd?.data;
    const proof = (wdInner?.proof ?? wd?.proof ?? null);
    if (!proof) {
        log(`  No proof in witness response`);
        return false;
    }
    // 2. Score with heuristic
    const { vote, relevance, quality } = await scoreSubmission(task, submission);
    // 3. Submit verification
    const resp = await apiPost(`/api/v1/promote/submissions/${submission.submission_id}/verify`, {
        vote,
        relevance_score: relevance,
        quality_score: quality,
        tweet_proof: {
            payload: proof.payload,
            signature: proof.signature,
            signer: proof.signer,
            timestamp: proof.timestamp,
        },
    }, apiKey);
    if (!resp.ok) {
        const detail = typeof resp.data === "object" && resp.data
            ? resp.data.detail || JSON.stringify(resp.data)
            : String(resp.data);
        log(`  Verify failed: ${detail}`);
        return false;
    }
    log(`  Verified: ${vote} R:${relevance} Q:${quality}`);
    return true;
}
async function runCycle(apiKey) {
    // Check balance
    const balance = await getUsdcBalance();
    if (balance < MIN_BALANCE_USD) {
        log(`Balance $${balance.toFixed(3)} below minimum $${MIN_BALANCE_USD}. Pausing.`);
        return;
    }
    const maxAffordable = Math.floor(balance / WITNESS_COST_USD);
    const maxThisCycle = Math.min(MAX_PER_CYCLE, maxAffordable);
    log(`Balance: $${balance.toFixed(3)} — can verify up to ${maxThisCycle} this cycle`);
    // Get active promote tasks
    const tasks = await getActivePromoteTasks(apiKey);
    if (tasks.length === 0) {
        log("No active promote tasks found.");
        return;
    }
    log(`Found ${tasks.length} active promote task(s)`);
    let verified = 0;
    for (const task of tasks) {
        if (verified >= maxThisCycle)
            break;
        const submission = await getNextToVerify(task.id, apiKey);
        if (!submission)
            continue;
        log(`Verifying: task="${task.title.slice(0, 40)}" sub=${submission.submission_id.slice(0, 8)} (phase ${submission.phase})`);
        const ok = await verifySubmission(task, submission, apiKey);
        if (ok)
            verified++;
    }
    log(`Cycle complete: ${verified} verification(s) submitted.`);
}
export async function startAutoVerify() {
    const config = requireConfig();
    const apiKey = config.api_key;
    log("Auto-verify started. Polling every 15 minutes, max 3/cycle.");
    log(`Balance protection: pause below $${MIN_BALANCE_USD}`);
    log("Press Ctrl+C to stop.\n");
    // Run immediately
    await runCycle(apiKey);
    // Schedule recurring
    const timer = setInterval(async () => {
        try {
            await runCycle(apiKey);
        }
        catch (err) {
            log(`Cycle error: ${err.message}`);
        }
    }, POLL_INTERVAL_MS);
    // Graceful shutdown
    process.on("SIGINT", () => {
        clearInterval(timer);
        log("Auto-verify stopped.");
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        clearInterval(timer);
        log("Auto-verify stopped.");
        process.exit(0);
    });
}
