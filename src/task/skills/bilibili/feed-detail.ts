import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, reqStr } from "./_skill.js";
export const biliFeedDetailSkill = makeBilibiliSkill("bilibili feed detail", (i) => bnbotBili("feed-detail", [reqStr(i, ["id", "dynamic_id", "dynamicId"], "id")]));
