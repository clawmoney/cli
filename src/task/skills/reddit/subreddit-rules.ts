import { bnbotRDSubredditRules } from "./_bnbot.js";
import { makeRedditSkill, reqStr } from "./_skill.js";

export const rdSubredditRulesSkill = makeRedditSkill("reddit subreddit rules", (i) =>
  bnbotRDSubredditRules(reqStr(i, ["subreddit", "sub"], "subreddit")));
