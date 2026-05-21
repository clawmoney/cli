import type { SkillHandler } from "../../types.js";
/**
 * `x.trends` — backs twitter283 /Trends. Hub passes `{woeid}` (defaults
 * to 1, X's worldwide). bnbot ignores woeid for non-personalized
 * accounts but accepts it as a best-effort hint.
 */
export declare const xTrendsSkill: SkillHandler;
