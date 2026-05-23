import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, num, reqStr, str } from "./_skill.js";
export const xhsSearchProductsSkill = makeXhsSkill("xhs search products", (i) => bnbotXHS("search-products", [reqStr(i, ["keyword", "query"], "keyword")], { page: num(i, ["page"]), source: str(i, ["source"]) }));
