import { bnbotRDUserStats } from "./_bnbot.js";
import { makeRedditSkill, reqStr } from "./_skill.js";

export const rdUserStatsSkill = makeRedditSkill("reddit user stats", (i) =>
  bnbotRDUserStats(reqStr(i, ["username", "user"], "username")));
