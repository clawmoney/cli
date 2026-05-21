import { bnbotYTComments } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const ytVideoCommentsSkill = {
    price_usd: 0.0015,
    async run(input, ctx) {
        const { id } = (input ?? {});
        if (!id)
            throw new Error("missing 'id'");
        ctx.report({ stage: "launching", percent: 5, note: `comments of ${id}` });
        const stop = startProgressTicker(ctx, "scrolling comments...");
        try {
            const raw = await bnbotYTComments(id);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
