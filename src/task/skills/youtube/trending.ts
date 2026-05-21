import type { SkillHandler } from "../../types.js";
import { bnbotYTTrending } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const ytTrendingSkill: SkillHandler = {
  price_usd: 0.001,
  async run(_input, ctx) {
    ctx.report({ stage: "launching", percent: 5, note: "youtube trending" });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotYTTrending();
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
