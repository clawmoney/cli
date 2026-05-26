import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, reqStr, str } from "./_skill.js";
export const biliSubtitleSkill = makeBilibiliSkill("bilibili subtitle", (i) => bnbotBili("subtitle", [reqStr(i, ["bvid", "video", "url", "id"], "bvid")], { lang: str(i, ["lang", "language"]) }));
