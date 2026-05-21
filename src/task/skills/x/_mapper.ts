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

// ── bnbot raw shapes (informational; not enforced) ───────────────

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
  media?: Array<{ type: string; url: string; variants?: string[] }>;
  replies?: number;
  retweets?: number;
  text?: string;
  url?: string;
  views?: number;
}

// ── twitter283 → mapper helpers ──────────────────────────────────

/** ISO-ish RFC2822 ("Wed May 20 06:31:00 +0000 2026") is what X
 *  legacy responses use — bnbot already passes this through, so
 *  this mapper is largely a passthrough for the date field. */
function toLegacyDate(date: string | undefined | null): string {
  return date ?? "";
}

/** twitter283's user envelope. */
export function userProfileToTwitter283(p: BnbotUserProfile): unknown {
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
export function tweetToTwitter283Result(t: BnbotTweet): unknown {
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
              video_info:
                m.type === "video" && m.variants
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
export function searchToTwitter283(
  tweets: BnbotTweet[],
  cursor: { next?: string } = {},
): unknown {
  return {
    data: tweets.map((t) => tweetToTwitter283Result(t)),
    meta: {
      result_count: tweets.length,
      next_cursor: cursor.next ?? null,
    },
  };
}

export function userTweetsToTwitter283(
  tweets: BnbotTweet[],
  cursor: { next?: string } = {},
): unknown {
  return searchToTwitter283(tweets, cursor);
}

/** Wrap a single tweet plus an optional reply list as a conversation. */
export function tweetConversationToTwitter283(
  head: BnbotTweet,
  replies: BnbotTweet[] = [],
): unknown {
  return {
    data: {
      tweet: tweetToTwitter283Result(head),
      conversation: replies.map((r) => tweetToTwitter283Result(r)),
    },
  };
}

// ── Tier 3 bnbot raw shapes ──────────────────────────────────────

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

// ── Tier 3 envelope mappers ──────────────────────────────────────

/**
 * Trends envelope. twitter283's /Trends returns a `data.trends`
 * array of `{name, tweet_volume, url, category?}`. We mirror that
 * shape — buyer code typically iterates `.data.trends`.
 */
export function trendsToTwitter283(trends: BnbotTrend[]): unknown {
  return {
    data: {
      trends: trends.map((t) => ({
        name: t.name ?? "",
        tweet_volume:
          typeof t.tweet_volume === "number" ? t.tweet_volume : null,
        url: t.url ?? "",
        ...(t.category ? { category: t.category } : {}),
      })),
    },
    meta: { result_count: trends.length },
  };
}

/**
 * Wrap a single user-list entry in a twitter283-style
 * user_results.result envelope (matches /UserFollowers, /Following,
 * /Favoriters, /Retweeters timeline entries).
 */
function userListEntryToResult(u: BnbotUserListEntry): unknown {
  return {
    __typename: "User",
    rest_id: u.rest_id ?? u.id ?? "",
    legacy: {
      screen_name: u.screen_name ?? "",
      name: u.name ?? "",
      description: u.bio ?? "",
      followers_count: u.followers ?? 0,
      friends_count: u.following ?? 0,
      statuses_count: u.tweets ?? 0,
      verified: !!u.verified,
      profile_image_url_https: u.profile_image_url ?? "",
    },
    url: u.url ?? "",
  };
}

/**
 * Full user-list envelope. Covers /UserFollowers,
 * /UserVerifiedFollowers, /UserFollowing, /TweetFavoriters,
 * /TweetRetweeters. Includes flat `users` for easy iteration and
 * `meta.next_cursor` for pagination. Set `verified_only` to drop
 * non-verified entries (mirrors /UserVerifiedFollowers).
 */
export function userListToTwitter283(
  users: BnbotUserListEntry[],
  next_cursor: string | null = null,
  opts: { verified_only?: boolean } = {},
): unknown {
  const filtered = opts.verified_only
    ? users.filter((u) => !!u.verified)
    : users;
  return {
    data: {
      users: filtered.map((u) => ({
        result: userListEntryToResult(u),
      })),
    },
    meta: {
      result_count: filtered.length,
      next_cursor: next_cursor ?? null,
    },
  };
}

/**
 * /FollowersIds, /FollowingIds — twitter283 returns a flat list of
 * numeric ids. `stringify_ids` controls whether they're emitted as
 * strings (which is the X v1 default for >32-bit safety) or
 * numbers.
 */
export function userIdsToTwitter283(
  users: BnbotUserListEntry[],
  next_cursor: string | null = null,
  opts: { stringify_ids?: boolean } = {},
): unknown {
  const ids = users
    .map((u) => u.rest_id ?? u.id ?? "")
    .filter((s) => s.length > 0);
  return {
    ids: opts.stringify_ids ? ids : ids.map((s) => Number(s)),
    next_cursor: next_cursor ?? null,
    next_cursor_str: next_cursor ?? "0",
    previous_cursor: 0,
    previous_cursor_str: "0",
  };
}

/**
 * Article envelope. twitter283's /TweetArticle returns the article
 * payload nested under `data.tweetResult.result.article`. We pass
 * the bnbot fields straight through (already pre-flattened) plus a
 * thin wrapper for buyer parity.
 */
export function tweetArticleToTwitter283(a: BnbotArticle): unknown {
  return {
    data: {
      article: {
        id: a.id ?? "",
        title: a.title ?? "",
        preview: a.preview ?? "",
        content: a.content ?? "",
        author: a.author ?? "",
        author_name: a.author_name ?? "",
        created_at: a.created_at ?? "",
        cover_image_url: a.cover_image_url ?? null,
        url: a.url ?? "",
      },
    },
  };
}
