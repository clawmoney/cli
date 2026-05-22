import { bnbotTTPostDiscover } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkPostDiscoverSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const keyword = i.keyword || i.q || i.query;
        const { page } = i;
        if (!keyword)
            throw new Error("missing 'keyword' (or q/query)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok discover '${keyword}'`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTPostDiscover({ keyword, page });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
