import type { SkillHandler } from "../../types.js";
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
export declare const tkUserVideoDownloadBatchSkill: SkillHandler;
