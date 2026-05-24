export interface ChatGPTAskArgs {
    prompt: string;
    model?: string;
    timeout?: number;
    fresh?: boolean;
}
export declare function bnbotChatGPTAsk(input: ChatGPTAskArgs): Promise<unknown>;
