import { bnbotTTChallengeInfo } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkChallengeInfoSkill = {
    price_usd: 0.0008,
    async run(input, ctx) {
        const i = (input ?? {});
        const name = i.challengeName || i.name;
        if (!name)
            throw new Error("missing 'challengeName' (or name)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok challenge #${name}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTChallengeInfo(name);
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
