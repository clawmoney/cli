import type { SkillHandler } from "../../types.js";
import { bnbotTTSearchSuggestions } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkSearchSuggestionsSkill: SkillHandler = {
  price_usd: 0.0005,
  async run(input, ctx) {
    const i = (input ?? {}) as { keyword?: string; q?: string; query?: string };
    const keyword = i.keyword || i.q || i.query;
    if (!keyword) throw new Error("missing 'keyword' (or q/query)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok suggestions '${keyword}'`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTSearchSuggestions(keyword);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
