import { bnbotBili } from "./_bnbot.js";
import { makeBilibiliSkill, num, reqStr } from "./_skill.js";
export const biliFollowingSkill = makeBilibiliSkill("bilibili following", (i) => {
    const uid = reqStr(i, ["uid", "mid", "user"], "uid");
    return bnbotBili("following", [uid], { page: num(i, ["page"]), limit: num(i, ["limit", "count"]) });
});
