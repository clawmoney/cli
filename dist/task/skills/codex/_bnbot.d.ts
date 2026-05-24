export interface CodexImageGenerateArgs {
    prompt: string;
    size?: string;
    quality?: string;
    images?: string[];
    response_format?: string;
    timeout?: number;
    fresh?: boolean;
}
export declare function bnbotCodexImageGenerate(input: CodexImageGenerateArgs): Promise<unknown>;
