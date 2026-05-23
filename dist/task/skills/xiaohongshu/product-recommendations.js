import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, str } from "./_skill.js";
export const xhsProductRecommendationsSkill = makeXhsSkill("xhs product recommendations", (i) => bnbotXHS("product-recommendations", [], { region: str(i, ["region"]), sku_id: str(i, ["sku_id", "skuId"]) }));
