import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, str } from "./_skill.js";
export const xhsProductDetailSkill = makeXhsSkill("xhs product detail", (i) => bnbotXHS("product-detail", [], { sku_id: str(i, ["sku_id", "skuId"]), source: str(i, ["source"]), pre_page: str(i, ["pre_page", "prePage"]) }));
