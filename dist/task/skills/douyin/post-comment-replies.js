import { bnbotDYPostCommentReplies } from "./_bnbot.js";
import { startProgressTicker } from "../tiktok/_helpers.js";
export const dyPostCommentRepliesSkill = {
    price_usd: 0.0015,
    async run(input, ctx) {
        const i = (input ?? {});
        const video = i.video || i.videoId || i.video_id || i.id;
        const commentId = i.commentId || i.comment_id;
        const { cursor, limit } = i;
        if (!video)
            throw new Error("missing 'video' (or videoId/video_id/id)");
        if (!commentId)
            throw new Error("missing 'commentId' (or comment_id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `douyin comment replies ${commentId}`,
        });
        const stop = startProgressTicker(ctx, "scrolling replies...");
        try {
            const raw = await bnbotDYPostCommentReplies({
                video,
                commentId,
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
