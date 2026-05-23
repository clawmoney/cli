import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, num, reqStr, str } from "./_skill.js";
export const xhsSearchUsersSkill = makeXhsSkill("xhs search users", (i) => bnbotXHS("search-users", [reqStr(i, ["keyword", "query"], "keyword")], { page: num(i, ["page"]), source: str(i, ["source"]) }));
