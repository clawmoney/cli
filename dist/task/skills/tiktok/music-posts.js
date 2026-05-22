import { bnbotTTMusicPosts } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkMusicPostsSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const musicId = i.musicId || i.id;
        const { cursor, limit } = i;
        if (!musicId)
            throw new Error("missing 'musicId' (or id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok music posts ${musicId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTMusicPosts({ musicId, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
