import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, str } from "./_skill.js";
export const xhsTopicInfoSkill = makeXhsSkill("xhs topic info", (i) => bnbotXHS("topic-info", [], { source: str(i, ["source"]), page_id: str(i, ["page_id", "pageId"]) }));
