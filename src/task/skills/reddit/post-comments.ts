import { bnbotRDPostComments } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr } from "./_skill.js";

export const rdPostCommentsSkill = makeRedditSkill("reddit post comments", (i) =>
  bnbotRDPostComments({
    post_url: reqStr(i, ["post_url", "postUrl", "url", "postId", "id"], "post_url"),
    limit: num(i, ["limit", "count"]),
  }));
