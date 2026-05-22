import type { SkillHandler } from "../../types.js";
import { bnbotTTUserInfo } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkUserInfoSkill: SkillHandler = {
  price_usd: 0.0008,
  async run(input, ctx) {
    const { uniqueId } = (input ?? {}) as { uniqueId?: string };
    if (!uniqueId) throw new Error("missing 'uniqueId'");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok profile @${uniqueId}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTUserInfo(uniqueId);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
