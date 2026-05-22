import type { SkillHandler } from "../../types.js";
import { bnbotTTAdsDetail } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkAdsDetailSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as { ads_id?: string; adsId?: string; id?: string };
    const adsId = i.ads_id || i.adsId || i.id;
    if (!adsId) throw new Error("missing 'ads_id' (or adsId/id)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok ads detail ${adsId}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTAdsDetail(adsId);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
