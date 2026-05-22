import { bnbotTTUserInfoRegion } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkUserInfoRegionSkill = {
    price_usd: 0.0008,
    async run(input, ctx) {
        const i = (input ?? {});
        const uniqueId = i.uniqueId || i.username || i.handle;
        if (!uniqueId)
            throw new Error("missing 'uniqueId' (or username/handle)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok profile (region) @${uniqueId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTUserInfoRegion(uniqueId);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
