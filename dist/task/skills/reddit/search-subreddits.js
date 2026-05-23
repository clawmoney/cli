import { bnbotRDSearchSubreddits } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr } from "./_skill.js";
export const rdSearchSubredditsSkill = makeRedditSkill("reddit search subreddits", (i) => bnbotRDSearchSubreddits({
    query: reqStr(i, ["query", "q"], "query"),
    limit: num(i, ["limit", "count"]),
}));
