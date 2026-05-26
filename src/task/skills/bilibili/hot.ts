import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, num } from "./_skill.js";
export const biliHotSkill = makeBilibiliSkill("bilibili hot", (i) => bnbotBili("hot", [], { limit: num(i, ["limit", "count"]) }));
