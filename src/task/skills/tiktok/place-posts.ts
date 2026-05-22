import type { SkillHandler } from "../../types.js";
import { bnbotTTPlacePosts } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkPlacePostsSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      placeId?: string;
      id?: string;
      cursor?: string;
      limit?: number;
    };
    const placeId = i.placeId || i.id;
    const { cursor, limit } = i;
    if (!placeId) throw new Error("missing 'placeId' (or id)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok place posts ${placeId}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTPlacePosts({ placeId, cursor, limit });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
