import type { SkillHandler } from "../../types.js";
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
export declare const xUserByScreenNameSkill: SkillHandler;
