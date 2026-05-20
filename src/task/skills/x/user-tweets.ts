import type { SkillHandler } from "../../types.js";
import { bnbotXUserTweets, type UserTweetsArgs } from "./_bnbot.js";
import { userTweetsToTwitter283, type BnbotTweet } from "./_mapper.js";

/**
 * `x.user_tweets` — backs /UserTweets, /UserTweetsReplies, /UserMedia.
 * Hub-side resolves user_id → username before invoking. The `mode`
 * input controls post-filtering ("tweets" / "replies" / "media").
 */
export const xUserTweetsSkill: SkillHandler = {
  price_usd: 0.005,
  async run(input, ctx) {
    const args = (input ?? {}) as UserTweetsArgs;
    if (!args.username) throw new Error("missing 'username'");

    ctx.report({
      stage: "launching",
      percent: 10,
      note: `user-tweets @${args.username} mode=${args.mode ?? "tweets"}`,
    });

    let pct = 15;
    const t = setInterval(() => {
      pct = Math.min(80, pct + 10);
      ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
    }, 1500);
    let raw: unknown[];
    try {
      raw = await bnbotXUserTweets(args);
    } finally {
      clearInterval(t);
    }

    ctx.report({ stage: "parsing", percent: 95 });
    return userTweetsToTwitter283(raw as BnbotTweet[]);
  },
};
