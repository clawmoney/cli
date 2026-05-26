import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, num, reqStr } from "./_skill.js";
export const biliSearchSkill = makeBilibiliSkill("bilibili search", (i) => bnbotBili("search", [reqStr(i, ["query", "keyword", "q"], "query")], { limit: num(i, ["limit", "count"]) }));
