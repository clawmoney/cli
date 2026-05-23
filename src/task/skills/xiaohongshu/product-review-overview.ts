import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, str } from "./_skill.js";
export const xhsProductReviewOverviewSkill = makeXhsSkill("xhs product review overview", (i) => bnbotXHS("product-review-overview", [], { tab: str(i, ["tab"]), sku_id: str(i, ["sku_id", "skuId"]) }));
