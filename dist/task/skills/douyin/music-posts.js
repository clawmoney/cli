import { bnbotDYMusicPosts } from "./_bnbot.js";
import { startProgressTicker } from "../tiktok/_helpers.js";
export const dyMusicPostsSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const musicId = i.musicId || i.music_id || i.id;
        const { cursor, limit } = i;
        if (!musicId)
            throw new Error("missing 'musicId' (or music_id/id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `douyin music posts ${musicId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotDYMusicPosts({ musicId, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
