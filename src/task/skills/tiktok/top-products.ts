import type { SkillHandler } from "../../types.js";
import { bnbotTTTopProducts } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkTopProductsSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      page?: number;
      last?: number;
      order_by?: string;
      order_type?: string;
    };
    ctx.report({
      stage: "launching",
      percent: 5,
      note: "tiktok top products",
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTTopProducts(i);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
