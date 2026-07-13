import { bnbotXTweetRetweeters } from "./_bnbot.js";
import { userListToTwitter283 } from "./_mapper.js";
/**
 * `x.tweet_retweeters` — backs /TweetRetweeters. Same shape as
 * tweet-likers but a different X GraphQL op underneath.
 */
export const xTweetRetweetersSkill = {
    price_usd: 0.0001,
    async run(input, ctx) {
        const { tweet_id, count, cursor } = (input ?? {});
        if (!tweet_id)
            throw new Error("missing 'tweet_id'");
        ctx.report({
            stage: "launching",
            percent: 10,
            note: `tweet-retweeters ${tweet_id}`,
        });
        let pct = 15;
        const t = setInterval(() => {
            pct = Math.min(80, pct + 10);
            ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
        }, 1500);
        let raw;
        try {
            raw = await bnbotXTweetRetweeters({ tweet_id, count, cursor });
        }
        finally {
            clearInterval(t);
        }
        ctx.report({ stage: "parsing", percent: 95 });
        return userListToTwitter283(raw.users, raw.next_cursor);
    },
};
