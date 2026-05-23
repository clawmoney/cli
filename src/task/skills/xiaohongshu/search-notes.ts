import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, num, reqStr, str } from "./_skill.js";
export const xhsSearchNotesSkill = makeXhsSkill("xhs search notes", (i) => bnbotXHS("search-notes", [reqStr(i, ["keyword", "query"], "keyword")], { page: num(i, ["page"]), source: str(i, ["source"]), note_type: str(i, ["note_type", "noteType"]), sort_type: str(i, ["sort_type", "sortType"]), time_filter: str(i, ["time_filter", "timeFilter"]), limit: num(i, ["limit", "count"]) }));
