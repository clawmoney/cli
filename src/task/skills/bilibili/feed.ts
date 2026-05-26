import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, num, reqStr, str } from "./_skill.js";
export const biliFeedSkill = makeBilibiliSkill("bilibili feed", (i) => {
  const uid = reqStr(i, ["uid", "mid", "user"], "uid");
  return bnbotBili("feed", [uid], { pages: num(i, ["pages"]), type: str(i, ["type"]), limit: num(i, ["limit", "count"]) });
});
