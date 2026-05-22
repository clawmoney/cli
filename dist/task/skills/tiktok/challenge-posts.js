import { bnbotTTChallengePosts } from "./_bnbot.js";
import { startProgressTicker } from "./_helpers.js";
export const tkChallengePostsSkill = {
    price_usd: 0.001,
    async run(input, ctx) {
        const i = (input ?? {});
        const challengeId = i.challengeId || i.id;
        const { cursor, limit } = i;
        if (!challengeId)
            throw new Error("missing 'challengeId' (or id)");
        ctx.report({
            stage: "launching",
            percent: 5,
            note: `tiktok challenge posts ${challengeId}`,
        });
        const stop = startProgressTicker(ctx, "bnbot working...");
        try {
            const raw = await bnbotTTChallengePosts({ challengeId, cursor, limit });
            ctx.report({ stage: "parsing", percent: 95 });
            return raw;
        }
        finally {
            stop();
        }
    },
};
