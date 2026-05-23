import { bnbotRDCommentsByUsername } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";

export const rdCommentsByUsernameSkill = makeRedditSkill("reddit comments by username", (i) =>
  bnbotRDCommentsByUsername({
    username: reqStr(i, ["username", "user"], "username"),
    sort: str(i, ["sort"]),
    time: str(i, ["time", "t"]),
    limit: num(i, ["limit", "count"]),
  }));
