import type { SkillHandler } from "../../types.js";
import { bnbotTTTrendingKeyword } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkTrendingKeywordSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      page?: number;
      limit?: number;
      period?: number;
      country?: string;
    };
    ctx.report({
      stage: "launching",
      percent: 5,
      note: "tiktok trending keywords",
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTTrendingKeyword(i);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
