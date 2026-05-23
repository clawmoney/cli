import { bnbotRDPostDetails } from "./_bnbot.js";
import { makeRedditSkill, reqStr } from "./_skill.js";

export const rdPostDetailsSkill = makeRedditSkill("reddit post details", (i) =>
  bnbotRDPostDetails({ post_url: reqStr(i, ["post_url", "postUrl", "url", "postId", "id"], "post_url") }));
