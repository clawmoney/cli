import { bnbotTTPostComments } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkPostCommentsSkill = {
    price_usd: 0.0015,
    async run(input, ctx) {
        const i = (input ?? {});
        const video = i.videoId || i.video || i.id || i.url;
        const { cursor, limit } = i;
        if (!video)
            throw new Error("missing 'videoId' (or video/id/url)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok comments of ${video}`,
        });
        const stop = startProgressTicker(ctx, "scrolling comments...");
        try {
            const raw = await bnbotTTPostComments({ video, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
