import type { SkillHandler } from "../../types.js";
import { bnbotDYChallengePosts } from "./_bnbot.js";
import { startProgressTicker } from "../tiktok/_helpers.js";

export const dyChallengePostsSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      hashtag?: string;
      hashtag_id?: string;
      ch_id?: string;
      offset?: number;
      limit?: number;
    };
    const hashtag = i.hashtag || i.hashtag_id || i.ch_id;
    const { offset, limit } = i;
    if (!hashtag) throw new Error("missing 'hashtag' (or hashtag_id/ch_id)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `douyin challenge posts ${hashtag}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotDYChallengePosts({ hashtag, offset, limit });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
