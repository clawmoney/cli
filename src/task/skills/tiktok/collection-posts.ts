import type { SkillHandler } from "../../types.js";
import { bnbotTTCollectionPosts } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const tkCollectionPostsSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    // NO cursor: tiktok-api23's /api/collection/posts sample paginates
    // by `count` only.
    const i = (input ?? {}) as {
      collectionId?: string;
      id?: string;
      limit?: number;
    };
    const collectionId = i.collectionId || i.id;
    const { limit } = i;
    if (!collectionId) throw new Error("missing 'collectionId' (or id)");
    ctx.report({
      stage: "launching",
      percent: 5,
      note: `tiktok collection posts ${collectionId}`,
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTCollectionPosts({ collectionId, limit });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
