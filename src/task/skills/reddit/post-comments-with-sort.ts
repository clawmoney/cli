import { bnbotRDPostCommentsWithSort } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";

export const rdPostCommentsWithSortSkill = makeRedditSkill("reddit post comments with sort", (i) =>
  bnbotRDPostCommentsWithSort({
    post_url: reqStr(i, ["post_url", "postUrl", "url", "postId", "id"], "post_url"),
    sort: str(i, ["sort"]),
    limit: num(i, ["limit", "count"]),
  }));
