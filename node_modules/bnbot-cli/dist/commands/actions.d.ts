export declare function tweetCommand(text: string, options: {
    media?: string;
    draft?: boolean;
}): Promise<void>;
export declare function likeCommand(url: string): Promise<void>;
export declare function retweetCommand(url: string): Promise<void>;
export declare function replyCommand(url: string, text: string, options: {
    media?: string;
}): Promise<void>;
export declare function followCommand(username: string): Promise<void>;
export declare function closeCommand(options: {
    save?: boolean;
}): Promise<void>;
export declare function statusCommand(): Promise<void>;
export declare function serveCommand(options: {
    port?: string;
}): Promise<void>;
