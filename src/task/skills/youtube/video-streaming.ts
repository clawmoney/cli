import type { SkillHandler } from "../../types.js";
import { bnbotYTStreamingData } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const ytVideoStreamingSkill: SkillHandler = {
  price_usd: 0.0008,
  async run(input, ctx) {
    const { id } = (input ?? {}) as { id?: string };
    if (!id) throw new Error("missing 'id'");
    ctx.report({ stage: "launching", percent: 5, note: `streaming-data ${id}` });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotYTStreamingData(id);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
