import type { SkillHandler } from "../../types.js";
import { bnbotYTStreamingData } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
import { isYtDlpInstalled, ytdlpStreamingData } from "./_ytdlp.js";

/**
 * Fetch a video's downloadable streams (mp4 / webm / audio-only) +
 * manifest URLs.
 *
 * Primary: yt-dlp. YouTube returns stub /youtubei/v1/player responses
 * for the target video when a chrome.debugger session is attached
 * (the autoplay-preloaded NEXT video gets real data, but that's the
 * wrong video for the buyer). yt-dlp goes through the ANDROID_VR
 * client path which still receives real streaming URLs.
 *
 * Fallback: bnbot extension's ytInitialPlayerResponse path. Returns
 * format metadata (mime, dimensions, itag) but URLs are empty since
 * YouTube strips them — kept only for hosts without yt-dlp.
 */
export const ytVideoStreamingSkill: SkillHandler = {
  price_usd: 0.0008,
  async run(input, ctx) {
    const { id } = (input ?? {}) as { id?: string };
    if (!id) throw new Error("missing 'id'");
    ctx.report({ stage: "launching", percent: 5, note: `streaming-data ${id}` });

    if (await isYtDlpInstalled()) {
      const stop = startProgressTicker(ctx, "yt-dlp probing formats...");
      try {
        const result = await ytdlpStreamingData(id);
        ctx.report({ stage: "parsing", percent: 95, note: `${result.formats.length}+${result.adaptive_formats.length} formats` });
        return result;
      } finally {
        stop();
      }
    }

    // No yt-dlp on this host — fall back to extension (URLs will be
    // empty, but metadata is real).
    ctx.report({ stage: "launching", percent: 10, note: "yt-dlp absent, falling back to bnbot extension" });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotYTStreamingData(id);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
