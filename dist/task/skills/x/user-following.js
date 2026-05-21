import { bnbotXUserFollowing } from "./_bnbot.js";
import { userListToTwitter283, userIdsToTwitter283, } from "./_mapper.js";
/**
 * `x.user_following` — backs /UserFollowing and /FollowingIds. Hub
 * resolves user_id → username first. `ids_only` collapses output to a
 * twitter-v1-style numeric id list.
 */
export const xUserFollowingSkill = {
    price_usd: 0.005,
    async run(input, ctx) {
        const { username, ids_only = false, stringify_ids = false, count, cursor, } = (input ?? {});
        if (!username)
            throw new Error("missing 'username'");
        ctx.report({
            stage: "launching",
            percent: 10,
            note: `user-following @${username}${ids_only ? " (ids_only)" : ""}`,
        });
        let pct = 15;
        const t = setInterval(() => {
            pct = Math.min(80, pct + 10);
            ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
        }, 1500);
        let raw;
        try {
            raw = await bnbotXUserFollowing({ username, count, cursor });
        }
        finally {
            clearInterval(t);
        }
        ctx.report({ stage: "parsing", percent: 95 });
        const users = raw.users;
        if (ids_only) {
            return userIdsToTwitter283(users, raw.next_cursor, { stringify_ids });
        }
        return userListToTwitter283(users, raw.next_cursor);
    },
};
