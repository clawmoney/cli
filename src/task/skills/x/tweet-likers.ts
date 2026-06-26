import type { SkillHandler } from "../../types.js";
import { bnbotXTweetLikers } from "./_bnbot.js";
import { userListToTwitter283, type BnbotUserListEntry } from "./_mapper.js";

/**
 * `x.tweet_favoriters` — backs /TweetFavoriters. Hub passes a numeric
 * tweet_id; we hand bnbot the URL form `https://twitter.com/i/status/{id}`,
 * which X resolves to canonical.
 */
export const xTweetLikersSkill: SkillHandler = {
  price_usd: 0.0001,
  async run(input, ctx) {
    const { tweet_id, count, cursor } = (input ?? {}) as {
      tweet_id?: string;
      count?: number;
      cursor?: string;
    };
    if (!tweet_id) throw new Error("missing 'tweet_id'");

    ctx.report({
      stage: "launching",
      percent: 10,
      note: `tweet-likers ${tweet_id}`,
    });

    let pct = 15;
    const t = setInterval(() => {
      pct = Math.min(80, pct + 10);
      ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
    }, 1500);
    let raw: { users: unknown[]; next_cursor: string | null };
    try {
      raw = await bnbotXTweetLikers({ tweet_id, count, cursor });
    } finally {
      clearInterval(t);
    }

    ctx.report({ stage: "parsing", percent: 95 });
    return userListToTwitter283(
      raw.users as BnbotUserListEntry[],
      raw.next_cursor,
    );
  },
};
