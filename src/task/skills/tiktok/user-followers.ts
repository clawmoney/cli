import type { SkillHandler } from "../../types.js";
import { bnbotTTUserFollowers } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkUserFollowersSkill: SkillHandler = {
  price_usd: 0.0015,
  async run(input, ctx) {
    const { user, cursor, limit } = (input ?? {}) as {
      user?: string;
      cursor?: string;
      limit?: number;
    };
    if (!user) throw new Error("missing 'user' (handle or secUid)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok followers of ${user}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTUserFollowers({ user, cursor, limit });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
