import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
/**
 * Real x.search via bnbot CLI. Shell-outs to:
 *   bnbot x scrape search <q> -l <limit> [-t <tab>] [...]
 * which talks to the local `bnbot serve` daemon over CDP and dumps the
 * parsed result as a single JSON document on stdout.
 *
 * Provider machine needs:
 *   - bnbot CLI installed and authed (X login persisted in profile)
 *   - `bnbot serve` running (or it'll auto-spawn on first command)
 *
 * Progress is synthesized — bnbot doesn't stream mid-scrape, so we
 * emit fake heartbeats every second while the child runs to keep the
 * NDJSON stream alive past Cloudflare's idle threshold.
 */
export const xSearchSkill = {
    price_usd: 0.0001,
    async run(input, ctx) {
        const raw = (input ?? {});
        const q = (raw.q ?? raw.query ?? "").trim();
        if (!q)
            throw new Error("missing 'q' (or 'query') in input");
        const limit = Math.max(1, Math.min(100, raw.limit ?? 20));
        const tab = raw.tab ?? "top";
        const args = ["x", "scrape", "search", q, "-l", String(limit), "-t", tab];
        if (raw.from)
            args.push("--from", raw.from);
        if (raw.since)
            args.push("--since", raw.since);
        if (raw.until)
            args.push("--until", raw.until);
        if (raw.lang)
            args.push("--lang", raw.lang);
        if (typeof raw.minLikes === "number")
            args.push("--minLikes", String(raw.minLikes));
        if (typeof raw.minRetweets === "number")
            args.push("--minRetweets", String(raw.minRetweets));
        if (raw.has)
            args.push("--has", raw.has);
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `bnbot x scrape search "${q}" -l ${limit}`,
        });
        // Synthetic progress while bnbot churns. Stops as soon as the
        // child exits (Promise.race below picks whichever finishes first).
        let percent = 10;
        const progressTimer = setInterval(() => {
            percent = Math.min(85, percent + 8);
            ctx.report({
                stage: "scraping",
                percent,
                note: "bnbot working...",
            });
        }, 1500);
        let stdout;
        try {
            const result = await exec("bnbot", args, {
                maxBuffer: 16 * 1024 * 1024,
                timeout: 110_000,
            });
            stdout = result.stdout;
        }
        catch (err) {
            // execFile rejects on non-zero exit OR timeout. Pull stderr/stdout
            // off the error object so the buyer gets a useful message.
            const e = err;
            const msg = e.stderr?.trim() || e.message || "bnbot failed";
            throw new Error(`bnbot scrape failed: ${msg}`);
        }
        finally {
            clearInterval(progressTimer);
        }
        ctx.report({ stage: "parsing", percent: 95, note: "decoding result" });
        let parsed;
        try {
            parsed = JSON.parse(stdout);
        }
        catch (err) {
            throw new Error(`bnbot returned non-JSON output (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`);
        }
        return {
            query: q,
            tab,
            limit,
            result: parsed,
        };
    },
};
