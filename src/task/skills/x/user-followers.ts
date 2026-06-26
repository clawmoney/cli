import type { SkillHandler } from "../../types.js";
import { bnbotXUserFollowers } from "./_bnbot.js";
import {
  userListToTwitter283,
  userIdsToTwitter283,
  type BnbotUserListEntry,
} from "./_mapper.js";

/**
 * `x.user_followers` — backs /UserFollowers, /UserVerifiedFollowers,
 * /FollowersIds. Hub-side resolves user_id → username before
 * invoking. `verified_only` filters to blue-verified users only;
 * `ids_only` collapses output to a flat id-list envelope (with
 * optional `stringify_ids`).
 */
export const xUserFollowersSkill: SkillHandler = {
  price_usd: 0.0001,
  async run(input, ctx) {
    const {
      username,
      verified_only = false,
      ids_only = false,
      stringify_ids = false,
      count,
      cursor,
    } = (input ?? {}) as {
      username?: string;
      verified_only?: boolean;
      ids_only?: boolean;
      stringify_ids?: boolean;
      count?: number;
      cursor?: string;
    };
    if (!username) throw new Error("missing 'username'");

    ctx.report({
      stage: "launching",
      percent: 10,
      note: `user-followers @${username}${ids_only ? " (ids_only)" : ""}`,
    });

    let pct = 15;
    const t = setInterval(() => {
      pct = Math.min(80, pct + 10);
      ctx.report({ stage: "scraping", percent: pct, note: "bnbot working..." });
    }, 1500);
    let raw: { users: unknown[]; next_cursor: string | null };
    try {
      raw = await bnbotXUserFollowers({ username, count, cursor });
    } finally {
      clearInterval(t);
    }

    ctx.report({ stage: "parsing", percent: 95 });
    const users = raw.users as BnbotUserListEntry[];
    if (ids_only) {
      // /FollowersIds path — only verified filter is irrelevant
      // there, but if the buyer asks, apply it before flattening.
      const filtered = verified_only ? users.filter((u) => !!u.verified) : users;
      return userIdsToTwitter283(filtered, raw.next_cursor, {
        stringify_ids,
      });
    }
    return userListToTwitter283(users, raw.next_cursor, { verified_only });
  },
};
