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
export const SKILL_REGISTRY = {
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
};
export function listSkills() {
    return Object.keys(SKILL_REGISTRY);
}
export function getSkill(skillId) {
    return SKILL_REGISTRY[skillId];
}
