import { bnbotRDPopularPosts } from "./_bnbot.js";
import { makeRedditSkill, num, str } from "./_skill.js";
export const rdPopularPostsSkill = makeRedditSkill("reddit popular posts", (i) => bnbotRDPopularPosts({ sort: str(i, ["sort"]), limit: num(i, ["limit", "count"]) }));
