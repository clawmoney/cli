/**
 * yt-dlp shell-out helpers for YouTube data that the chrome-extension
 * path can't reach reliably.
 *
 * Why: in 2026 YouTube's anti-automation gates (page-load JS challenge,
 * pot/proof-of-token, /youtubei/v1 precondition checks) reject our
 * page-context POSTs and our window.fetch overrides for endpoints like
 * /get_transcript. yt-dlp ships a maintained workaround stack (deno
 * JS challenge solver, jsinterp, PO token providers) that has stayed
 * one step ahead of these gates. Shell-out keeps spareai itself out
 * of the JS-reverse-engineering arms race.
 *
 * Install on the provider host:
 *   brew install yt-dlp     (mac)
 *   pipx install yt-dlp     (linux)
 *   pip install yt-dlp deno (if jsinterp needed; usually optional)
 */
/** Returns true iff `yt-dlp` is on PATH and exits 0 to `--version`. */
export declare function isYtDlpInstalled(): Promise<boolean>;
export interface TranscriptLine {
    start: number;
    duration: number;
    text: string;
}
export interface TranscriptResult {
    id: string;
    language: string;
    language_code: string;
    is_translatable: boolean;
    lines: TranscriptLine[];
}
/**
 * Fetch a video's transcript using yt-dlp. Prefers human-uploaded
 * captions for the requested lang, then auto-generated for the
 * requested lang, then human English, then auto-generated English.
 *
 * Throws if yt-dlp isn't installed or no transcript exists.
 */
export declare function ytdlpTranscript(videoId: string, langPref?: string): Promise<TranscriptResult>;
export interface StreamingFormat {
    itag: number;
    url: string;
    mime_type: string;
    bitrate: number;
    width: number;
    height: number;
    fps: number;
    quality: string;
    quality_label: string;
    audio_quality: string;
    audio_sample_rate: string;
    audio_channels: number;
    approx_duration_ms: string;
    content_length: string;
    signature_cipher: string;
    has_audio: boolean;
    has_video: boolean;
}
export interface StreamingDataResult {
    id: string;
    expires_in_seconds: string;
    formats: StreamingFormat[];
    adaptive_formats: StreamingFormat[];
    hls_manifest_url: string;
    dash_manifest_url: string;
}
/**
 * Fetch a video's streaming formats (download URLs + manifests) via
 * yt-dlp.
 *
 * The browser-context fallback was unreliable because YouTube returns
 * stub data for the target video on hooked sessions (it serves real
 * data only for the autoplay-preloaded *next* video). yt-dlp solves
 * the JS challenge / PO token machinery and impersonates an ANDROID_VR
 * client which YouTube currently lets through.
 */
export declare function ytdlpStreamingData(videoId: string): Promise<StreamingDataResult>;
