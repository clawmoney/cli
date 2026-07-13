import { bnbotXTrends } from "./_bnbot.js";
import { trendsToTwitter283 } from "./_mapper.js";
/**
 * `x.trends` — backs twitter283 /Trends. Hub passes `{woeid}` (defaults
 * to 1, X's worldwide). bnbot ignores woeid for non-personalized
 * accounts but accepts it as a best-effort hint.
 */
export const xTrendsSkill = {
    price_usd: 0.0001,
    async run(input, ctx) {
        const { woeid, count } = (input ?? {});
        ctx.report({
            stage: "launching",
            percent: 10,
            note: `trends woeid=${woeid ?? "default"}`,
        });
        let pct = 15;
        const t = setInterval(() => {
            pct = Math.min(80, pct + 10);
            ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
        }, 1500);
        let raw;
        try {
            raw = await bnbotXTrends({ woeid, limit: count });
        }
        finally {
            clearInterval(t);
        }
        ctx.report({ stage: "parsing", percent: 95 });
        return trendsToTwitter283(raw);
    },
};
