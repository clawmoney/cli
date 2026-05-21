import type { SkillHandler } from "../../types.js";
/**
 * `x.user_following` — backs /UserFollowing and /FollowingIds. Hub
 * resolves user_id → username first. `ids_only` collapses output to a
 * twitter-v1-style numeric id list.
 */
export declare const xUserFollowingSkill: SkillHandler;
