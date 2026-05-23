import { bnbotRDTopPostsBySubreddit } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";

export const rdTopPostsBySubredditSkill = makeRedditSkill("reddit top posts by subreddit", (i) =>
  bnbotRDTopPostsBySubreddit({
    subreddit: reqStr(i, ["subreddit", "sub"], "subreddit"),
    time: str(i, ["time", "t"]),
    limit: num(i, ["limit", "count"]),
  }));
