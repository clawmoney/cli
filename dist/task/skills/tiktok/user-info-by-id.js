import { bnbotTTUserInfoById } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkUserInfoByIdSkill = {
    price_usd: 0.0008,
    async run(input, ctx) {
        const i = (input ?? {});
        const userId = i.userId || i.user || i.id;
        if (!userId)
            throw new Error("missing 'userId' (or user/id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok user-by-id ${userId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTUserInfoById(userId);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
