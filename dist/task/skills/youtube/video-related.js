import { bnbotYTRelated } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const ytVideoRelatedSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const { id } = (input ?? {});
        if (!id)
            throw new Error("missing 'id'");
        ctx.report({ stage: "launching", percent: 5, note: `related of ${id}` });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotYTRelated(id);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
