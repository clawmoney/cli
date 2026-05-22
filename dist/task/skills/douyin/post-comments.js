import { bnbotDYPostComments } from "./_bnbot.js";
import { startProgressTicker } from "../tiktok/_helpers.js";
export const dyPostCommentsSkill = {
    price_usd: 0.0015,
    async run(input, ctx) {
        const i = (input ?? {});
        const video = i.video || i.videoId || i.video_id || i.id;
        const { cursor, limit } = i;
        if (!video)
            throw new Error("missing 'video' (or videoId/video_id/id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `douyin comments of ${video}`,
        });
        const stop = startProgressTicker(ctx, "scrolling comments...");
        try {
            const raw = await bnbotDYPostComments({ video, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
