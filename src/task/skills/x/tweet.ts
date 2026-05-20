import type { SkillHandler } from "../../types.js";
import { bnbotXThread } from "./_bnbot.js";
import {
  tweetConversationToTwitter283,
  tweetToTwitter283Result,
  type BnbotTweet,
} from "./_mapper.js";

/**
 * `x.tweet` — backs /TweetDetail, /TweetDetailv2, /TweetDetail-
 * Conversation, /TweetDetailConversationv2. `include_replies`
 * decides whether the response carries the reply list (full
 * conversation) or just the single tweet wrapped in a result.
 */
export const xTweetSkill: SkillHandler = {
  price_usd: 0.004,
  async run(input, ctx) {
    const { tweet_id: tweetId, include_replies = false } = (input ?? {}) as {
      tweet_id?: string;
      include_replies?: boolean;
    };
    if (!tweetId) throw new Error("missing 'tweet_id'");

    ctx.report({
      stage: "launching",
      percent: 10,
      note: `tweet ${tweetId} (conversation=${include_replies})`,
    });

    let pct = 15;
    const t = setInterval(() => {
      pct = Math.min(80, pct + 10);
      ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
    }, 1500);
    let thread: BnbotTweet[];
    try {
      thread = (await bnbotXThread(tweetId)) as BnbotTweet[];
    } finally {
      clearInterval(t);
    }

    if (thread.length === 0) {
      throw new Error(`tweet ${tweetId} not found`);
    }

    ctx.report({ stage: "parsing", percent: 95 });
    const [head, ...rest] = thread;
    if (include_replies) {
      return tweetConversationToTwitter283(head!, rest);
    }
    return tweetToTwitter283Result(head!);
  },
};
