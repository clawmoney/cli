import type { SkillHandler } from "../../types.js";
/**
 * `x.user_tweets` — backs /UserTweets, /UserTweetsReplies, /UserMedia.
 * Hub-side resolves user_id → username before invoking. The `mode`
 * input controls post-filtering ("tweets" / "replies" / "media").
 */
export declare const xUserTweetsSkill: SkillHandler;
