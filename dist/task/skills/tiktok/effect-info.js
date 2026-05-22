import { bnbotTTEffectInfo } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkEffectInfoSkill = {
    price_usd: 0.0008,
    async run(input, ctx) {
        const i = (input ?? {});
        const effectId = i.effectId || i.id;
        if (!effectId)
            throw new Error("missing 'effectId' (or id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok effect ${effectId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTEffectInfo(effectId);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
