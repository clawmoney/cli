import type { SkillHandler } from "../../types.js";
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
export declare const tkPostDetailSkill: SkillHandler;
