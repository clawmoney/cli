import { bnbotTTCollectionInfo } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkCollectionInfoSkill = {
    price_usd: 0.0008,
    async run(input, ctx) {
        const i = (input ?? {});
        const collectionId = i.collectionId || i.id;
        if (!collectionId)
            throw new Error("missing 'collectionId' (or id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok collection ${collectionId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTCollectionInfo(collectionId);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
