export interface SearchArgs {
    q: string;
    type?: string;
    count?: number;
    safe_search?: boolean;
    cursor?: string;
    /** Extra bnbot filter args, e.g. ["--has", "images", "--from", "solana"] */
    extra?: string[];
}
export declare function bnbotXSearch(args: SearchArgs): Promise<unknown[]>;
export declare function bnbotXUserProfile(username: string): Promise<unknown>;
export interface UserTweetsArgs {
    username: string;
    count?: number;
    cursor?: string;
    /** When provided, restrict to tweets matching the mode. We do this
     *  client-side because bnbot CLI doesn't accept these flags
     *  directly on `x scrape user-tweets`. */
    mode?: "tweets" | "replies" | "media";
}
export declare function bnbotXUserTweets(args: UserTweetsArgs): Promise<unknown[]>;
export declare function bnbotXThread(tweetId: string): Promise<unknown[]>;
