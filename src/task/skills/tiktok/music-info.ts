import type { SkillHandler } from "../../types.js";
import { bnbotTTMusicInfo } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkMusicInfoSkill: SkillHandler = {
  price_usd: 0.0008,
  async run(input, ctx) {
    const i = (input ?? {}) as { musicId?: string; id?: string };
    const musicId = i.musicId || i.id;
    if (!musicId) throw new Error("missing 'musicId' (or id)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok music ${musicId}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTMusicInfo(musicId);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
