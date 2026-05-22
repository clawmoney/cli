import type { SkillHandler } from "../../types.js";
import { bnbotDYSearchGeneral } from "./_bnbot.js";
import { startProgressTicker } from "../tiktok/_helpers.js";

export const dySearchGeneralSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      keyword?: string;
      q?: string;
      query?: string;
      offset?: number;
      limit?: number;
    };
    const query = i.keyword || i.q || i.query;
    const { offset, limit } = i;
    if (!query) throw new Error("missing 'keyword' (or q/query)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `douyin general search '${query}'`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotDYSearchGeneral({ query, offset, limit });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
