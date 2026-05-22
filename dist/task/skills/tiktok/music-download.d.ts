import type { SkillHandler } from "../../types.js";
/**
 * Fetch a TikTok video's bare audio track (the music/sound layer).
 *
 * yt-dlp only — same reasoning as `tk.video_download`. TikTok's web
 * playAddr URLs include the user's voiceover; the audio-only format in
 * yt-dlp's `formats[]` is the underlying music stream. We don't
 * re-encode (no `--extract-audio --audio-format mp3`); the buyer gets
 * the raw stream URL + ext, and can transcode locally if they want mp3.
 */
export declare const tkMusicDownloadSkill: SkillHandler;
