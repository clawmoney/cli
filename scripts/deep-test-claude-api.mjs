// Deep test of the built claude-api module:
//  Phase 1: preflight + version drift + rate-guard wiring
//  Phase 2: 3 concurrent API calls with max_concurrency=2 → queue must activate
//  Phase 3: pure unit test of RateGuard budget enforcement (no token burn)
//
// Run from the project root with the user's HTTPS proxy:
//   https_proxy=http://127.0.0.1:7897 http_proxy=http://127.0.0.1:7897 \
//     node scripts/deep-test-claude-api.mjs

import {
  callClaudeApi,
  preflightClaudeApi,
  getRateGuardSnapshot,
  RateGuardBudgetExceededError,
} from "../dist/relay/upstream/claude-api.js";
import { RateGuard } from "../dist/relay/upstream/rate-guard.js";

const line = (s = "") => console.log(s);

line("━━━ Phase 1: preflight ━━━");
await preflightClaudeApi({
  max_concurrency: 2,
  quiet_hours_max_concurrency: 1,
  quiet_hours: [],
  min_request_gap_ms: 50,
  jitter_ms: 100,
  daily_budget_usd: 1.0,
});

line();
line("━━━ Phase 2: three concurrent requests (expect queue) ━━━");
const prompts = ["say: a", "say: b", "say: c"];
const t0 = Date.now();
const promises = prompts.map((p, i) =>
  callClaudeApi({ prompt: p, model: "claude-sonnet-4-5", maxTokens: 16 })
    .then((r) => ({ i, text: r.text, in: r.usage.input_tokens, out: r.usage.output_tokens }))
    .catch((e) => ({ i, err: e.message }))
);

await new Promise((r) => setTimeout(r, 200));
const peek = getRateGuardSnapshot();
line(`load peek: ${JSON.stringify(peek)}`);
if (peek.inFlight !== 2 || peek.queued !== 1) {
  line(`✗ expected inFlight=2 queued=1, got ${JSON.stringify(peek)}`);
  process.exit(1);
}

const results = await Promise.all(promises);
const elapsedMs = Date.now() - t0;
line(`elapsed: ${elapsedMs}ms`);
for (const r of results) line(`  [${r.i}] ${JSON.stringify(r)}`);
const after = getRateGuardSnapshot();
line(`load after: ${JSON.stringify(after)}`);
if (after.inFlight !== 0 || after.queued !== 0) {
  line(`✗ expected drained, got ${JSON.stringify(after)}`);
  process.exit(1);
}
line("✓ Phase 2 passed");

line();
line("━━━ Phase 3: RateGuard budget unit test ━━━");
const rg = new RateGuard({
  maxConcurrency: 2,
  quietHours: [],
  minRequestGapMs: 0,
  jitterMs: 0,
  dailyBudgetUsd: 0.01,
});
await rg.run(async () => { rg.recordSpend(0.005); return "ok1"; });
await rg.run(async () => { rg.recordSpend(0.006); return "ok2"; });
line(`after 2 calls: ${JSON.stringify(rg.currentLoad())}`);
try {
  await rg.run(async () => "ok3");
  line("✗ expected RateGuardBudgetExceededError, but call went through");
  process.exit(1);
} catch (err) {
  if (err instanceof RateGuardBudgetExceededError) {
    line(`✓ correctly blocked: ${err.message}`);
  } else {
    line(`✗ wrong error type: ${err.message}`);
    process.exit(1);
  }
}

line();
line("━━━ All phases passed ━━━");
