import { bnbotRDPostsBySubreddit } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";
export const rdPostsBySubredditSkill = makeRedditSkill("reddit posts by subreddit", (i) => bnbotRDPostsBySubreddit({
    subreddit: reqStr(i, ["subreddit", "sub"], "subreddit"),
    sort: str(i, ["sort"]),
    time: str(i, ["time", "t"]),
    limit: num(i, ["limit", "count"]),
}));
