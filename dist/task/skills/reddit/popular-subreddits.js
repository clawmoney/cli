import { bnbotRDPopularSubreddits } from "./_bnbot.js";
import { makeRedditSkill, num } from "./_skill.js";
export const rdPopularSubredditsSkill = makeRedditSkill("reddit popular subreddits", (i) => bnbotRDPopularSubreddits({ limit: num(i, ["limit", "count"]) }));
