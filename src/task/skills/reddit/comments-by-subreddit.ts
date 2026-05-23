import { bnbotRDCommentsBySubreddit } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr } from "./_skill.js";

export const rdCommentsBySubredditSkill = makeRedditSkill("reddit comments by subreddit", (i) =>
  bnbotRDCommentsBySubreddit({
    subreddit: reqStr(i, ["subreddit", "sub"], "subreddit"),
    limit: num(i, ["limit", "count"]),
  }));
