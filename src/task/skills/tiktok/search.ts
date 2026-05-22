import type { SkillHandler } from "../../types.js";
import { bnbotTTSearchVideo } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkSearchVideoSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as { keyword?: string; q?: string; query?: string; limit?: number };
    const q = i.keyword || i.q || i.query;
    const { limit } = i;
    if (!q) throw new Error("missing 'keyword' (or q/query)");
    ctx.report({ stage: "launching", percent: 5, note: `tiktok search '${q}'` });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTSearchVideo(q, limit);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
