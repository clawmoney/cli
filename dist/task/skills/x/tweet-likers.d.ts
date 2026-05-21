import type { SkillHandler } from "../../types.js";
/**
 * `x.tweet_favoriters` — backs /TweetFavoriters. Hub passes a numeric
 * tweet_id; we hand bnbot the URL form `https://twitter.com/i/status/{id}`,
 * which X resolves to canonical.
 */
export declare const xTweetLikersSkill: SkillHandler;
