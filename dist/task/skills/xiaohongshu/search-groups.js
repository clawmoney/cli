import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, reqStr, str } from "./_skill.js";
export const xhsSearchGroupsSkill = makeXhsSkill("xhs search groups", (i) => bnbotXHS("search-groups", [reqStr(i, ["keyword", "query"], "keyword")], { source: str(i, ["source"]), search_id: str(i, ["search_id", "searchId"]) }));
