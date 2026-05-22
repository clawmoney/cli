import { bnbotYTTranscript } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
import { isYtDlpInstalled, ytdlpTranscript } from "./_ytdlp.js";
/**
 * Fetch a YouTube video's transcript.
 *
 * Primary: yt-dlp. YouTube's transcript endpoint sits behind several
 * anti-automation gates (JS challenge, pot/proof-of-token, /youtubei
 * precondition checks) that reject our browser-based interception.
 * yt-dlp maintains the workarounds for these, so we shell out to it.
 *
 * Fallback: bnbot extension (the old INTERCEPT path). Only useful for
 * legacy bnbot hosts that haven't installed yt-dlp yet — kept so we
 * don't return an outright error during the rollout window.
 */
export const ytVideoTranscriptSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const { id, lang } = (input ?? {});
        if (!id)
            throw new Error("missing 'id'");
        ctx.report({ stage: "launching", percent: 5, note: `transcript ${id}` });
        if (await isYtDlpInstalled()) {
            const stop = startProgressTicker(ctx, "yt-dlp downloading subtitles...");
            try {
                const result = await ytdlpTranscript(id, lang || "en");
                ctx.report({ stage: "parsing", percent: 95, note: `${result.lines.length} lines` });
                return result;
            }
            finally {
                stop();
            }
        }
        // No yt-dlp on this host — fall back to the extension path.
        ctx.report({ stage: "launching", percent: 10, note: "yt-dlp absent, falling back to bnbot extension" });
        const stop = startProgressTicker(ctx, "fetching captions via extension...");
        try {
            const raw = await bnbotYTTranscript(id, lang);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
