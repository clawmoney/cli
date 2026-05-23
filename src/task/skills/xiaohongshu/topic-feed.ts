import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, str } from "./_skill.js";
export const xhsTopicFeedSkill = makeXhsSkill("xhs topic feed", (i) => bnbotXHS("topic-feed", [], { sort: str(i, ["sort"]), source: str(i, ["source"]), page_id: str(i, ["page_id", "pageId"]) }));
