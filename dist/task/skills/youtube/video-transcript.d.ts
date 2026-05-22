import type { SkillHandler } from "../../types.js";
/**
 * Fetch a YouTube video's transcript.
 *
 * Primary: yt-dlp. YouTube's transcript endpoint sits behind several
 * anti-automation gates (JS challenge, pot/proof-of-token, /youtubei
 * precondition checks) that reject our browser-based interception.
 * yt-dlp maintains the workarounds for these, so we shell out to it.
 *
 * Fallback: bnbot extension (the old INTERCEPT path). Only useful for
 * legacy bnbot hosts that haven't installed yt-dlp yet — kept so we
 * don't return an outright error during the rollout window.
 */
export declare const ytVideoTranscriptSkill: SkillHandler;
