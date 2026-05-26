import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, num } from "./_skill.js";
export const biliRankingSkill = makeBilibiliSkill("bilibili ranking", (i) => bnbotBili("ranking", [], { limit: num(i, ["limit", "count"]) }));
