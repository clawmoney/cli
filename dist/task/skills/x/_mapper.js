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
// ── twitter283 → mapper helpers ──────────────────────────────────
/** ISO-ish RFC2822 ("Wed May 20 06:31:00 +0000 2026") is what X
 *  legacy responses use — bnbot already passes this through, so
 *  this mapper is largely a passthrough for the date field. */
function toLegacyDate(date) {
    return date ?? "";
}
/** twitter283's user envelope. */
export function userProfileToTwitter283(p) {
    return {
        data: {
            user: {
                result: {
                    __typename: "User",
                    rest_id: p.rest_id ?? p.id ?? "",
                    legacy: {
                        screen_name: p.screen_name ?? "",
                        name: p.name ?? "",
                        description: p.bio ?? "",
                        location: p.location ?? "",
                        url: p.url ?? "",
                        verified: !!p.verified,
                        followers_count: p.followers ?? 0,
                        friends_count: p.following ?? 0,
                        favourites_count: p.likes ?? 0,
                        statuses_count: p.tweets ?? 0,
                        created_at: toLegacyDate(p.created_at),
                    },
                },
            },
        },
    };
}
/** Single tweet wrapped in twitter283-style result envelope. */
export function tweetToTwitter283Result(t) {
    return {
        tweetResult: {
            result: {
                __typename: "Tweet",
                rest_id: t.id ?? "",
                legacy: {
                    created_at: toLegacyDate(t.createdAt),
                    full_text: t.text ?? "",
                    favorite_count: t.likes ?? 0,
                    reply_count: t.replies ?? 0,
                    retweet_count: t.retweets ?? 0,
                    quote_count: 0,
                    id_str: t.id ?? "",
                    entities: {
                        media: (t.media ?? []).map((m, i) => ({
                            type: m.type,
                            media_url_https: m.url,
                            media_key: `${i}_${t.id ?? ""}`,
                            video_info: m.type === "video" && m.variants
                                ? {
                                    variants: m.variants.map((v) => ({
                                        content_type: "video/mp4",
                                        url: v,
                                    })),
                                }
                                : undefined,
                        })),
                    },
                },
                views: {
                    count: String(t.views ?? 0),
                    state: "EnabledWithCount",
                },
                core: {
                    user_results: {
                        result: {
                            __typename: "User",
                            legacy: {
                                screen_name: t.author ?? "",
                                name: t.author ?? "",
                                followers_count: t.authorFollowers ?? 0,
                                verified: !!t.isBlue,
                                created_at: t.authorCreatedAt ?? "",
                            },
                        },
                    },
                },
                url: t.url ?? "",
            },
        },
    };
}
/** Search response envelope. twitter283 returns a flat
 *  `data.search_by_raw_query.search_timeline.timeline.instructions`
 *  beast — we flatten that for callers since most consumers we've
 *  seen (incl. bnbot-api) just iterate `data` looking for the
 *  tweet results. */
export function searchToTwitter283(tweets, cursor = {}) {
    return {
        data: tweets.map((t) => tweetToTwitter283Result(t)),
        meta: {
            result_count: tweets.length,
            next_cursor: cursor.next ?? null,
        },
    };
}
export function userTweetsToTwitter283(tweets, cursor = {}) {
    return searchToTwitter283(tweets, cursor);
}
/** Wrap a single tweet plus an optional reply list as a conversation. */
export function tweetConversationToTwitter283(head, replies = []) {
    return {
        data: {
            tweet: tweetToTwitter283Result(head),
            conversation: replies.map((r) => tweetToTwitter283Result(r)),
        },
    };
}
