import { bnbotRDTopPostsByUsername } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";
export const rdTopPostsByUsernameSkill = makeRedditSkill("reddit top posts by username", (i) => bnbotRDTopPostsByUsername({
    username: reqStr(i, ["username", "user"], "username"),
    time: str(i, ["time", "t"]),
    limit: num(i, ["limit", "count"]),
}));
