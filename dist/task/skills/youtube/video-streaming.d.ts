import type { SkillHandler } from "../../types.js";
/**
 * Fetch a video's downloadable streams (mp4 / webm / audio-only) +
 * manifest URLs.
 *
 * Primary: yt-dlp. YouTube returns stub /youtubei/v1/player responses
 * for the target video when a chrome.debugger session is attached
 * (the autoplay-preloaded NEXT video gets real data, but that's the
 * wrong video for the buyer). yt-dlp goes through the ANDROID_VR
 * client path which still receives real streaming URLs.
 *
 * Fallback: bnbot extension's ytInitialPlayerResponse path. Returns
 * format metadata (mime, dimensions, itag) but URLs are empty since
 * YouTube strips them — kept only for hosts without yt-dlp.
 */
export declare const ytVideoStreamingSkill: SkillHandler;
