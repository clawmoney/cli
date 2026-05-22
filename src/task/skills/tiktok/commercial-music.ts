import type { SkillHandler } from "../../types.js";
import { bnbotTTCommercialMusic } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

/** Coerce a buyer-supplied placements/themes/genres/moods value into the
 *  comma-separated string the bnbot CLI wrapper expects. Accepts arrays,
 *  CSV strings, or undefined. */
function normalize(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x)).join(",");
  if (typeof v === "string") return v;
  return String(v);
}

export const tkCommercialMusicLibrarySkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const i = (input ?? {}) as {
      page?: number;
      limit?: number;
      region?: string;
      scenarios?: number;
      duration?: number;
      placements?: unknown;
      themes?: unknown;
      genres?: unknown;
      moods?: unknown;
    };
    ctx.report({
      stage: "launching",
      percent: 5,
      note: "tiktok commercial music",
    });
    const stop = startProgressTicker(ctx, "bnbot working...");
    try {
      const raw = await bnbotTTCommercialMusic({
        page: i.page,
        limit: i.limit,
        region: i.region,
        scenarios: i.scenarios,
        duration: i.duration,
        placements: normalize(i.placements),
        themes: normalize(i.themes),
        genres: normalize(i.genres),
        moods: normalize(i.moods),
      });
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
