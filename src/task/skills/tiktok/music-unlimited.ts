import type { SkillHandler } from "../../types.js";
import { bnbotTTMusicUnlimitedSounds } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkMusicUnlimitedSoundsSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      page?: number;
      pageSize?: number;
      orderBy?: string;
    };
    ctx.report({
      stage: "launching",
      percent: 5,
      note: "tiktok unlimited sounds",
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTMusicUnlimitedSounds(i);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
