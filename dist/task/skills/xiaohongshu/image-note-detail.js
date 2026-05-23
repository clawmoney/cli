import { bnbotXHS } from "./_bnbot.js";
import { makeXhsSkill, str } from "./_skill.js";
export const xhsImageNoteDetailSkill = makeXhsSkill("xhs image note detail", (i) => bnbotXHS("image-note-detail", [], { note_id: str(i, ["note_id", "noteId"]), share_text: str(i, ["share_text", "shareText"]) }));
