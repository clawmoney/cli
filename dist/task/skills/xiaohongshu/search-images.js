import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, num, reqStr, str } from "./_skill.js";
export const xhsSearchImagesSkill = makeXhsSkill("xhs search images", (i) => bnbotXHS("search-images", [reqStr(i, ["keyword", "query"], "keyword")], { page: num(i, ["page"]), source: str(i, ["source"]), limit: num(i, ["limit", "count"]) }));
