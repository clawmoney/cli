interface CodexImage {
    path?: string;
    mime?: string;
    width?: number;
    height?: number;
    bytes?: number;
    [key: string]: unknown;
}
interface CodexImageResult {
    images?: CodexImage[];
    [key: string]: unknown;
}
export declare function uploadCodexImageResult(raw: unknown): Promise<CodexImageResult>;
export {};
