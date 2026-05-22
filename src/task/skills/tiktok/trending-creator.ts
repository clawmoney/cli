import type { SkillHandler } from "../../types.js";
import { bnbotTTTrendingCreator } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkTrendingCreatorSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      page?: number;
      limit?: number;
      sort_by?: string;
      country?: string;
    };
    ctx.report({
      stage: "launching",
      percent: 5,
      note: "tiktok trending creators",
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTTrendingCreator(i);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
