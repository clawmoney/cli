import { bnbotRDSubredditModerators } from "./_bnbot.js";
import { makeRedditSkill, reqStr } from "./_skill.js";
export const rdSubredditModeratorsSkill = makeRedditSkill("reddit subreddit moderators", (i) => bnbotRDSubredditModerators(reqStr(i, ["subreddit", "sub"], "subreddit")));
