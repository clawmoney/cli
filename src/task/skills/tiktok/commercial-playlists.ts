import type { SkillHandler } from "../../types.js";
import { bnbotTTCommercialPlaylists } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkCommercialMusicPlaylistsSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as { limit?: number; region?: string };
    ctx.report({
      stage: "launching",
      percent: 5,
      note: "tiktok commercial playlists",
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTCommercialPlaylists(i);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
