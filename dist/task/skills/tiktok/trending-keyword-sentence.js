import { bnbotTTTrendingKeywordSentence } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkTrendingKeywordSentenceSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const keyword = i.keyword || i.q || i.query;
        if (!keyword)
            throw new Error("missing 'keyword' (or q/query)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok keyword sentence '${keyword}'`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTTrendingKeywordSentence({
                keyword,
                page: i.page,
                limit: i.limit,
                period: i.period,
                country: i.country,
                order_type: i.order_type,
            });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
