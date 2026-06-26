import type { SkillHandler } from "../../types.js";
import { bnbotXUserProfile } from "./_bnbot.js";
import { userProfileToTwitter283, type BnbotUserProfile } from "./_mapper.js";

/**
 * `x.user_by_screen_name` — twitter283 /UserResultByScreenName and
 * /UsernameToUserId both call this. Returns the full profile in
 * twitter283 nested envelope; hub-side extracts `rest_id` for the
 * lightweight /UsernameToUserId path.
 *
 * Caveat: today bnbot's user-profile output is missing `rest_id` /
 * `name` / `created_at`. The mapper passes empties through rather
 * than fabricating values — buyer should treat empty string as
 * "field not available".
 */
export const xUserByScreenNameSkill: SkillHandler = {
  price_usd: 0.0001,
  async run(input, ctx) {
    const { username } = (input ?? {}) as { username?: string };
    if (!username) throw new Error("missing 'username'");

    ctx.report({ stage: "launching", percent: 10, note: `profile @${username}` });
    const raw = (await bnbotXUserProfile(username)) as BnbotUserProfile;
    ctx.report({ stage: "parsing", percent: 90 });
    return userProfileToTwitter283(raw);
  },
};
