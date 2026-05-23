import { bnbotRDTopPopularPosts } from "./_bnbot.js";
import { makeRedditSkill, num, str } from "./_skill.js";
export const rdTopPopularPostsSkill = makeRedditSkill("reddit top popular posts", (i) => bnbotRDTopPopularPosts({ time: str(i, ["time", "t"]), limit: num(i, ["limit", "count"]) }));
