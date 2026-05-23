import { bnbotRDControversialPostsBySubreddit } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";
export const rdControversialPostsBySubredditSkill = makeRedditSkill("reddit controversial posts by subreddit", (i) => bnbotRDControversialPostsBySubreddit({
    subreddit: reqStr(i, ["subreddit", "sub"], "subreddit"),
    time: str(i, ["time", "t"]),
    limit: num(i, ["limit", "count"]),
}));
