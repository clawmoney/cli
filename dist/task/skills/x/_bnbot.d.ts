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
export interface TrendsArgs {
    woeid?: number;
    limit?: number;
}
export declare function bnbotXTrends(args?: TrendsArgs): Promise<unknown[]>;
export interface UserListArgs {
    username: string;
    count?: number;
    cursor?: string;
}
export interface BnbotUserListResult {
    users: unknown[];
    next_cursor: string | null;
}
export declare function bnbotXUserFollowers(args: UserListArgs): Promise<BnbotUserListResult>;
export declare function bnbotXUserFollowing(args: UserListArgs): Promise<BnbotUserListResult>;
export interface TweetListArgs {
    tweet_id: string;
    count?: number;
    cursor?: string;
}
export declare function bnbotXTweetLikers(args: TweetListArgs): Promise<BnbotUserListResult>;
export declare function bnbotXTweetRetweeters(args: TweetListArgs): Promise<BnbotUserListResult>;
export declare function bnbotXTweetArticle(tweetId: string): Promise<unknown>;
