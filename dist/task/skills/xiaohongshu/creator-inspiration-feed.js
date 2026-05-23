import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, str } from "./_skill.js";
export const xhsCreatorInspirationFeedSkill = makeXhsSkill("xhs creator inspiration feed", (i) => bnbotXHS("creator-inspiration-feed", [], { source: str(i, ["source"]) }));
