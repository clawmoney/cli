import type { SkillHandler } from "../../types.js";
/**
 * `x.user_followers` — backs /UserFollowers, /UserVerifiedFollowers,
 * /FollowersIds. Hub-side resolves user_id → username before
 * invoking. `verified_only` filters to blue-verified users only;
 * `ids_only` collapses output to a flat id-list envelope (with
 * optional `stringify_ids`).
 */
export declare const xUserFollowersSkill: SkillHandler;
