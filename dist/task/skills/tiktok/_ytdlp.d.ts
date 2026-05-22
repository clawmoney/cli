/**
 * yt-dlp shell-out helpers for TikTok video downloads.
 *
 * Why yt-dlp: TikTok's signed playAddr URLs rotate frequently, expire
 * quickly, and (more importantly) bake in a visible watermark. yt-dlp
 * walks the (currently) watermark-free `aweme/v1/feed` API path that
 * mobile clients use, so the returned `url` field is suitable for
 * direct download without re-encoding.
 *
 * Install:
 *   brew install yt-dlp     (mac)
 *   pipx install yt-dlp     (linux)
 */
/** Returns true iff `yt-dlp` is on PATH and exits 0 to `--version`. */
export declare function isYtDlpInstalled(): Promise<boolean>;
export interface TikTokDownloadFormat {
    itag: number;
    url: string;
    mime_type: string;
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    content_length: string;
    has_audio: boolean;
    has_video: boolean;
}
export interface TikTokDownloadResult {
    id: string;
    title: string;
    author: string;
    duration: number;
    formats: TikTokDownloadFormat[];
}
/**
 * Fetch a TikTok video's download formats. TikTok typically returns
 * a single muxed mp4 + a separate audio track — far fewer formats
 * than YouTube, so the `formats` array is usually 1-2 entries.
 *
 * Throws if yt-dlp isn't installed or the video can't be resolved.
 */
export declare function ytdlpTikTokVideo(videoIdOrUrl: string): Promise<TikTokDownloadResult>;
export interface TikTokVideoSummary {
    id: string;
    url: string;
    desc: string;
    author: string;
    authorName: string;
    createTime: number;
    duration: number;
    cover: string;
    hashtags: string[];
    music: string;
    plays: number;
    likes: number;
    comments: number;
    shares: number;
    collects: number;
}
export interface TikTokUserPostsResult {
    videos: TikTokVideoSummary[];
    cursor: string;
    has_more: boolean;
}
export declare function ytdlpTikTokUserPosts(handleOrUrl: string, limit?: number): Promise<TikTokUserPostsResult>;
export interface TikTokPostDetail {
    id: string;
    url: string;
    desc: string;
    author: string;
    authorName: string;
    createTime: number;
    duration: number;
    cover: string;
    hashtags: string[];
    music: string;
    plays: number;
    likes: number;
    comments: number;
    shares: number;
    collects: number;
    width: number;
    height: number;
    ratio: string;
    music_id: string;
    music_url: string;
    video_url: string;
}
export declare function ytdlpTikTokPostDetail(videoIdOrUrl: string): Promise<TikTokPostDetail>;
export interface TikTokMusicDownloadResult {
    video_id: string;
    music_url: string;
    music_format: string;
    music_title: string;
    music_author: string;
}
export declare function ytdlpTikTokMusicDownload(videoUrl: string): Promise<TikTokMusicDownloadResult>;
export interface TikTokUserBatchVideo {
    id: string;
    url: string;
    video_url: string;
    cover: string;
    title: string;
    duration: number;
}
export interface TikTokUserBatchDownloadResult {
    user: string;
    total_videos: number;
    videos: TikTokUserBatchVideo[];
}
export declare function ytdlpTikTokUserBatchDownload(handleOrUrl: string, opts?: {
    limit?: number;
}): Promise<TikTokUserBatchDownloadResult>;
