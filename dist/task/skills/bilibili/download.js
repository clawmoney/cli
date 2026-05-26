import { startProgressTicker } from "./_helpers.js";
import { isYtDlpInstalled, ytdlpBilibiliDownload } from "./_ytdlp.js";
export const biliDownloadSkill = {
    price_usd: 0.0015,
    async run(input, ctx) {
        const i = (input ?? {});
        const video = i.url || i.bvid || i.video || i.id;
        if (!video)
            throw new Error("missing 'url' or 'bvid'");
        ctx.report({ stage: "launching", percent: 5, note: `bilibili download ${video}` });
        if (!(await isYtDlpInstalled())) {
            throw new Error("yt-dlp not found on PATH — install with `brew install yt-dlp` or `pipx install yt-dlp`");
        }
        const stop = startProgressTicker(ctx, "yt-dlp probing Bilibili formats...");
        try {
            const result = await ytdlpBilibiliDownload(video);
            ctx.report({ stage: "parsing", percent: 95, note: `${result.formats.length} formats` });
            return result;
        }
        finally {
            stop();
        }
    },
};
