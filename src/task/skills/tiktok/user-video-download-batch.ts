import type { SkillHandler } from "../../types.js";
import { startProgressTicker } from "./_helpers.js";
import {
  isYtDlpInstalled,
  ytdlpTikTokUserBatchDownload,
} from "./_ytdlp.js";

/**
 * Bulk-extract a user's videos with direct download URLs.
 *
 * yt-dlp only. The extension scraper's user-posts path can't surface
 * per-video `video_url` (only stats + cover), so the only way to power
 * a buyer's "archive this creator's catalog" use case is to walk each
 * video's full format list. That makes this skill notably slower than
 * `tk.user_posts` — one HTTP round-trip per video — but unavoidable
 * for the use case.
 *
 * tiktok-api23's buyer-facing param is `secUid`, but yt-dlp's TikTok
 * extractor doesn't accept secUid in URLs (the page 404s). We accept
 * secUid for buyer parity but treat it the same as a `@handle` here —
 * yt-dlp resolves the canonical creator page from the user param.
 */
export const tkUserVideoDownloadBatchSkill: SkillHandler = {
  price_usd: 0.005,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      secUid?: string;
      user?: string;
      uniqueId?: string;
      url?: string;
      limit?: number;
    };
    const user = i.user || i.uniqueId || i.secUid || i.url;
    if (!user) throw new Error("missing 'secUid' (or user/uniqueId/url)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok batch download ${user}`,
    });

    if (!(await isYtDlpInstalled())) {
      throw new Error(
        "yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`",
      );
    }

    const stop = startProgressTicker(ctx, "yt-dlp walking user feed...");
    try {
      const result = await ytdlpTikTokUserBatchDownload(user, {
        limit: i.limit,
      });
      ctx.report({
        stage: "parsing",
        percent: 95,
        note: `${result.total_videos} videos`,
      });
      return result;
    } finally {
      stop();
    }
  },
};
