import { bnbotRDSearchUsers } from "./_bnbot.js";
import { makeRedditSkill, num, reqStr } from "./_skill.js";

export const rdSearchUsersSkill = makeRedditSkill("reddit search users", (i) =>
  bnbotRDSearchUsers({
    query: reqStr(i, ["query", "q"], "query"),
    limit: num(i, ["limit", "count"]),
  }));
