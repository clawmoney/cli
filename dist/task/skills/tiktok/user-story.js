import { bnbotTTUserStory } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkUserStorySkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const userId = i.userId || i.user || i.id;
        const { maxCursor } = i;
        if (!userId)
            throw new Error("missing 'userId' (or user/id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok stories of ${userId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTUserStory({ userId, maxCursor });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
