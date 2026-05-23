import { bnbotRDSimilarSubreddits } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr } from "./_skill.js";

export const rdSimilarSubredditsSkill = makeRedditSkill("reddit similar subreddits", (i) =>
  bnbotRDSimilarSubreddits({
    subreddit: reqStr(i, ["subreddit", "sub"], "subreddit"),
    limit: num(i, ["limit", "count"]),
  }));
