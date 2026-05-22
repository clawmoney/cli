import { bnbotTTPostDetail } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
import { isYtDlpInstalled, ytdlpTikTokPostDetail } from "./_ytdlp.js";
/**
 * Fetch single-post detail.
 *
 * Primary: yt-dlp (`--dump-json` on the video URL/id). The extension
 * scraper hits the `/video/<id>` redirect endpoint which 404s in some
 * regions and yields "Could not parse" otherwise. yt-dlp's TikTok
 * extractor follows the canonical URL and pulls full metadata
 * including video_url, music, dimensions, engagement counts.
 *
 * Fallback: bnbot extension (kept for hosts without yt-dlp).
 */
export const tkPostDetailSkill = {
    price_usd: 0.0008,
    async run(input, ctx) {
        const i = (input ?? {});
        const video = i.videoId || i.video || i.id || i.url;
        if (!video)
            throw new Error("missing 'videoId' (or video/id/url)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok post ${video}`,
        });
        if (await isYtDlpInstalled()) {
            const stop = startProgressTicker(ctx, "yt-dlp probing post...");
            try {
                const r = await ytdlpTikTokPostDetail(video);
                ctx.report({ stage: "parsing", percent: 95 });
                return r;
            }
            finally {
                stop();
            }
        }
        const stop = startProgressTicker(ctx, "bnbot extension fallback...");
        try {
            const raw = await bnbotTTPostDetail(video);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
