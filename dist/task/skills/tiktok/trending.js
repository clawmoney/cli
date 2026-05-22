import { bnbotTTTrending } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkTrendingSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const { limit } = (input ?? {});
        ctx.report({ stage: "launching", percent: 5, note: "tiktok trending" });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTTrending(limit);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
