import { bnbotRDUserPostRankInSubreddit } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";

export const rdUserPostRankInSubredditSkill = makeRedditSkill("reddit user post rank in subreddit", (i) =>
  bnbotRDUserPostRankInSubreddit({
    username: reqStr(i, ["username", "user"], "username"),
    subreddit: reqStr(i, ["subreddit", "sub"], "subreddit"),
    sort: str(i, ["sort"]),
    limit: num(i, ["limit", "count"]),
  }));
