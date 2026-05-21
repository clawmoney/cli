import type { SkillHandler } from "../../types.js";
/** Fetch a YouTube video's transcript (auto-generated or human
 *  captions, depending on availability). Reads
 *  ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer
 *  via the bnbot extension, then fetches and parses the timedtext
 *  baseUrl. Returns an array of {start, duration, text} segments. */
export declare const ytVideoTranscriptSkill: SkillHandler;
