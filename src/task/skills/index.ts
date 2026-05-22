import type { SkillHandler } from "../types.js";
import { echoSkill } from "./echo.js";
import { xSearchSkill as xSearchLegacy } from "./x-search.js";
import { xSearchSkill } from "./x/search.js";
import { xUserByScreenNameSkill } from "./x/user-by-screen-name.js";
import { xUserTweetsSkill } from "./x/user-tweets.js";
import { xTweetSkill } from "./x/tweet.js";
import { xTrendsSkill } from "./x/trends.js";
import { xUserFollowersSkill } from "./x/user-followers.js";
import { xUserFollowingSkill } from "./x/user-following.js";
import { xTweetLikersSkill } from "./x/tweet-likers.js";
import { xTweetRetweetersSkill } from "./x/tweet-retweeters.js";
import { xTweetArticleSkill } from "./x/tweet-article.js";
// YouTube skills (Wave 2)
import { ytVideoDetailsSkill } from "./youtube/video-details.js";
import { ytChannelDetailsSkill } from "./youtube/channel-details.js";
import { ytChannelVideosSkill } from "./youtube/channel-videos.js";
import { ytTrendingSkill } from "./youtube/trending.js";
import { ytChannelSearchSkill } from "./youtube/channel-search.js";
import { ytVideoStreamingSkill } from "./youtube/video-streaming.js";
import { ytVideoRelatedSkill } from "./youtube/video-related.js";
import { ytVideoCommentsSkill } from "./youtube/video-comments.js";
import { ytVideoTranscriptSkill } from "./youtube/video-transcript.js";
// TikTok skills (Wave 1)
import { tkSearchVideoSkill } from "./tiktok/search.js";
import { tkSearchAccountSkill } from "./tiktok/search-account.js";
import { tkUserInfoSkill } from "./tiktok/user-info.js";
import { tkUserPostsSkill } from "./tiktok/user-posts.js";
import { tkUserFollowersSkill } from "./tiktok/user-followers.js";
import { tkPostDetailSkill } from "./tiktok/post-detail.js";
import { tkPostCommentsSkill } from "./tiktok/post-comments.js";
import { tkTrendingSkill } from "./tiktok/trending.js";
import { tkVideoDownloadSkill } from "./tiktok/video-download.js";
// `_unimplemented.ts` kept for future stub skills; not used in the
// registry today.

/**
 * In-process skill registry. Each entry maps a skill_id (the same
 * string the provider advertises via `?skills=…` on WS connect, and
 * the same one buyers hit) to a handler. The twitter283
 * compatibility surface on spareai-hub dispatches to these by name.
 *
 * The `x.search` here is the twitter283-compatible mapper (nested
 * envelope). The legacy flat-camelCase version stays exposed as
 * `x.search.legacy` for older buyers / local debug scripts.
 *
 * Tier 3 skills (followers / following / likers / retweeters /
 * article / trends) are real implementations backed by bnbot CLI's
 * tier-3 scrape commands.
 */
export const SKILL_REGISTRY: Record<string, SkillHandler> = {
  echo: echoSkill,
  // twitter283-compat skills — real impls
  "x.search": xSearchSkill,
  "x.user_by_screen_name": xUserByScreenNameSkill,
  "x.user_tweets": xUserTweetsSkill,
  "x.tweet": xTweetSkill,
  // Legacy flat-shape version, kept for back-compat with old buyers.
  "x.search.legacy": xSearchLegacy,
  // Tier 3 — backed by bnbot tier-3 scrape commands
  "x.trends": xTrendsSkill,
  "x.user_followers": xUserFollowersSkill,
  "x.user_following": xUserFollowingSkill,
  "x.tweet_favoriters": xTweetLikersSkill,
  "x.tweet_retweeters": xTweetRetweetersSkill,
  "x.tweet_article": xTweetArticleSkill,
  // YouTube (Wave 2) — chrome extension + youtube.com page reading
  "yt.video_details": ytVideoDetailsSkill,
  "yt.channel_details": ytChannelDetailsSkill,
  "yt.channel_videos": ytChannelVideosSkill,
  "yt.trending": ytTrendingSkill,
  "yt.channel_search": ytChannelSearchSkill,
  "yt.video_streaming": ytVideoStreamingSkill,
  "yt.video_related": ytVideoRelatedSkill,
  "yt.video_comments": ytVideoCommentsSkill,
  "yt.video_transcript": ytVideoTranscriptSkill,
  // TikTok (Wave 1) — chrome extension + tiktok.com page reading;
  // tk.video_download uses yt-dlp directly.
  "tk.search_video": tkSearchVideoSkill,
  "tk.search_account": tkSearchAccountSkill,
  "tk.user_info": tkUserInfoSkill,
  "tk.user_posts": tkUserPostsSkill,
  "tk.user_followers": tkUserFollowersSkill,
  "tk.post_detail": tkPostDetailSkill,
  "tk.post_comments": tkPostCommentsSkill,
  "tk.trending": tkTrendingSkill,
  "tk.video_download": tkVideoDownloadSkill,
};

export function listSkills(): string[] {
  return Object.keys(SKILL_REGISTRY);
}

export function getSkill(skillId: string): SkillHandler | undefined {
  return SKILL_REGISTRY[skillId];
}
