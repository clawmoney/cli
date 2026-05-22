import { startProgressTicker } from "./_helpers.js";
import { isYtDlpInstalled, ytdlpTikTokVideo } from "./_ytdlp.js";
/**
 * Fetch a TikTok video's download formats.
 *
 * yt-dlp only — no extension fallback. TikTok's web-context playAddr
 * URLs are signed, short-lived, and watermarked; yt-dlp resolves the
 * mobile aweme/v1/feed endpoint which currently returns a clean mp4
 * (no visible watermark) plus the bare audio track. There's no useful
 * "fallback to extension" path here.
 */
export const tkVideoDownloadSkill = {
    price_usd: 0.0015,
    async run(input, ctx) {
        // tiktok-api23 sends `url` (a full TikTok video URL); legacy
        // callers may still send `video` / `id` — accept any.
        const i = (input ?? {});
        const video = i.url || i.video || i.id;
        if (!video)
            throw new Error("missing 'url' (TikTok video URL)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok download ${video}`,
        });
        if (!(await isYtDlpInstalled())) {
            throw new Error("yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`");
        }
        const stop = startProgressTicker(ctx, "yt-dlp probing formats...");
        try {
            const result = await ytdlpTikTokVideo(video);
            ctx.report({
                stage: "parsing",
                percent: 95,
                note: `${result.formats.length} formats`,
            });
            return result;
        }
        finally {
            stop();
        }
    },
};
