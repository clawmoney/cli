import { bnbotTTUserLikedPosts } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkUserLikedPostsSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const user = i.secUid || i.user || i.uniqueId || i.handle;
        const { cursor, limit } = i;
        if (!user)
            throw new Error("missing 'secUid' (or user/uniqueId/handle)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok liked posts of ${user}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTUserLikedPosts({ user, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
