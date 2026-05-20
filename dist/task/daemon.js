#!/usr/bin/env tsx
/**
 * Task-protocol daemon entry. Connects to spareai-hub and dispatches
 * incoming `task_request` frames to the local skill registry.
 *
 * Run for local development against `wrangler dev`:
 *
 *   HUB_URL=ws://127.0.0.1:8787/ws/relay \
 *   AGENT_ID=clawmoney-dev \
 *   SKILLS=echo,x.search \
 *   npx tsx src/task/daemon.ts
 *
 * Run against production:
 *
 *   HUB_URL=wss://api.spareapi.ai/ws/relay \
 *   API_KEY=$CLAWMONEY_API_KEY \
 *   SKILLS=x.search \
 *   npx tsx src/task/daemon.ts
 *
 * No CLI integration yet — that lands in Phase 3 alongside the proper
 * `clawmoney task start` command.
 */
import { TaskWsClient } from "./ws-client.js";
import { getSkill, listSkills } from "./skills/index.js";
function loadConfigFromEnv() {
    const skillsEnv = process.env.SKILLS ?? "";
    const requested = skillsEnv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const skills = requested.length > 0 ? requested : listSkills();
    // Sanity-check: drop anything we can't actually serve so we don't
    // advertise dead skills to the hub.
    const supported = new Set(listSkills());
    const filtered = skills.filter((s) => {
        if (!supported.has(s)) {
            console.warn(`[task] skill "${s}" not registered, skipping`);
            return false;
        }
        return true;
    });
    return {
        hub_url: process.env.HUB_URL ?? "wss://api.spareapi.ai/ws/relay",
        api_key: process.env.API_KEY ?? "",
        agent_id: process.env.AGENT_ID,
        agent_name: process.env.AGENT_NAME ?? "clawmoney-task",
        skills: filtered,
        max_concurrency: process.env.MAX_CONCURRENCY
            ? Number.parseInt(process.env.MAX_CONCURRENCY, 10)
            : 5,
        heartbeat_ms: 5000,
        reconnect: { initial_ms: 1000, max_ms: 60_000, multiplier: 2 },
    };
}
async function handleTaskRequest(ws, req) {
    const startedAtMs = Date.now();
    const handler = getSkill(req.skill_id);
    if (!handler) {
        ws.send({
            event: "task_response",
            request_id: req.request_id,
            error: `skill "${req.skill_id}" not implemented on this provider`,
            cost_usd: 0,
            duration_ms: Date.now() - startedAtMs,
        });
        return;
    }
    const ctx = {
        request_id: req.request_id,
        buyer_id: req.buyer_id,
        report: (progress) => {
            ws.send({
                event: "task_progress",
                request_id: req.request_id,
                ...progress,
            });
        },
    };
    // Per-task timeout — the hub also enforces this, but the local
    // wrapper avoids leaking a hung skill into our concurrency budget.
    let timer = null;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`skill timeout after ${req.timeout_ms}ms`)), req.timeout_ms);
        timer.unref();
    });
    try {
        const output = await Promise.race([handler.run(req.input, ctx), timeoutPromise]);
        ws.send({
            event: "task_response",
            request_id: req.request_id,
            output,
            cost_usd: handler.price_usd,
            duration_ms: Date.now() - startedAtMs,
        });
    }
    catch (err) {
        ws.send({
            event: "task_response",
            request_id: req.request_id,
            error: err instanceof Error ? err.message : String(err),
            cost_usd: 0,
            duration_ms: Date.now() - startedAtMs,
        });
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function main() {
    const config = loadConfigFromEnv();
    console.log(`[task] starting daemon hub=${config.hub_url} skills=[${config.skills.join(",")}]`);
    if (config.skills.length === 0) {
        console.error("[task] no skills to advertise — refusing to start");
        process.exit(1);
    }
    const ws = new TaskWsClient(config, (frame) => {
        switch (frame.event) {
            case "connected":
                console.log(`[task] connected agent_id=${frame.agent_id} name="${frame.agent_name}"`);
                break;
            case "task_request":
                void handleTaskRequest(ws, frame);
                break;
            case "heartbeat_ack":
                // Silent — the hub bumps KV TTL for us.
                break;
            case "error":
                console.error(`[task] hub error: ${frame.message}`);
                break;
        }
    });
    const shutdown = (signal) => {
        console.log(`[task] ${signal} — shutting down`);
        ws.stop();
        setTimeout(() => process.exit(0), 200);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    ws.start();
}
main();
