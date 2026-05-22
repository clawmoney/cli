import type { SkillHandler } from "../../types.js";
import { bnbotTTAdsTop } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkAdsTopSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      page?: number;
      period?: number;
      limit?: number;
      country?: string;
      order_by?: string;
    };
    ctx.report({
      stage: "launching",
      percent: 5,
      note: "tiktok top ads",
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTAdsTop(i);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
