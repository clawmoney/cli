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
