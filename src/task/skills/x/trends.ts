import type { SkillHandler } from "../../types.js";
import { bnbotXTrends } from "./_bnbot.js";
import { trendsToTwitter283, type BnbotTrend } from "./_mapper.js";

/**
 * `x.trends` — backs twitter283 /Trends. Hub passes `{woeid}` (defaults
 * to 1, X's worldwide). bnbot ignores woeid for non-personalized
 * accounts but accepts it as a best-effort hint.
 */
export const xTrendsSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const { woeid, count } = (input ?? {}) as {
      woeid?: number;
      count?: number;
    };

    ctx.report({
      stage: "launching",
      percent: 10,
      note: `trends woeid=${woeid ?? "default"}`,
    });

    let pct = 15;
    const t = setInterval(() => {
      pct = Math.min(80, pct + 10);
      ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
    }, 1500);
    let raw: unknown[];
    try {
      raw = await bnbotXTrends({ woeid, limit: count });
    } finally {
      clearInterval(t);
    }

    ctx.report({ stage: "parsing", percent: 95 });
    return trendsToTwitter283(raw as BnbotTrend[]);
  },
};
