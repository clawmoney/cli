import type { SkillHandler } from "../../types.js";
import { bnbotYTChannelSearch } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const ytChannelSearchSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const { id, q } = (input ?? {}) as { id?: string; q?: string };
    if (!id) throw new Error("missing 'id'");
    if (!q) throw new Error("missing 'q'");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `search '${q}' in channel ${id}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotYTChannelSearch(id, q);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
