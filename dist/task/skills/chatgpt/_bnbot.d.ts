export interface ChatGPTAskArgs {
    prompt: string;
    model?: string;
    timeout?: number;
    fresh?: boolean;
}
export interface ChatGPTImageGenerateArgs {
    prompt: string;
    model?: string;
    size?: string;
    quality?: string;
    images?: string[];
    response_format?: string;
    timeout?: number;
    fresh?: boolean;
    restart?: boolean;
}
export interface ChatGPTWebImageGenerateArgs {
    prompt: string;
    n?: number;
    size?: string;
    quality?: string;
    images?: string[];
    response_format?: string;
    timeout?: number;
    tab_id?: string;
    url?: string;
    keep_chat?: boolean;
}
export declare function bnbotChatGPTAsk(input: ChatGPTAskArgs): Promise<unknown>;
export declare function bnbotChatGPTImageGenerate(input: ChatGPTImageGenerateArgs): Promise<unknown>;
export declare function bnbotChatGPTWebImageGenerate(input: ChatGPTWebImageGenerateArgs): Promise<unknown>;
