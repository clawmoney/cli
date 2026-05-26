interface MediaItem {
    path?: string;
    mime?: string;
    width?: number;
    height?: number;
    bytes?: number;
    [key: string]: unknown;
}
interface MediaResult {
    images?: MediaItem[];
    videos?: MediaItem[];
    [key: string]: unknown;
}
export declare function uploadCodexImageResult(raw: unknown): Promise<MediaResult>;
export declare function uploadMediaResult(raw: unknown, collectionKey: "images" | "videos"): Promise<MediaResult>;
export {};
