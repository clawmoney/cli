import { bnbotTTPostCommentReplies } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkPostCommentRepliesSkill = {
    price_usd: 0.0015,
    async run(input, ctx) {
        const i = (input ?? {});
        const video = i.videoId || i.video || i.id || i.url;
        const commentId = i.commentId || i.comment_id;
        const { cursor, limit } = i;
        if (!video)
            throw new Error("missing 'videoId' (or video/id/url)");
        if (!commentId)
            throw new Error("missing 'commentId' (or comment_id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok comment replies ${commentId}`,
        });
        const stop = startProgressTicker(ctx, "scrolling replies...");
        try {
            const raw = await bnbotTTPostCommentReplies({
                video,
                comment_id: commentId,
                cursor,
                limit,
            });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
