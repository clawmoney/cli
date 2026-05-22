import type { SkillHandler } from "../../types.js";
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
export declare const tkUserPostsSkill: SkillHandler;
