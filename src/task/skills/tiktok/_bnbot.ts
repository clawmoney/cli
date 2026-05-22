/**
 * Thin wrappers around `bnbot tiktok <command>` CLI calls.
 *
 * Each function shells out, captures stdout JSON, and either returns
 * the parsed object or throws on failure. bnbot CLI handles the
 * actual scraping inside the browser extension; we just glue here.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 110_000;

async function runBnbot(args: string[]): Promise<unknown> {
  try {
    const { stdout } = await exec("bnbot", args, {
      maxBuffer: MAX_BUFFER,
      timeout: TIMEOUT_MS,
    });
    if (!stdout.trim()) throw new Error("bnbot returned empty stdout");
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(
        `bnbot returned non-JSON (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`,
      );
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
    };
    if (e.stderr && e.stderr.trim()) {
      throw new Error(`bnbot tiktok failed: ${e.stderr.trim()}`);
    }
    throw err;
  }
}

export async function bnbotTTSearchVideo(
  query: string,
  limit?: number,
): Promise<unknown> {
  const args = ["tiktok", "search", query];
  if (limit) args.push("--limit", String(limit));
  return runBnbot(args);
}

export async function bnbotTTSearchAccount(
  query: string,
  limit?: number,
): Promise<unknown> {
  const args = ["tiktok", "search-account", query];
  if (limit) args.push("--limit", String(limit));
  return runBnbot(args);
}

export async function bnbotTTUserInfo(uniqueId: string): Promise<unknown> {
  return runBnbot(["tiktok", "profile", uniqueId]);
}

export interface UserPostsArgs {
  user: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTUserPosts(a: UserPostsArgs): Promise<unknown> {
  const args = ["tiktok", "user-posts", a.user];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export interface UserFollowersArgs {
  user: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTUserFollowers(
  a: UserFollowersArgs,
): Promise<unknown> {
  const args = ["tiktok", "user-followers", a.user];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotTTPostDetail(video: string): Promise<unknown> {
  return runBnbot(["tiktok", "post-detail", video]);
}

export interface PostCommentsArgs {
  video: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTPostComments(
  a: PostCommentsArgs,
): Promise<unknown> {
  const args = ["tiktok", "post-comments", a.video];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotTTTrending(limit?: number): Promise<unknown> {
  const args = ["tiktok", "explore"];
  if (limit) args.push("--limit", String(limit));
  return runBnbot(args);
}

// ── Wave 2/3/4 wrappers ──────────────────────────────────────

// Challenge / Music
export async function bnbotTTChallengeInfo(
  challengeName: string,
): Promise<unknown> {
  return runBnbot(["tiktok", "challenge-info", challengeName]);
}

export interface ChallengePostsArgs {
  challengeId: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTChallengePosts(
  a: ChallengePostsArgs,
): Promise<unknown> {
  const args = ["tiktok", "challenge-posts", a.challengeId];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotTTMusicInfo(musicId: string): Promise<unknown> {
  return runBnbot(["tiktok", "music-info", musicId]);
}

export interface MusicPostsArgs {
  musicId: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTMusicPosts(
  a: MusicPostsArgs,
): Promise<unknown> {
  const args = ["tiktok", "music-posts", a.musicId];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export interface MusicUnlimitedArgs {
  page?: number;
  pageSize?: number;
  orderBy?: string;
}
export async function bnbotTTMusicUnlimitedSounds(
  a: MusicUnlimitedArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "music-unlimited"];
  if (a.page) args.push("--page", String(a.page));
  if (a.pageSize) args.push("--page-size", String(a.pageSize));
  if (a.orderBy) args.push("--order-by", a.orderBy);
  return runBnbot(args);
}

// User extras
export async function bnbotTTUserInfoRegion(
  uniqueId: string,
): Promise<unknown> {
  return runBnbot(["tiktok", "user-info-region", uniqueId]);
}

export async function bnbotTTUserInfoById(userId: string): Promise<unknown> {
  return runBnbot(["tiktok", "user-info-by-id", userId]);
}

export interface UserFollowingsArgs {
  user: string;
  limit?: number;
  max_time?: string;
}
export async function bnbotTTUserFollowings(
  a: UserFollowingsArgs,
): Promise<unknown> {
  const args = ["tiktok", "user-followings", a.user];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.max_time) args.push("--max-time", a.max_time);
  return runBnbot(args);
}

export interface UserCursorArgs {
  user: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTUserLikedPosts(
  a: UserCursorArgs,
): Promise<unknown> {
  const args = ["tiktok", "user-liked-posts", a.user];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotTTUserPlaylist(
  a: UserCursorArgs,
): Promise<unknown> {
  const args = ["tiktok", "user-playlist", a.user];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotTTUserRepost(
  a: UserCursorArgs,
): Promise<unknown> {
  const args = ["tiktok", "user-repost", a.user];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export interface UserStoryArgs {
  userId: string;
  maxCursor?: string;
}
export async function bnbotTTUserStory(a: UserStoryArgs): Promise<unknown> {
  const args = ["tiktok", "user-story", a.userId];
  if (a.maxCursor) args.push("--max-cursor", a.maxCursor);
  return runBnbot(args);
}

// Search / Discovery
export interface QueryCursorArgs {
  query: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTSearchGeneral(
  a: QueryCursorArgs,
): Promise<unknown> {
  const args = ["tiktok", "search-general", a.query];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotTTSearchLive(
  a: QueryCursorArgs,
): Promise<unknown> {
  const args = ["tiktok", "search-live", a.query];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotTTSearchSuggestions(
  keyword: string,
): Promise<unknown> {
  return runBnbot(["tiktok", "search-suggestions", keyword]);
}

export interface PostRelatedArgs {
  video: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTPostRelated(
  a: PostRelatedArgs,
): Promise<unknown> {
  const args = ["tiktok", "post-related", a.video];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export interface PostExploreArgs {
  limit?: number;
  categoryType?: string;
}
export async function bnbotTTPostExplore(
  a: PostExploreArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "post-explore"];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.categoryType) args.push("--category-type", a.categoryType);
  return runBnbot(args);
}

export interface PostDiscoverArgs {
  keyword: string;
  page?: number;
}
export async function bnbotTTPostDiscover(
  a: PostDiscoverArgs,
): Promise<unknown> {
  const args = ["tiktok", "post-discover", a.keyword];
  if (a.page) args.push("--page", String(a.page));
  return runBnbot(args);
}

// ── Wave 5 wrappers — Creative Center (ads.tiktok.com) ───────
//
// All defer to `bnbot tiktok <subcommand>`, which in turn drives the
// chrome extension's tiktok-ads scraper. Endpoints are best-effort
// guesses — the wrappers' job is just to flow args through; if the
// underlying scraper returns `{ error: 'tiktok-ads-...' }` we surface
// it verbatim.

export async function bnbotTTAdsDetail(adsId: string): Promise<unknown> {
  return runBnbot(["tiktok", "ads-detail", adsId]);
}

export interface AdsTopArgs {
  page?: number;
  period?: number;
  limit?: number;
  country?: string;
  order_by?: string;
}
export async function bnbotTTAdsTop(a: AdsTopArgs = {}): Promise<unknown> {
  const args = ["tiktok", "ads-top"];
  if (a.page) args.push("--page", String(a.page));
  if (a.period) args.push("--period", String(a.period));
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.country) args.push("--country", a.country);
  if (a.order_by) args.push("--order-by", a.order_by);
  return runBnbot(args);
}

export interface TrendingCreatorArgs {
  page?: number;
  limit?: number;
  sort_by?: string;
  country?: string;
}
export async function bnbotTTTrendingCreator(
  a: TrendingCreatorArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "trending-creator"];
  if (a.page) args.push("--page", String(a.page));
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.sort_by) args.push("--sort-by", a.sort_by);
  if (a.country) args.push("--country", a.country);
  return runBnbot(args);
}

export interface TrendingVideoArgs {
  page?: number;
  limit?: number;
  period?: number;
  order_by?: string;
  country?: string;
}
export async function bnbotTTTrendingVideo(
  a: TrendingVideoArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "trending-video"];
  if (a.page) args.push("--page", String(a.page));
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.period) args.push("--period", String(a.period));
  if (a.order_by) args.push("--order-by", a.order_by);
  if (a.country) args.push("--country", a.country);
  return runBnbot(args);
}

export interface TrendingHashtagArgs {
  page?: number;
  limit?: number;
  period?: number;
  country?: string;
  sort_by?: string;
}
export async function bnbotTTTrendingHashtag(
  a: TrendingHashtagArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "trending-hashtag"];
  if (a.page) args.push("--page", String(a.page));
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.period) args.push("--period", String(a.period));
  if (a.country) args.push("--country", a.country);
  if (a.sort_by) args.push("--sort-by", a.sort_by);
  return runBnbot(args);
}

export interface TrendingSongArgs {
  page?: number;
  limit?: number;
  period?: number;
  rank_type?: string;
  country?: string;
}
export async function bnbotTTTrendingSong(
  a: TrendingSongArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "trending-song"];
  if (a.page) args.push("--page", String(a.page));
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.period) args.push("--period", String(a.period));
  if (a.rank_type) args.push("--rank-type", a.rank_type);
  if (a.country) args.push("--country", a.country);
  return runBnbot(args);
}

export interface TrendingKeywordArgs {
  page?: number;
  limit?: number;
  period?: number;
  country?: string;
}
export async function bnbotTTTrendingKeyword(
  a: TrendingKeywordArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "trending-keyword"];
  if (a.page) args.push("--page", String(a.page));
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.period) args.push("--period", String(a.period));
  if (a.country) args.push("--country", a.country);
  return runBnbot(args);
}

export interface TrendingKeywordPostsArgs {
  keyword: string;
  country?: string;
  limit?: number;
  period?: number;
}
export async function bnbotTTTrendingKeywordPosts(
  a: TrendingKeywordPostsArgs,
): Promise<unknown> {
  const args = ["tiktok", "trending-keyword-posts", a.keyword];
  if (a.country) args.push("--country", a.country);
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.period) args.push("--period", String(a.period));
  return runBnbot(args);
}

export interface TrendingKeywordSentenceArgs {
  keyword: string;
  page?: number;
  limit?: number;
  period?: number;
  country?: string;
  order_type?: string;
}
export async function bnbotTTTrendingKeywordSentence(
  a: TrendingKeywordSentenceArgs,
): Promise<unknown> {
  const args = ["tiktok", "trending-keyword-sentence", a.keyword];
  if (a.page) args.push("--page", String(a.page));
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.period) args.push("--period", String(a.period));
  if (a.country) args.push("--country", a.country);
  if (a.order_type) args.push("--order-type", a.order_type);
  return runBnbot(args);
}

export interface CommercialMusicArgs {
  page?: number;
  limit?: number;
  region?: string;
  scenarios?: number;
  duration?: number;
  placements?: string;  // comma-separated string already; CLI splits
  themes?: string;
  genres?: string;
  moods?: string;
}
export async function bnbotTTCommercialMusic(
  a: CommercialMusicArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "commercial-music"];
  if (a.page) args.push("--page", String(a.page));
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.region) args.push("--region", a.region);
  if (a.scenarios != null) args.push("--scenarios", String(a.scenarios));
  if (a.duration != null) args.push("--duration", String(a.duration));
  if (a.placements) args.push("--placements", a.placements);
  if (a.themes) args.push("--themes", a.themes);
  if (a.genres) args.push("--genres", a.genres);
  if (a.moods) args.push("--moods", a.moods);
  return runBnbot(args);
}

export interface CommercialPlaylistsArgs {
  limit?: number;
  region?: string;
}
export async function bnbotTTCommercialPlaylists(
  a: CommercialPlaylistsArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "commercial-playlists"];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.region) args.push("--region", a.region);
  return runBnbot(args);
}

export interface CommercialPlaylistDetailArgs {
  playlist_id: string;
  page?: number;
  limit?: number;
  region?: string;
}
export async function bnbotTTCommercialPlaylistDetail(
  a: CommercialPlaylistDetailArgs,
): Promise<unknown> {
  const args = ["tiktok", "commercial-playlist-detail", a.playlist_id];
  if (a.page) args.push("--page", String(a.page));
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.region) args.push("--region", a.region);
  return runBnbot(args);
}

export interface TopProductsArgs {
  page?: number;
  last?: number;
  order_by?: string;
  order_type?: string;
}
export async function bnbotTTTopProducts(
  a: TopProductsArgs = {},
): Promise<unknown> {
  const args = ["tiktok", "top-products"];
  if (a.page) args.push("--page", String(a.page));
  if (a.last) args.push("--last", String(a.last));
  if (a.order_by) args.push("--order-by", a.order_by);
  if (a.order_type) args.push("--order-type", a.order_type);
  return runBnbot(args);
}

export async function bnbotTTTopProductDetail(productId: string): Promise<unknown> {
  return runBnbot(["tiktok", "top-product-detail", productId]);
}

export async function bnbotTTTopProductMetrics(productId: string): Promise<unknown> {
  return runBnbot(["tiktok", "top-product-metrics", productId]);
}

// ── Wave 6 wrappers — long-tail (place / effect / collection / comment-replies) ──

export async function bnbotTTPlaceInfo(placeId: string): Promise<unknown> {
  return runBnbot(["tiktok", "place-info", placeId]);
}

export interface PlacePostsArgs {
  placeId: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTPlacePosts(a: PlacePostsArgs): Promise<unknown> {
  const args = ["tiktok", "place-posts", a.placeId];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotTTEffectInfo(effectId: string): Promise<unknown> {
  return runBnbot(["tiktok", "effect-info", effectId]);
}

export interface EffectPostsArgs {
  effectId: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTEffectPosts(a: EffectPostsArgs): Promise<unknown> {
  const args = ["tiktok", "effect-posts", a.effectId];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}

export async function bnbotTTCollectionInfo(collectionId: string): Promise<unknown> {
  return runBnbot(["tiktok", "collection-info", collectionId]);
}

export interface CollectionPostsArgs {
  collectionId: string;
  limit?: number;
  // No cursor — tiktok-api23's /api/collection/posts sample paginates by
  // count only. Endpoint may or may not support a cursor token; not in
  // the documented schema, so we don't pass one.
}
export async function bnbotTTCollectionPosts(
  a: CollectionPostsArgs,
): Promise<unknown> {
  const args = ["tiktok", "collection-posts", a.collectionId];
  if (a.limit) args.push("--limit", String(a.limit));
  return runBnbot(args);
}

export interface PostCommentRepliesArgs {
  video: string;
  comment_id: string;
  limit?: number;
  cursor?: string;
}
export async function bnbotTTPostCommentReplies(
  a: PostCommentRepliesArgs,
): Promise<unknown> {
  const args = ["tiktok", "post-comment-replies", a.video, a.comment_id];
  if (a.limit) args.push("--limit", String(a.limit));
  if (a.cursor) args.push("--cursor", a.cursor);
  return runBnbot(args);
}
