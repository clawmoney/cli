export interface CodexImageGenerateArgs {
    prompt: string;
    size?: string;
    response_format?: string;
    timeout?: number;
    fresh?: boolean;
}
export declare function bnbotCodexImageGenerate(input: CodexImageGenerateArgs): Promise<unknown>;
