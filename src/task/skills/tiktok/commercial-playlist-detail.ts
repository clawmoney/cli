import type { SkillHandler } from "../../types.js";
import { bnbotTTCommercialPlaylistDetail } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkCommercialMusicPlaylistDetailSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      playlist_id?: string;
      playlistId?: string;
      id?: string;
      page?: number;
      limit?: number;
      region?: string;
    };
    const playlistId = i.playlist_id || i.playlistId || i.id;
    if (!playlistId) throw new Error("missing 'playlist_id' (or playlistId/id)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok playlist detail ${playlistId}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTCommercialPlaylistDetail({
        playlist_id: playlistId,
        page: i.page,
        limit: i.limit,
        region: i.region,
      });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
