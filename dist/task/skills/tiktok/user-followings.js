import { bnbotTTUserFollowings } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkUserFollowingsSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const user = i.secUid || i.user || i.uniqueId || i.handle;
        const { max_time, limit } = i;
        if (!user)
            throw new Error("missing 'secUid' (or user/uniqueId/handle)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok followings of ${user}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTUserFollowings({ user, max_time, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
