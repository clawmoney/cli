import { bnbotXTweetArticle } from "./_bnbot.js";
import { tweetArticleToTwitter283 } from "./_mapper.js";
/**
 * `x.tweet_article` — backs /TweetArticle. Returns the long-form
 * Article attached to a tweet (title, content, author, cover image).
 * Throws upstream if the tweet has no Article attached.
 */
export const xTweetArticleSkill = {
    price_usd: 0.0001,
    async run(input, ctx) {
        const { tweet_id } = (input ?? {});
        if (!tweet_id)
            throw new Error("missing 'tweet_id'");
        ctx.report({
            stage: "launching",
            percent: 10,
            note: `tweet-article ${tweet_id}`,
        });
        let pct = 15;
        const t = setInterval(() => {
            pct = Math.min(80, pct + 10);
            ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
        }, 1500);
        let raw;
        try {
            raw = await bnbotXTweetArticle(tweet_id);
        }
        finally {
            clearInterval(t);
        }
        ctx.report({ stage: "parsing", percent: 95 });
        return tweetArticleToTwitter283(raw);
    },
};
