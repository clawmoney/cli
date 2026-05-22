import type { SkillHandler } from "../../types.js";
/**
 * Fetch a TikTok video's download formats.
 *
 * yt-dlp only — no extension fallback. TikTok's web-context playAddr
 * URLs are signed, short-lived, and watermarked; yt-dlp resolves the
 * mobile aweme/v1/feed endpoint which currently returns a clean mp4
 * (no visible watermark) plus the bare audio track. There's no useful
 * "fallback to extension" path here.
 */
export declare const tkVideoDownloadSkill: SkillHandler;
