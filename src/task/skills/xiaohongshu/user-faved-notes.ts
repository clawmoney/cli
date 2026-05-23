import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill } from "./_skill.js";
export const xhsUserFavedNotesSkill = makeXhsSkill("xhs user faved notes", () => bnbotXHS("user-faved-notes"));
