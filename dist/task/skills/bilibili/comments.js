import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, num, reqStr, str } from "./_skill.js";
export const biliCommentsSkill = makeBilibiliSkill("bilibili comments", (i) => bnbotBili("comments", [reqStr(i, ["bvid", "video", "url", "id"], "bvid")], { parent: str(i, ["parent", "rpid"]), limit: num(i, ["limit", "count"]) }));
