import type { SkillHandler } from "../../types.js";
import { bnbotTTPostExplore } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkPostExploreSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      categoryType?: string;
      category?: string;
      limit?: number;
    };
    const categoryType = i.categoryType || i.category;
    const { limit } = i;
    ctx.report({
      stage: "launching",
      percent: 5,
      note: "tiktok explore feed",
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTPostExplore({ categoryType, limit });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
