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
async function runBnbot(args) {
    try {
        const { stdout } = await exec("bnbot", args, {
            maxBuffer: MAX_BUFFER,
            timeout: TIMEOUT_MS,
        });
        if (!stdout.trim())
            throw new Error("bnbot returned empty stdout");
        try {
            return JSON.parse(stdout);
        }
        catch {
            throw new Error(`bnbot returned non-JSON (head=${stdout.slice(0, 200).replace(/\n/g, "\\n")})`);
        }
    }
    catch (err) {
        const e = err;
        if (e.stderr && e.stderr.trim()) {
            throw new Error(`bnbot tiktok failed: ${e.stderr.trim()}`);
        }
        throw err;
    }
}
export async function bnbotTTSearchVideo(query, limit) {
    const args = ["tiktok", "search", query];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
export async function bnbotTTSearchAccount(query, limit) {
    const args = ["tiktok", "search-account", query];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
export async function bnbotTTUserInfo(uniqueId) {
    return runBnbot(["tiktok", "profile", uniqueId]);
}
export async function bnbotTTUserPosts(a) {
    const args = ["tiktok", "user-posts", a.user];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTUserFollowers(a) {
    const args = ["tiktok", "user-followers", a.user];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTPostDetail(video) {
    return runBnbot(["tiktok", "post-detail", video]);
}
export async function bnbotTTPostComments(a) {
    const args = ["tiktok", "post-comments", a.video];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTTrending(limit) {
    const args = ["tiktok", "explore"];
    if (limit)
        args.push("--limit", String(limit));
    return runBnbot(args);
}
// ── Wave 2/3/4 wrappers ──────────────────────────────────────
// Challenge / Music
export async function bnbotTTChallengeInfo(challengeName) {
    return runBnbot(["tiktok", "challenge-info", challengeName]);
}
export async function bnbotTTChallengePosts(a) {
    const args = ["tiktok", "challenge-posts", a.challengeId];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTMusicInfo(musicId) {
    return runBnbot(["tiktok", "music-info", musicId]);
}
export async function bnbotTTMusicPosts(a) {
    const args = ["tiktok", "music-posts", a.musicId];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTMusicUnlimitedSounds(a = {}) {
    const args = ["tiktok", "music-unlimited"];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.pageSize)
        args.push("--page-size", String(a.pageSize));
    if (a.orderBy)
        args.push("--order-by", a.orderBy);
    return runBnbot(args);
}
// User extras
export async function bnbotTTUserInfoRegion(uniqueId) {
    return runBnbot(["tiktok", "user-info-region", uniqueId]);
}
export async function bnbotTTUserInfoById(userId) {
    return runBnbot(["tiktok", "user-info-by-id", userId]);
}
export async function bnbotTTUserFollowings(a) {
    const args = ["tiktok", "user-followings", a.user];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.max_time)
        args.push("--max-time", a.max_time);
    return runBnbot(args);
}
export async function bnbotTTUserLikedPosts(a) {
    const args = ["tiktok", "user-liked-posts", a.user];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTUserPlaylist(a) {
    const args = ["tiktok", "user-playlist", a.user];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTUserRepost(a) {
    const args = ["tiktok", "user-repost", a.user];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTUserStory(a) {
    const args = ["tiktok", "user-story", a.userId];
    if (a.maxCursor)
        args.push("--max-cursor", a.maxCursor);
    return runBnbot(args);
}
export async function bnbotTTSearchGeneral(a) {
    const args = ["tiktok", "search-general", a.query];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTSearchLive(a) {
    const args = ["tiktok", "search-live", a.query];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTSearchSuggestions(keyword) {
    return runBnbot(["tiktok", "search-suggestions", keyword]);
}
export async function bnbotTTPostRelated(a) {
    const args = ["tiktok", "post-related", a.video];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTPostExplore(a = {}) {
    const args = ["tiktok", "post-explore"];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.categoryType)
        args.push("--category-type", a.categoryType);
    return runBnbot(args);
}
export async function bnbotTTPostDiscover(a) {
    const args = ["tiktok", "post-discover", a.keyword];
    if (a.page)
        args.push("--page", String(a.page));
    return runBnbot(args);
}
// ── Wave 5 wrappers — Creative Center (ads.tiktok.com) ───────
//
// All defer to `bnbot tiktok <subcommand>`, which in turn drives the
// chrome extension's tiktok-ads scraper. Endpoints are best-effort
// guesses — the wrappers' job is just to flow args through; if the
// underlying scraper returns `{ error: 'tiktok-ads-...' }` we surface
// it verbatim.
export async function bnbotTTAdsDetail(adsId) {
    return runBnbot(["tiktok", "ads-detail", adsId]);
}
export async function bnbotTTAdsTop(a = {}) {
    const args = ["tiktok", "ads-top"];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.period)
        args.push("--period", String(a.period));
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.country)
        args.push("--country", a.country);
    if (a.order_by)
        args.push("--order-by", a.order_by);
    return runBnbot(args);
}
export async function bnbotTTTrendingCreator(a = {}) {
    const args = ["tiktok", "trending-creator"];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.sort_by)
        args.push("--sort-by", a.sort_by);
    if (a.country)
        args.push("--country", a.country);
    return runBnbot(args);
}
export async function bnbotTTTrendingVideo(a = {}) {
    const args = ["tiktok", "trending-video"];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.period)
        args.push("--period", String(a.period));
    if (a.order_by)
        args.push("--order-by", a.order_by);
    if (a.country)
        args.push("--country", a.country);
    return runBnbot(args);
}
export async function bnbotTTTrendingHashtag(a = {}) {
    const args = ["tiktok", "trending-hashtag"];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.period)
        args.push("--period", String(a.period));
    if (a.country)
        args.push("--country", a.country);
    if (a.sort_by)
        args.push("--sort-by", a.sort_by);
    return runBnbot(args);
}
export async function bnbotTTTrendingSong(a = {}) {
    const args = ["tiktok", "trending-song"];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.period)
        args.push("--period", String(a.period));
    if (a.rank_type)
        args.push("--rank-type", a.rank_type);
    if (a.country)
        args.push("--country", a.country);
    return runBnbot(args);
}
export async function bnbotTTTrendingKeyword(a = {}) {
    const args = ["tiktok", "trending-keyword"];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.period)
        args.push("--period", String(a.period));
    if (a.country)
        args.push("--country", a.country);
    return runBnbot(args);
}
export async function bnbotTTTrendingKeywordPosts(a) {
    const args = ["tiktok", "trending-keyword-posts", a.keyword];
    if (a.country)
        args.push("--country", a.country);
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.period)
        args.push("--period", String(a.period));
    return runBnbot(args);
}
export async function bnbotTTTrendingKeywordSentence(a) {
    const args = ["tiktok", "trending-keyword-sentence", a.keyword];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.period)
        args.push("--period", String(a.period));
    if (a.country)
        args.push("--country", a.country);
    if (a.order_type)
        args.push("--order-type", a.order_type);
    return runBnbot(args);
}
export async function bnbotTTCommercialMusic(a = {}) {
    const args = ["tiktok", "commercial-music"];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.region)
        args.push("--region", a.region);
    if (a.scenarios != null)
        args.push("--scenarios", String(a.scenarios));
    if (a.duration != null)
        args.push("--duration", String(a.duration));
    if (a.placements)
        args.push("--placements", a.placements);
    if (a.themes)
        args.push("--themes", a.themes);
    if (a.genres)
        args.push("--genres", a.genres);
    if (a.moods)
        args.push("--moods", a.moods);
    return runBnbot(args);
}
export async function bnbotTTCommercialPlaylists(a = {}) {
    const args = ["tiktok", "commercial-playlists"];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.region)
        args.push("--region", a.region);
    return runBnbot(args);
}
export async function bnbotTTCommercialPlaylistDetail(a) {
    const args = ["tiktok", "commercial-playlist-detail", a.playlist_id];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.region)
        args.push("--region", a.region);
    return runBnbot(args);
}
export async function bnbotTTTopProducts(a = {}) {
    const args = ["tiktok", "top-products"];
    if (a.page)
        args.push("--page", String(a.page));
    if (a.last)
        args.push("--last", String(a.last));
    if (a.order_by)
        args.push("--order-by", a.order_by);
    if (a.order_type)
        args.push("--order-type", a.order_type);
    return runBnbot(args);
}
export async function bnbotTTTopProductDetail(productId) {
    return runBnbot(["tiktok", "top-product-detail", productId]);
}
export async function bnbotTTTopProductMetrics(productId) {
    return runBnbot(["tiktok", "top-product-metrics", productId]);
}
// ── Wave 6 wrappers — long-tail (place / effect / collection / comment-replies) ──
export async function bnbotTTPlaceInfo(placeId) {
    return runBnbot(["tiktok", "place-info", placeId]);
}
export async function bnbotTTPlacePosts(a) {
    const args = ["tiktok", "place-posts", a.placeId];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTEffectInfo(effectId) {
    return runBnbot(["tiktok", "effect-info", effectId]);
}
export async function bnbotTTEffectPosts(a) {
    const args = ["tiktok", "effect-posts", a.effectId];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
export async function bnbotTTCollectionInfo(collectionId) {
    return runBnbot(["tiktok", "collection-info", collectionId]);
}
export async function bnbotTTCollectionPosts(a) {
    const args = ["tiktok", "collection-posts", a.collectionId];
    if (a.limit)
        args.push("--limit", String(a.limit));
    return runBnbot(args);
}
export async function bnbotTTPostCommentReplies(a) {
    const args = ["tiktok", "post-comment-replies", a.video, a.comment_id];
    if (a.limit)
        args.push("--limit", String(a.limit));
    if (a.cursor)
        args.push("--cursor", a.cursor);
    return runBnbot(args);
}
