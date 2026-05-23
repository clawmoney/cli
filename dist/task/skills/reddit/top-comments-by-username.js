import { bnbotRDTopCommentsByUsername } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";
export const rdTopCommentsByUsernameSkill = makeRedditSkill("reddit top comments by username", (i) => bnbotRDTopCommentsByUsername({
    username: reqStr(i, ["username", "user"], "username"),
    time: str(i, ["time", "t"]),
    limit: num(i, ["limit", "count"]),
}));
