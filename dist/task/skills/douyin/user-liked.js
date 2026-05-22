import { bnbotDYUserLiked } from "./_bnbot.js";
import { startProgressTicker } from "../tiktok/_helpers.js";
export const dyUserLikedPostsSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const secUid = i.secUid || i.user_sec_uid || i.sec_user_id;
        const { cursor, limit } = i;
        if (!secUid)
            throw new Error("missing 'secUid' (or user_sec_uid/sec_user_id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `douyin liked posts of ${secUid}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotDYUserLiked({ secUid, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
