import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, num, str } from "./_skill.js";
export const xhsNoteCommentsSkill = makeXhsSkill("xhs note comments", (i) => bnbotXHS("note-comments", [], { index: num(i, ["index"]), cursor: str(i, ["cursor"]), note_id: str(i, ["note_id", "noteId"]), share_text: str(i, ["share_text", "shareText"]), sort_strategy: str(i, ["sort_strategy", "sortStrategy"]), limit: num(i, ["limit", "count"]) }));
