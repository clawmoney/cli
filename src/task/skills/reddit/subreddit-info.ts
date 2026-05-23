import { bnbotRDSubredditInfo } from "./_bnbot.js";
import { makeRedditSkill, reqStr } from "./_skill.js";

export const rdSubredditInfoSkill = makeRedditSkill("reddit subreddit info", (i) =>
  bnbotRDSubredditInfo(reqStr(i, ["subreddit", "sub"], "subreddit")));
