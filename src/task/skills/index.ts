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
// TikTok skills (Wave 2/3/4)
import { tkChallengeInfoSkill } from "./tiktok/challenge-info.js";
import { tkChallengePostsSkill } from "./tiktok/challenge-posts.js";
import { tkMusicInfoSkill } from "./tiktok/music-info.js";
import { tkMusicPostsSkill } from "./tiktok/music-posts.js";
import { tkMusicUnlimitedSoundsSkill } from "./tiktok/music-unlimited.js";
import { tkUserInfoRegionSkill } from "./tiktok/user-info-region.js";
import { tkUserInfoByIdSkill } from "./tiktok/user-info-by-id.js";
import { tkUserFollowingsSkill } from "./tiktok/user-followings.js";
import { tkUserLikedPostsSkill } from "./tiktok/user-liked-posts.js";
import { tkUserPlaylistSkill } from "./tiktok/user-playlist.js";
import { tkUserRepostSkill } from "./tiktok/user-repost.js";
import { tkUserStorySkill } from "./tiktok/user-story.js";
import { tkSearchGeneralSkill } from "./tiktok/search-general.js";
import { tkSearchLiveSkill } from "./tiktok/search-live.js";
import { tkSearchSuggestionsSkill } from "./tiktok/search-suggestions.js";
import { tkPostRelatedSkill } from "./tiktok/post-related.js";
import { tkPostExploreSkill } from "./tiktok/post-explore.js";
import { tkPostDiscoverSkill } from "./tiktok/post-discover.js";
// TikTok Wave 5 (Creative Center / Ads)
import { tkAdsDetailSkill } from "./tiktok/ads-detail.js";
import { tkAdsTopSkill } from "./tiktok/ads-top.js";
import { tkTrendingCreatorSkill } from "./tiktok/trending-creator.js";
import { tkTrendingVideoSkill } from "./tiktok/trending-video.js";
import { tkTrendingHashtagSkill } from "./tiktok/trending-hashtag.js";
import { tkTrendingSongSkill } from "./tiktok/trending-song.js";
import { tkTrendingKeywordSkill } from "./tiktok/trending-keyword.js";
import { tkTrendingKeywordPostsSkill } from "./tiktok/trending-keyword-posts.js";
import { tkTrendingKeywordSentenceSkill } from "./tiktok/trending-keyword-sentence.js";
import { tkCommercialMusicLibrarySkill } from "./tiktok/commercial-music.js";
import { tkCommercialMusicPlaylistsSkill } from "./tiktok/commercial-playlists.js";
import { tkCommercialMusicPlaylistDetailSkill } from "./tiktok/commercial-playlist-detail.js";
import { tkTopProductsSkill } from "./tiktok/top-products.js";
import { tkTopProductDetailSkill } from "./tiktok/top-product-detail.js";
import { tkTopProductMetricsSkill } from "./tiktok/top-product-metrics.js";
// TikTok Wave 6 (long-tail)
import { tkPlaceInfoSkill } from "./tiktok/place-info.js";
import { tkPlacePostsSkill } from "./tiktok/place-posts.js";
import { tkEffectInfoSkill } from "./tiktok/effect-info.js";
import { tkEffectPostsSkill } from "./tiktok/effect-posts.js";
import { tkCollectionInfoSkill } from "./tiktok/collection-info.js";
import { tkCollectionPostsSkill } from "./tiktok/collection-posts.js";
import { tkPostCommentRepliesSkill } from "./tiktok/post-comment-replies.js";
import { tkMusicDownloadSkill } from "./tiktok/music-download.js";
import { tkUserVideoDownloadBatchSkill } from "./tiktok/user-video-download-batch.js";
// Douyin skills (Wave 1)
import { dyUserInfoSkill } from "./douyin/user-info.js";
import { dyUserPostsSkill } from "./douyin/user-posts.js";
import { dyUserLikedPostsSkill } from "./douyin/user-liked.js";
import { dyUserFollowersSkill } from "./douyin/user-followers.js";
import { dyUserFollowingSkill } from "./douyin/user-following.js";
import { dyPostCommentsSkill } from "./douyin/post-comments.js";
import { dySearchGeneralSkill } from "./douyin/search-general.js";
import { dySearchVideoSkill } from "./douyin/search-video.js";
import { dySearchAccountSkill } from "./douyin/search-account.js";
import { dySearchLiveSkill } from "./douyin/search-live.js";
import { dyChallengePostsSkill } from "./douyin/challenge-posts.js";
import { dyMusicPostsSkill } from "./douyin/music-posts.js";
// Reddit skills (Wave 1)
import { rdPopularPostsSkill } from "./reddit/popular-posts.js";
import { rdTopPopularPostsSkill } from "./reddit/top-popular-posts.js";
import { rdRisingPopularPostsSkill } from "./reddit/rising-popular-posts.js";
import { rdBestPopularPostsSkill } from "./reddit/best-popular-posts.js";
import { rdPopularPostsByCountrySkill } from "./reddit/popular-posts-by-country.js";
import { rdPostsBySubredditSkill } from "./reddit/posts-by-subreddit.js";
import { rdTopPostsBySubredditSkill } from "./reddit/top-posts-by-subreddit.js";
import { rdControversialPostsBySubredditSkill } from "./reddit/controversial-posts-by-subreddit.js";
import { rdCommentsBySubredditSkill } from "./reddit/comments-by-subreddit.js";
import { rdSubredditInfoSkill } from "./reddit/subreddit-info.js";
import { rdSubredditRulesSkill } from "./reddit/subreddit-rules.js";
import { rdSimilarSubredditsSkill } from "./reddit/similar-subreddits.js";
import { rdNewSubredditsSkill } from "./reddit/new-subreddits.js";
import { rdPopularSubredditsSkill } from "./reddit/popular-subreddits.js";
import { rdPostsByUsernameSkill } from "./reddit/posts-by-username.js";
import { rdTopPostsByUsernameSkill } from "./reddit/top-posts-by-username.js";
import { rdCommentsByUsernameSkill } from "./reddit/comments-by-username.js";
import { rdTopCommentsByUsernameSkill } from "./reddit/top-comments-by-username.js";
import { rdUserOverviewSkill } from "./reddit/user-overview.js";
import { rdUserPostRankInSubredditSkill } from "./reddit/user-post-rank-in-subreddit.js";
import { rdProfileSkill } from "./reddit/profile.js";
import { rdUserStatsSkill } from "./reddit/user-stats.js";
import { rdSearchUsersSkill } from "./reddit/search-users.js";
import { rdSearchPostsSkill } from "./reddit/search-posts.js";
import { rdSearchSubredditsSkill } from "./reddit/search-subreddits.js";
import { rdPostDetailsSkill } from "./reddit/post-details.js";
import { rdPostCommentsSkill } from "./reddit/post-comments.js";
import { rdPostCommentsWithSortSkill } from "./reddit/post-comments-with-sort.js";
import { rdPostDuplicatesSkill } from "./reddit/post-duplicates.js";
// Xiaohongshu skills (Wave 1)
import { xhsCreatorHotInspirationFeedSkill } from "./xiaohongshu/creator-hot-inspiration-feed.js";
import { xhsProductRecommendationsSkill } from "./xiaohongshu/product-recommendations.js";
import { xhsNoteCommentsSkill } from "./xiaohongshu/note-comments.js";
import { xhsSearchGroupsSkill } from "./xiaohongshu/search-groups.js";
import { xhsMixedNoteDetailSkill } from "./xiaohongshu/mixed-note-detail.js";
import { xhsSearchNotesSkill } from "./xiaohongshu/search-notes.js";
import { xhsProductDetailSkill } from "./xiaohongshu/product-detail.js";
import { xhsCreatorInspirationFeedSkill } from "./xiaohongshu/creator-inspiration-feed.js";
import { xhsImageNoteDetailSkill } from "./xiaohongshu/image-note-detail.js";
// LinkedIn skills (Wave 0)
import { liJobSearchSkill } from "./linkedin/job-search.js";
// Bilibili skills (Wave 0)
import { biliSearchSkill } from "./bilibili/search.js";
import { biliHotSkill } from "./bilibili/hot.js";
import { biliRankingSkill } from "./bilibili/ranking.js";
import { biliVideoSkill } from "./bilibili/video.js";
import { biliSubtitleSkill } from "./bilibili/subtitle.js";
import { biliCommentsSkill } from "./bilibili/comments.js";
import { biliFollowingSkill } from "./bilibili/following.js";
import { biliUserVideosSkill } from "./bilibili/user-videos.js";
import { biliFeedSkill } from "./bilibili/feed.js";
import { biliFeedDetailSkill } from "./bilibili/feed-detail.js";
import { biliDownloadSkill } from "./bilibili/download.js";
// OpenCLI public/browser read skills (Google, HN, Wikipedia, etc.)
import {
  ggSearchSkill, ggSuggestSkill, ggNewsSkill, ggTrendsSkill,
  wxmpArticleSearchSkill, wxmpArticleSkill,
  hnTopSkill, hnNewSkill, hnBestSkill, hnAskSkill, hnShowSkill, hnJobsSkill,
  hnSearchSkill, hnUserSkill, hnReadSkill,
  wikiSearchSkill, wikiSummarySkill, wikiRandomSkill, wikiTrendingSkill, wikiPageSkill,
  yfQuoteSkill,
  zhSearchSkill, zhHotSkill, zhRecommendSkill, zhQuestionSkill,
  zhAnswerDetailSkill, zhAnswerCommentsSkill,
  bbcNewsSkill, bbcTopicSkill,
  bbgMainSkill, bbgMarketsSkill, bbgEconomicsSkill, bbgIndustriesSkill,
  bbgTechSkill, bbgPoliticsSkill, bbgBusinessweekSkill, bbgOpinionsSkill, bbgFeedsSkill,
  bbgArticleSkill,
  medSearchSkill, medTagSkill, medFeedSkill, medUserSkill,
  subSearchSkill, subPublicationSkill, subFeedSkill,
  wbHotSkill, wbSearchSkill, wbFeedSkill, wbUserSkill, wbPostSkill, wbCommentsSkill,
  kr36NewsSkill, kr36HotSkill, kr36SearchSkill, kr36ArticleSkill,
  dbSearchSkill, dbMovieHotSkill, dbBookHotSkill, dbTop250Skill, dbPhotosSkill,
  sfNewsSkill, sfRollingNewsSkill, sfStockSkill,
  jkFeedSkill, jkSearchSkill,
  xqSearchSkill, xqHotSkill, xqHotStockSkill, xqStockSkill, xqCommentsSkill, xqKlineSkill, xqEarningsDateSkill,
  xyzPodcastSkill, xyzPodcastEpisodesSkill, xyzEpisodeSkill,
  fbSearchSkill, fbProfileSkill, fbEventsSkill,
  wrSearchSkill, wrRankingSkill, wrBookSkill,
  ctSearchSkill, ctHotelSuggestSkill, ctHotelSearchSkill, ctFlightSkill,
  ycCompaniesSkill, ihProductsSkill, ksDiscoverSkill, igExploreSkill,
} from "./opencli/platforms.js";
// Codex Desktop generation skills
import { codexImageGenerateSkill } from "./codex/image-generate.js";
// ChatGPT Desktop skills
import { chatgptAskSkill } from "./chatgpt/ask.js";
import { chatgptImageGenerateSkill } from "./chatgpt/image-generate.js";
import { chatgptWebImageGenerateSkill } from "./chatgpt/web-image-generate.js";
// Gemini API skills
import { geminiImageGenerateSkill } from "./gemini/image-generate.js";
// Google Labs Flow skills
import { flowVideoGenerateSkill } from "./flow/video-generate.js";
import { flowImageGenerateSkill } from "./flow/image-generate.js";
// Apify-equivalent scrapers — Amazon / Google Maps / Web Scraper / web read.
import {
  amazonProductSkill, amazonOfferSkill, amazonSearchSkill,
  ggMapsSkill, webScrapeSkill, webReadSkill,
} from "./opencli/scrapers.js";
// LinkedIn lead-gen / Sales Navigator (read-only, queries others' public data).
import {
  liPeopleSearchSkill, liSalesnavSearchSkill, liProfileSkill,
  liProfileExperienceSkill, liProfileProjectsSkill, liPostsSkill, liJobDetailSkill,
} from "./opencli/linkedin-salesnav.js";
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
  // TikTok (Wave 2/3/4) — chrome extension fan-out, tiktok-api23 schema
  "tk.challenge_info": tkChallengeInfoSkill,
  "tk.challenge_posts": tkChallengePostsSkill,
  "tk.music_info": tkMusicInfoSkill,
  "tk.music_posts": tkMusicPostsSkill,
  "tk.music_unlimited_sounds": tkMusicUnlimitedSoundsSkill,
  "tk.user_info_region": tkUserInfoRegionSkill,
  "tk.user_info_by_id": tkUserInfoByIdSkill,
  "tk.user_followings": tkUserFollowingsSkill,
  "tk.user_liked_posts": tkUserLikedPostsSkill,
  "tk.user_playlist": tkUserPlaylistSkill,
  "tk.user_repost": tkUserRepostSkill,
  "tk.user_story": tkUserStorySkill,
  "tk.search_general": tkSearchGeneralSkill,
  "tk.search_live": tkSearchLiveSkill,
  "tk.search_suggestions": tkSearchSuggestionsSkill,
  "tk.post_related": tkPostRelatedSkill,
  "tk.post_explore": tkPostExploreSkill,
  "tk.post_discover": tkPostDiscoverSkill,
  // TikTok Wave 5 (Creative Center / Ads) — ads.tiktok.com separate
  // host, TikTok For Business login required on the scraper host. The
  // underlying /creative_radar_api/v1/* endpoint paths are best-effort
  // guesses; on auth fail or 404 the skill surfaces a structured
  // `{ error: 'tiktok-ads-...' }` envelope so buyers can branch.
  "tk.ads_detail": tkAdsDetailSkill,
  "tk.ads_top": tkAdsTopSkill,
  "tk.trending_creator": tkTrendingCreatorSkill,
  "tk.trending_video": tkTrendingVideoSkill,
  "tk.trending_hashtag": tkTrendingHashtagSkill,
  "tk.trending_song": tkTrendingSongSkill,
  "tk.trending_keyword": tkTrendingKeywordSkill,
  "tk.trending_keyword_posts": tkTrendingKeywordPostsSkill,
  "tk.trending_keyword_sentence": tkTrendingKeywordSentenceSkill,
  "tk.commercial_music_library": tkCommercialMusicLibrarySkill,
  "tk.commercial_music_playlists": tkCommercialMusicPlaylistsSkill,
  "tk.commercial_music_playlist_detail": tkCommercialMusicPlaylistDetailSkill,
  "tk.top_products": tkTopProductsSkill,
  "tk.top_product_detail": tkTopProductDetailSkill,
  "tk.top_product_metrics": tkTopProductMetricsSkill,
  // TikTok Wave 6 (long-tail) — place / effect / collection /
  // comment-replies on regular www.tiktok.com (same auth as Wave 1-4),
  // plus 2 yt-dlp pulls (music_download + user_video_download_batch).
  // place_info / effect_info hit landing-page rehydration scripts whose
  // namespace shape is a best-effort guess — on miss the underlying
  // scraper surfaces a structured `{ error: 'TikTok place/effect detail
  // endpoint unknown — please flag for follow-up reverse-engineering' }`
  // envelope so buyers can branch on it.
  "tk.place_info": tkPlaceInfoSkill,
  "tk.place_posts": tkPlacePostsSkill,
  "tk.effect_info": tkEffectInfoSkill,
  "tk.effect_posts": tkEffectPostsSkill,
  "tk.collection_info": tkCollectionInfoSkill,
  "tk.collection_posts": tkCollectionPostsSkill,
  "tk.post_comment_replies": tkPostCommentRepliesSkill,
  "tk.music_download": tkMusicDownloadSkill,
  "tk.user_video_download_batch": tkUserVideoDownloadBatchSkill,
  // Douyin (Wave 1) — chrome extension on douyin.com, mirrors the
  // douyin-api23 RapidAPI surface. secUid is the canonical user id;
  // pagination cursor flavor varies per endpoint (max_time for
  // follower/following, cursor for posts/liked/music_posts/comments,
  // offset for search-general/video/live/challenge_posts).
  "dy.user_info": dyUserInfoSkill,
  "dy.user_posts": dyUserPostsSkill,
  "dy.user_liked_posts": dyUserLikedPostsSkill,
  "dy.user_followers": dyUserFollowersSkill,
  "dy.user_following": dyUserFollowingSkill,
  "dy.post_comments": dyPostCommentsSkill,
  "dy.search_general": dySearchGeneralSkill,
  "dy.search_video": dySearchVideoSkill,
  "dy.search_account": dySearchAccountSkill,
  "dy.search_live": dySearchLiveSkill,
  "dy.challenge_posts": dyChallengePostsSkill,
  "dy.music_posts": dyMusicPostsSkill,
  // Reddit (Wave 1) — reddit34-compatible GET surface backed by
  // Reddit public JSON through the BNBot browser provider path.
  "rd.popular_posts": rdPopularPostsSkill,
  "rd.top_popular_posts": rdTopPopularPostsSkill,
  "rd.rising_popular_posts": rdRisingPopularPostsSkill,
  "rd.best_popular_posts": rdBestPopularPostsSkill,
  "rd.popular_posts_by_country": rdPopularPostsByCountrySkill,
  "rd.posts_by_subreddit": rdPostsBySubredditSkill,
  "rd.top_posts_by_subreddit": rdTopPostsBySubredditSkill,
  "rd.controversial_posts_by_subreddit": rdControversialPostsBySubredditSkill,
  "rd.comments_by_subreddit": rdCommentsBySubredditSkill,
  "rd.subreddit_info": rdSubredditInfoSkill,
  "rd.subreddit_rules": rdSubredditRulesSkill,
  "rd.similar_subreddits": rdSimilarSubredditsSkill,
  "rd.new_subreddits": rdNewSubredditsSkill,
  "rd.popular_subreddits": rdPopularSubredditsSkill,
  "rd.posts_by_username": rdPostsByUsernameSkill,
  "rd.top_posts_by_username": rdTopPostsByUsernameSkill,
  "rd.comments_by_username": rdCommentsByUsernameSkill,
  "rd.top_comments_by_username": rdTopCommentsByUsernameSkill,
  "rd.user_overview": rdUserOverviewSkill,
  "rd.user_post_rank_in_subreddit": rdUserPostRankInSubredditSkill,
  "rd.profile": rdProfileSkill,
  "rd.user_stats": rdUserStatsSkill,
  "rd.search_users": rdSearchUsersSkill,
  "rd.search_posts": rdSearchPostsSkill,
  "rd.search_subreddits": rdSearchSubredditsSkill,
  "rd.post_details": rdPostDetailsSkill,
  "rd.post_comments": rdPostCommentsSkill,
  "rd.post_comments_with_sort": rdPostCommentsWithSortSkill,
  "rd.post_duplicates": rdPostDuplicatesSkill,
  // Xiaohongshu (Wave 1) — accepted low-risk Web surface only.
  "xhs.creator_hot_inspiration_feed": xhsCreatorHotInspirationFeedSkill,
  "xhs.product_recommendations": xhsProductRecommendationsSkill,
  "xhs.note_comments": xhsNoteCommentsSkill,
  "xhs.search_groups": xhsSearchGroupsSkill,
  "xhs.mixed_note_detail": xhsMixedNoteDetailSkill,
  "xhs.search_notes": xhsSearchNotesSkill,
  "xhs.product_detail": xhsProductDetailSkill,
  "xhs.creator_inspiration_feed": xhsCreatorInspirationFeedSkill,
  "xhs.image_note_detail": xhsImageNoteDetailSkill,
  // LinkedIn (Wave 0) — read-only jobs search through bnbot's
  // existing linkedin.com Voyager scraper. Broader RapidAPI-compatible
  // profile/company/post endpoints wait for the user's curl list.
  "li.job_search": liJobSearchSkill,
  // Bilibili — public/read-only browser surface. Current-account data,
  // `comment` write, and local file `download` are intentionally not advertised.
  "bili.search": biliSearchSkill,
  "bili.hot": biliHotSkill,
  "bili.ranking": biliRankingSkill,
  "bili.video": biliVideoSkill,
  "bili.subtitle": biliSubtitleSkill,
  "bili.comments": biliCommentsSkill,
  "bili.following": biliFollowingSkill,
  "bili.user_videos": biliUserVideosSkill,
  "bili.feed": biliFeedSkill,
  "bili.feed_detail": biliFeedDetailSkill,
  "bili.download": biliDownloadSkill,
  // Google / Weixin / HN / Wikipedia / Yahoo Finance / Zhihu /
  // BBC / Bloomberg / Medium / Substack — OpenCLI-aligned read surface.
  "gg.search": ggSearchSkill,
  "gg.suggest": ggSuggestSkill,
  "gg.news": ggNewsSkill,
  "gg.trends": ggTrendsSkill,
  "wxmp.article_search": wxmpArticleSearchSkill,
  "wxmp.article": wxmpArticleSkill,
  "hn.top": hnTopSkill,
  "hn.new": hnNewSkill,
  "hn.best": hnBestSkill,
  "hn.ask": hnAskSkill,
  "hn.show": hnShowSkill,
  "hn.jobs": hnJobsSkill,
  "hn.search": hnSearchSkill,
  "hn.user": hnUserSkill,
  "hn.read": hnReadSkill,
  "yc.companies": ycCompaniesSkill,
  "ih.products": ihProductsSkill,
  "ks.discover": ksDiscoverSkill,
  "igg.explore": igExploreSkill,
  "wiki.search": wikiSearchSkill,
  "wiki.summary": wikiSummarySkill,
  "wiki.random": wikiRandomSkill,
  "wiki.trending": wikiTrendingSkill,
  "wiki.page": wikiPageSkill,
  "yf.quote": yfQuoteSkill,
  "zh.search": zhSearchSkill,
  "zh.hot": zhHotSkill,
  "zh.recommend": zhRecommendSkill,
  "zh.question": zhQuestionSkill,
  "zh.answer_detail": zhAnswerDetailSkill,
  "zh.answer_comments": zhAnswerCommentsSkill,
  "bbc.news": bbcNewsSkill,
  "bbc.topic": bbcTopicSkill,
  "bbg.main": bbgMainSkill,
  "bbg.markets": bbgMarketsSkill,
  "bbg.economics": bbgEconomicsSkill,
  "bbg.industries": bbgIndustriesSkill,
  "bbg.tech": bbgTechSkill,
  "bbg.politics": bbgPoliticsSkill,
  "bbg.businessweek": bbgBusinessweekSkill,
  "bbg.opinions": bbgOpinionsSkill,
  "bbg.feeds": bbgFeedsSkill,
  "bbg.article": bbgArticleSkill,
  "med.search": medSearchSkill,
  "med.tag": medTagSkill,
  "med.feed": medFeedSkill,
  "med.user": medUserSkill,
  "sub.search": subSearchSkill,
  "sub.publication": subPublicationSkill,
  "sub.feed": subFeedSkill,
  // OpenCLI read Wave 2 — BBC/Bloomberg/Medium/Substack additions
  // plus Weibo, 36Kr, Douban, Sina Finance, Jike, Xueqiu,
  // Xiaoyuzhou, Facebook, WeRead, and Ctrip read-only surfaces.
  "wb.hot": wbHotSkill,
  "wb.search": wbSearchSkill,
  "wb.feed": wbFeedSkill,
  "wb.user": wbUserSkill,
  "wb.post": wbPostSkill,
  "wb.comments": wbCommentsSkill,
  "36kr.news": kr36NewsSkill,
  "36kr.hot": kr36HotSkill,
  "36kr.search": kr36SearchSkill,
  "36kr.article": kr36ArticleSkill,
  "db.search": dbSearchSkill,
  "db.movie_hot": dbMovieHotSkill,
  "db.book_hot": dbBookHotSkill,
  "db.top250": dbTop250Skill,
  "db.photos": dbPhotosSkill,
  "sf.news": sfNewsSkill,
  "sf.rolling_news": sfRollingNewsSkill,
  "sf.stock": sfStockSkill,
  "jk.feed": jkFeedSkill,
  "jk.search": jkSearchSkill,
  "xq.search": xqSearchSkill,
  "xq.hot": xqHotSkill,
  "xq.hot_stock": xqHotStockSkill,
  "xq.stock": xqStockSkill,
  "xq.comments": xqCommentsSkill,
  "xq.kline": xqKlineSkill,
  "xq.earnings_date": xqEarningsDateSkill,
  "xyz.podcast": xyzPodcastSkill,
  "xyz.podcast_episodes": xyzPodcastEpisodesSkill,
  "xyz.episode": xyzEpisodeSkill,
  "fb.search": fbSearchSkill,
  "fb.profile": fbProfileSkill,
  "fb.events": fbEventsSkill,
  "wr.search": wrSearchSkill,
  "wr.ranking": wrRankingSkill,
  "wr.book": wrBookSkill,
  "ct.search": ctSearchSkill,
  "ct.hotel_suggest": ctHotelSuggestSkill,
  "ct.hotel_search": ctHotelSearchSkill,
  "ct.flight": ctFlightSkill,
  // Codex Desktop — local provider must have Codex Desktop logged in
  // and Image Gen available. Keep provider concurrency at 1.
  "codex.image_generate": codexImageGenerateSkill,
  // ChatGPT Desktop — macOS Accessibility-backed local ChatGPT app.
  // Keep provider concurrency at 1 because it controls one visible UI.
  "chatgpt.ask": chatgptAskSkill,
  "chatgpt.image_generate": chatgptImageGenerateSkill,
  "chatgpt_web.image_generate": chatgptWebImageGenerateSkill,
  // Gemini API — provider supplies GEMINI_API_KEY / GOOGLE_API_KEY.
  "gemini.image_generate": geminiImageGenerateSkill,
  // Google Labs Flow — provider drives labs.google/fx/tools/flow via bnbot.
  "flow.video_generate": flowVideoGenerateSkill,
  "flow.image_generate": flowImageGenerateSkill,
  // Apify-equivalent scrapers — run in the operator's real logged-in Chrome
  // (residential IP + login state). Skill ids match hub routing:
  // /amazon/product → amazon.product, /web/scrape → web.scrape,
  // /web/read → web.read, /google/maps → gg.maps.
  "amazon.product": amazonProductSkill,
  "amazon.offer": amazonOfferSkill,
  "amazon.search": amazonSearchSkill,
  "gg.maps": ggMapsSkill,
  "web.scrape": webScrapeSkill,
  "web.read": webReadSkill,
  // LinkedIn lead-gen / Sales Navigator — read-only, queries others' public
  // data. /linkedin/{action} → li.{action} via the hub catalog router.
  // salesnav_search needs a Sales Navigator subscription on the provider.
  "li.people_search": liPeopleSearchSkill,
  "li.salesnav_search": liSalesnavSearchSkill,
  "li.profile": liProfileSkill,
  "li.profile_experience": liProfileExperienceSkill,
  "li.profile_projects": liProfileProjectsSkill,
  "li.posts": liPostsSkill,
  "li.job_detail": liJobDetailSkill,
};

export function listSkills(): string[] {
  return Object.keys(SKILL_REGISTRY);
}

export function getSkill(skillId: string): SkillHandler | undefined {
  return SKILL_REGISTRY[skillId];
}
