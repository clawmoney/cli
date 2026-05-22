import { bnbotTTEffectPosts } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkEffectPostsSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const effectId = i.effectId || i.id;
        const { cursor, limit } = i;
        if (!effectId)
            throw new Error("missing 'effectId' (or id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok effect posts ${effectId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTEffectPosts({ effectId, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
