import { bnbotYTVideoDetails } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const ytVideoDetailsSkill = {
    price_usd: 0.0008,
    async run(input, ctx) {
        const { id } = (input ?? {});
        if (!id)
            throw new Error("missing 'id'");
        ctx.report({ stage: "launching", percent: 5, note: `video ${id}` });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotYTVideoDetails(id);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
