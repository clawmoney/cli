export declare function isYtDlpInstalled(): Promise<boolean>;
export interface BilibiliDownloadFormat {
    format_id: string;
    url: string;
    ext: string;
    mime_type: string;
    width: number;
    height: number;
    fps: number;
    bitrate: number;
    content_length: string;
    has_audio: boolean;
    has_video: boolean;
    vcodec: string;
    acodec: string;
    protocol: string;
}
export interface BilibiliDownloadResult {
    id: string;
    title: string;
    author: string;
    duration: number;
    thumbnail: string;
    webpage_url: string;
    best_video?: BilibiliDownloadFormat;
    best_audio?: BilibiliDownloadFormat;
    requested_formats: BilibiliDownloadFormat[];
    formats: BilibiliDownloadFormat[];
}
export declare function ytdlpBilibiliDownload(input: string): Promise<BilibiliDownloadResult>;
