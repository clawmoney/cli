import { bnbotRDProfile } from "./_bnbot.js";
import { makeRedditSkill, reqStr } from "./_skill.js";
export const rdProfileSkill = makeRedditSkill("reddit profile", (i) => bnbotRDProfile(reqStr(i, ["username", "user"], "username")));
