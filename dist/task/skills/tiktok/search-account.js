import { bnbotTTSearchAccount } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkSearchAccountSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const q = i.keyword || i.q || i.query;
        const { limit } = i;
        if (!q)
            throw new Error("missing 'keyword' (or q/query)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok account search '${q}'`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTSearchAccount(q, limit);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
