import type { SkillHandler } from "../../types.js";
import { bnbotTTTopProductDetail } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkTopProductDetailSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      product_id?: string;
      productId?: string;
      id?: string;
    };
    const productId = i.product_id || i.productId || i.id;
    if (!productId) throw new Error("missing 'product_id' (or productId/id)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok product detail ${productId}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTTopProductDetail(productId);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
