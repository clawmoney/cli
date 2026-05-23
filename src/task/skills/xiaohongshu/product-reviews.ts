import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, str } from "./_skill.js";
export const xhsProductReviewsSkill = makeXhsSkill("xhs product reviews", (i) => bnbotXHS("product-reviews", [], { sku_id: str(i, ["sku_id", "skuId"]), from_page: str(i, ["from_page", "fromPage"]) }));
