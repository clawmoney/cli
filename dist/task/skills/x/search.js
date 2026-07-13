import { bnbotXSearch } from "./_bnbot.js";
import { searchToTwitter283 } from "./_mapper.js";
/**
 * `x.search` — twitter283 /Search compatibility. Spareai-hub builds
 * the input from the buyer's GET query; we shell out to `bnbot x
 * scrape search` and re-wrap the result into twitter283's nested
 * envelope.
 */
export const xSearchSkill = {
    price_usd: 0.0001,
    async run(input, ctx) {
        const args = (input ?? {});
        if (!args.q)
            throw new Error("missing 'q'");
        ctx.report({ stage: "launching", percent: 5, note: `search "${args.q}"` });
        const startedAt = Date.now();
        // Synthetic progress while bnbot churns — buyers like to see the
        // stream tick along even though bnbot returns one shot.
        let pct = 10;
        const t = setInterval(() => {
            pct = Math.min(80, pct + 10);
            ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
        }, 1500);
        let raw;
        try {
            raw = await bnbotXSearch(args);
        }
        finally {
            clearInterval(t);
        }
        ctx.report({ stage: "parsing", percent: 95, note: "mapping to twitter283 schema" });
        const wrapped = searchToTwitter283(raw);
        return wrapped;
    },
};
