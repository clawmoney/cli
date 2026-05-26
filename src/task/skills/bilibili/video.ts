import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, reqStr } from "./_skill.js";
export const biliVideoSkill = makeBilibiliSkill("bilibili video", (i) => bnbotBili("video", [reqStr(i, ["bvid", "video", "url", "id"], "bvid")]));
