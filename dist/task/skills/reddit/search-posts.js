import { bnbotRDSearchPosts } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";
export const rdSearchPostsSkill = makeRedditSkill("reddit search posts", (i) => bnbotRDSearchPosts({
    query: reqStr(i, ["query", "q", "keyword"], "query"),
    subreddit: str(i, ["subreddit", "sub"]),
    sort: str(i, ["sort"]),
    time: str(i, ["time", "t"]),
    limit: num(i, ["limit", "count"]),
}));
