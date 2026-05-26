import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, num, reqStr, str } from "./_skill.js";
export const biliUserVideosSkill = makeBilibiliSkill("bilibili user videos", (i) => bnbotBili("user-videos", [reqStr(i, ["uid", "mid", "user"], "uid")], { page: num(i, ["page"]), order: str(i, ["order"]), limit: num(i, ["limit", "count"]) }));
