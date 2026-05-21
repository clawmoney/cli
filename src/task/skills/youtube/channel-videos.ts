import type { SkillHandler } from "../../types.js";
import { bnbotYTChannelVideos } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

export const ytChannelVideosSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const { id, filter, cursor } = (input ?? {}) as {
      id?: string;
      filter?: string;
      cursor?: string;
    };
    if (!id) throw new Error("missing 'id'");

    // youtube138 uses "videos_latest" | "videos_popular" | "videos_oldest";
    // bnbot CLI uses the bare token. Strip the "videos_" prefix.
    const cliFilter = filter?.replace(/^videos_/, "") ?? undefined;

    ctx.report({ stage: "launching", percent: 5, note: `channel ${id} videos` });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotYTChannelVideos({
        id,
        filter: cliFilter,
        cursor,
      });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
