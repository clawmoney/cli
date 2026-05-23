import { bnbotRDRisingPopularPosts } from "./_bnbot.js";
import { makeRedditSkill, num } from "./_skill.js";

export const rdRisingPopularPostsSkill = makeRedditSkill("reddit rising popular posts", (i) =>
  bnbotRDRisingPopularPosts({ limit: num(i, ["limit", "count"]) }));
