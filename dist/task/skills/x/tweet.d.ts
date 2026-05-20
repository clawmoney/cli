import type { SkillHandler } from "../../types.js";
/**
 * `x.tweet` — backs /TweetDetail, /TweetDetailv2, /TweetDetail-
 * Conversation, /TweetDetailConversationv2. `include_replies`
 * decides whether the response carries the reply list (full
 * conversation) or just the single tweet wrapped in a result.
 */
export declare const xTweetSkill: SkillHandler;
