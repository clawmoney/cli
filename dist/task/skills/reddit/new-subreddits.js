import { bnbotRDNewSubreddits } from "./_bnbot.js";
import { makeRedditSkill, num } from "./_skill.js";
export const rdNewSubredditsSkill = makeRedditSkill("reddit new subreddits", (i) => bnbotRDNewSubreddits({ limit: num(i, ["limit", "count"]) }));
