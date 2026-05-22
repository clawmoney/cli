import type { SkillHandler } from "../../types.js";
import { bnbotTTSearchLive } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkSearchLiveSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      keyword?: string;
      q?: string;
      query?: string;
      cursor?: string;
      limit?: number;
    };
    const query = i.keyword || i.q || i.query;
    const { cursor, limit } = i;
    if (!query) throw new Error("missing 'keyword' (or q/query)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok live search '${query}'`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTSearchLive({ query, cursor, limit });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
