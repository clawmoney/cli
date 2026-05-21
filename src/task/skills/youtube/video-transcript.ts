import type { SkillHandler } from "../../types.js";
import { bnbotYTTranscript } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";

/** Fetch a YouTube video's transcript (auto-generated or human
 *  captions, depending on availability). Reads
 *  ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer
 *  via the bnbot extension, then fetches and parses the timedtext
 *  baseUrl. Returns an array of {start, duration, text} segments. */
export const ytVideoTranscriptSkill: SkillHandler = {
  price_usd: 0.001,
  async run(input, ctx) {
    const { id, lang } = (input ?? {}) as { id?: string; lang?: string };
    if (!id) throw new Error("missing 'id'");
    ctx.report({ stage: "launching", percent: 5, note: `transcript ${id}` });
    const stop = startProgressTicker(ctx, "fetching captions...");
    try {
      const raw = await bnbotYTTranscript(id, lang);
      ctx.report({ stage: "parsing", percent: 95 });
      return raw;
    } finally {
      stop();
    }
  },
};
