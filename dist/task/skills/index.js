import { echoSkill } from "./echo.js";
import { xSearchSkill as xSearchLegacy } from "./x-search.js";
import { xSearchSkill } from "./x/search.js";
import { xUserByScreenNameSkill } from "./x/user-by-screen-name.js";
import { xUserTweetsSkill } from "./x/user-tweets.js";
import { xTweetSkill } from "./x/tweet.js";
/**
 * In-process skill registry. Each entry maps a skill_id (the same
 * string the provider advertises via `?skills=…` on WS connect, and
 * the same one buyers hit) to a handler. The twitter283
 * compatibility surface on spareai-hub dispatches to these by name.
 *
 * The `x.search` here is the twitter283-compatible mapper (nested
 * envelope). The legacy flat-camelCase version stays exposed as
 * `x.search.legacy` for older buyers / local debug scripts.
 */
export const SKILL_REGISTRY = {
    echo: echoSkill,
    // twitter283-compat skills
    "x.search": xSearchSkill,
    "x.user_by_screen_name": xUserByScreenNameSkill,
    "x.user_tweets": xUserTweetsSkill,
    "x.tweet": xTweetSkill,
    // Legacy flat-shape version, kept for back-compat with old buyers.
    "x.search.legacy": xSearchLegacy,
};
export function listSkills() {
    return Object.keys(SKILL_REGISTRY);
}
export function getSkill(skillId) {
    return SKILL_REGISTRY[skillId];
}
