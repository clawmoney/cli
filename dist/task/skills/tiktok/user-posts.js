import { bnbotTTUserPosts } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
import { isYtDlpInstalled, ytdlpTikTokUserPosts } from "./_ytdlp.js";
/**
 * Fetch a TikTok user's posts.
 *
 * Primary: yt-dlp (`--flat-playlist` against `https://www.tiktok.com/@<handle>`).
 * TikTok's web `/api/post/item_list/` endpoint returns empty 200 bodies
 * to any chrome.debugger-attached session (anti-bot stub), so the
 * extension scraper can't fetch real data. yt-dlp's mobile-aweme path
 * still works.
 *
 * Fallback: bnbot extension scraper (will return an empty list with
 * a "Failed to parse" error until TikTok lifts the stub).
 */
export const tkUserPostsSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const user = i.user || i.uniqueId || i.secUid;
        const { cursor, limit } = i;
        if (!user)
            throw new Error("missing 'user' (handle or secUid)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok posts of ${user}`,
        });
        if (await isYtDlpInstalled()) {
            const stop = startProgressTicker(ctx, "yt-dlp probing user feed...");
            try {
                const r = await ytdlpTikTokUserPosts(user, limit ?? 30);
                ctx.report({
                    stage: "parsing",
                    percent: 95,
                    note: `${r.videos.length} videos`,
                });
                return r;
            }
            finally {
                stop();
            }
        }
        // Fallback (will likely fail until TikTok lifts the empty-body stub).
        const stop = startProgressTicker(ctx, "bnbot extension fallback...");
        try {
            const raw = await bnbotTTUserPosts({ user, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
