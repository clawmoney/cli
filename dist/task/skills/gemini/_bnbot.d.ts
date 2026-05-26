export interface GeminiImageGenerateArgs {
    prompt: string;
    aspectRatio?: string;
    imageSize?: string;
    quality?: string;
    images?: string[];
    response_format?: string;
    timeout?: number;
}
export declare function bnbotGeminiImageGenerate(input: GeminiImageGenerateArgs): Promise<unknown>;
