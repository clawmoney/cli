import { bnbotTTPlaceInfo } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkPlaceInfoSkill = {
    price_usd: 0.0008,
    async run(input, ctx) {
        const i = (input ?? {});
        const placeId = i.placeId || i.id;
        if (!placeId)
            throw new Error("missing 'placeId' (or id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok place ${placeId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTPlaceInfo(placeId);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
