interface TweetOptions {
    media?: string;
    draft?: boolean;
}
/**
 * Post a tweet by delegating to @bnbot/cli.
 */
export declare function tweetCommand(text: string, options: TweetOptions): Promise<void>;
export {};
