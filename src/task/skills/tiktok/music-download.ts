import type { SkillHandler } from "../../types.js";
import { startProgressTicker } from "./_helpers.js";
import { isYtDlpInstalled, ytdlpTikTokMusicDownload } from "./_ytdlp.js";

/**
 * Fetch a TikTok video's bare audio track (the music/sound layer).
 *
 * yt-dlp only — same reasoning as `tk.video_download`. TikTok's web
 * playAddr URLs include the user's voiceover; the audio-only format in
 * yt-dlp's `formats[]` is the underlying music stream. We don't
 * re-encode (no `--extract-audio --audio-format mp3`); the buyer gets
 * the raw stream URL + ext, and can transcode locally if they want mp3.
 */
export const tkMusicDownloadSkill: SkillHandler = {
  price_usd: 0.0015,
  async run(input, ctx) {
    const i = (input ?? {}) as { url?: string; video?: string; id?: string };
    const video = i.url || i.video || i.id;
    if (!video) throw new Error("missing 'url' (TikTok video URL)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok music download ${video}`,
    });

    if (!(await isYtDlpInstalled())) {
      throw new Error(
        "yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`",
      );
    }

    const stop = startProgressTicker(ctx, "yt-dlp pulling audio track...");
    try {
      const result = await ytdlpTikTokMusicDownload(video);
      ctx.report({ stage: "parsing", percent: 95 });
      return result;
    } finally {
      stop();
    }
  },
};
