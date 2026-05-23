import { bnbotRDPostsByUsername } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr, str } from "./_skill.js";

export const rdPostsByUsernameSkill = makeRedditSkill("reddit posts by username", (i) =>
  bnbotRDPostsByUsername({
    username: reqStr(i, ["username", "user"], "username"),
    sort: str(i, ["sort"]),
    time: str(i, ["time", "t"]),
    limit: num(i, ["limit", "count"]),
  }));
