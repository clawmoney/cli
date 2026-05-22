import { bnbotTTPostRelated } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkPostRelatedSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const video = i.videoId || i.video || i.id || i.url;
        const { cursor, limit } = i;
        if (!video)
            throw new Error("missing 'videoId' (or video/id/url)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok related posts ${video}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTPostRelated({ video, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
