/**
 * Schema mapping: bnbot CLI raw output → twitter283-compatible shape.
 *
 * bnbot CLI outputs a flat camelCase object per scrape command.
 * twitter283 returns the underlying X GraphQL response — deeply
 * nested under data.user_results.result or data.tweetResult.result,
 * with a `legacy` envelope holding the actual fields. Buyers expect
 * the latter, so we re-nest the bnbot output to match.
 *
 * NOT a perfect mapping — bnbot doesn't always expose every X field
 * (e.g. rest_id is missing in user-profile today; created_at on a
 * profile is often empty). Missing fields show up as empty strings or
 * 0 rather than undefined, so buyer code that probes truthiness still
 * works the way it would against the real twitter283 endpoint.
 */
export interface BnbotUserProfile {
    bio?: string;
    created_at?: string;
    followers?: number;
    following?: number;
    likes?: number;
    location?: string;
    name?: string;
    screen_name?: string;
    tweets?: number;
    url?: string;
    verified?: boolean;
    /** Present on some builds — kept here for forward compat. */
    rest_id?: string;
    id?: string;
}
export interface BnbotTweet {
    author?: string;
    authorCreatedAt?: string | null;
    authorFollowers?: number;
    createdAt?: string;
    id?: string;
    isBlue?: boolean;
    likes?: number;
    media?: Array<{
        type: string;
        url: string;
        variants?: string[];
    }>;
    replies?: number;
    retweets?: number;
    text?: string;
    url?: string;
    views?: number;
}
/** twitter283's user envelope. */
export declare function userProfileToTwitter283(p: BnbotUserProfile): unknown;
/** Single tweet wrapped in twitter283-style result envelope. */
export declare function tweetToTwitter283Result(t: BnbotTweet): unknown;
/** Search response envelope. twitter283 returns a flat
 *  `data.search_by_raw_query.search_timeline.timeline.instructions`
 *  beast — we flatten that for callers since most consumers we've
 *  seen (incl. bnbot-api) just iterate `data` looking for the
 *  tweet results. */
export declare function searchToTwitter283(tweets: BnbotTweet[], cursor?: {
    next?: string;
}): unknown;
export declare function userTweetsToTwitter283(tweets: BnbotTweet[], cursor?: {
    next?: string;
}): unknown;
/** Wrap a single tweet plus an optional reply list as a conversation. */
export declare function tweetConversationToTwitter283(head: BnbotTweet, replies?: BnbotTweet[]): unknown;
export interface BnbotTrend {
    name?: string;
    tweet_volume?: number | null;
    url?: string;
    category?: string;
}
export interface BnbotUserListEntry {
    rest_id?: string;
    id?: string;
    screen_name?: string;
    name?: string;
    bio?: string;
    followers?: number;
    following?: number;
    tweets?: number;
    verified?: boolean;
    profile_image_url?: string;
    url?: string;
}
export interface BnbotArticle {
    id?: string;
    title?: string;
    preview?: string;
    content?: string;
    author?: string;
    author_name?: string;
    created_at?: string;
    cover_image_url?: string | null;
    url?: string;
}
/**
 * Trends envelope. twitter283's /Trends returns a `data.trends`
 * array of `{name, tweet_volume, url, category?}`. We mirror that
 * shape — buyer code typically iterates `.data.trends`.
 */
export declare function trendsToTwitter283(trends: BnbotTrend[]): unknown;
/**
 * Full user-list envelope. Covers /UserFollowers,
 * /UserVerifiedFollowers, /UserFollowing, /TweetFavoriters,
 * /TweetRetweeters. Includes flat `users` for easy iteration and
 * `meta.next_cursor` for pagination. Set `verified_only` to drop
 * non-verified entries (mirrors /UserVerifiedFollowers).
 */
export declare function userListToTwitter283(users: BnbotUserListEntry[], next_cursor?: string | null, opts?: {
    verified_only?: boolean;
}): unknown;
/**
 * /FollowersIds, /FollowingIds — twitter283 returns a flat list of
 * numeric ids. `stringify_ids` controls whether they're emitted as
 * strings (which is the X v1 default for >32-bit safety) or
 * numbers.
 */
export declare function userIdsToTwitter283(users: BnbotUserListEntry[], next_cursor?: string | null, opts?: {
    stringify_ids?: boolean;
}): unknown;
/**
 * Article envelope. twitter283's /TweetArticle returns the article
 * payload nested under `data.tweetResult.result.article`. We pass
 * the bnbot fields straight through (already pre-flattened) plus a
 * thin wrapper for buyer parity.
 */
export declare function tweetArticleToTwitter283(a: BnbotArticle): unknown;
