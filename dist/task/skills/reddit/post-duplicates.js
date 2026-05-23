import { bnbotRDPostDuplicates } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr } from "./_skill.js";
export const rdPostDuplicatesSkill = makeRedditSkill("reddit post duplicates", (i) => bnbotRDPostDuplicates({
    post_url: reqStr(i, ["post_url", "postUrl", "url", "postId", "id"], "post_url"),
    limit: num(i, ["limit", "count"]),
}));
