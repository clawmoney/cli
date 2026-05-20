/**
 * Reusable stub for X skills that require bnbot CLI extensions not
 * yet released. The hub-side route is wired (so the path responds
 * with a clean 502 instead of 404), and once bnbot CLI grows the
 * matching `x scrape <thing>` command, swap this stub for a real
 * implementation in the matching file.
 *
 * Phase 5 roadmap items waiting on bnbot CLI:
 *   - x scrape trends                  → x.trends
 *   - x scrape user-followers          → x.user_followers
 *   - x scrape user-following          → x.user_following
 *   - x scrape tweet-likers            → x.tweet_favoriters
 *   - x scrape tweet-retweeters        → x.tweet_retweeters
 *   - x scrape tweet-article           → x.tweet_article
 */
export function makeUnimplementedSkill(bnbotCommand, twitter283Endpoint) {
    return {
        price_usd: 0,
        async run(_input, _ctx) {
            throw new Error(`not yet implemented: this skill requires the bnbot CLI command "${bnbotCommand}", ` +
                `which is not in the current release. spareapi endpoint: ${twitter283Endpoint}.`);
        },
    };
}
