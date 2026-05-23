import { bnbotRDBestPopularPosts } from "./_bnbot.js";
import { makeRedditSkill, num } from "./_skill.js";

export const rdBestPopularPostsSkill = makeRedditSkill("reddit best popular posts", (i) =>
  bnbotRDBestPopularPosts({ limit: num(i, ["limit", "count"]) }));
