export interface LimitArgs {
    limit?: number;
}
export interface SortTimeLimitArgs extends LimitArgs {
    sort?: string;
    time?: string;
}
export interface CountryArgs extends SortTimeLimitArgs {
    country: string;
}
export interface SubredditArgs extends SortTimeLimitArgs {
    subreddit: string;
}
export interface UsernameArgs extends SortTimeLimitArgs {
    username: string;
}
export interface UserSubredditArgs extends LimitArgs {
    username: string;
    subreddit: string;
    sort?: string;
}
export interface QueryArgs extends SortTimeLimitArgs {
    query: string;
    subreddit?: string;
}
export interface PostUrlArgs extends LimitArgs {
    post_url: string;
    sort?: string;
}
export declare function bnbotRDPopularPosts(a: SortTimeLimitArgs): Promise<unknown>;
export declare function bnbotRDTopPopularPosts(a: SortTimeLimitArgs): Promise<unknown>;
export declare function bnbotRDRisingPopularPosts(a: LimitArgs): Promise<unknown>;
export declare function bnbotRDBestPopularPosts(a: LimitArgs): Promise<unknown>;
export declare function bnbotRDPopularPostsByCountry(a: CountryArgs): Promise<unknown>;
export declare function bnbotRDPostsBySubreddit(a: SubredditArgs): Promise<unknown>;
export declare function bnbotRDTopPostsBySubreddit(a: SubredditArgs): Promise<unknown>;
export declare function bnbotRDControversialPostsBySubreddit(a: SubredditArgs): Promise<unknown>;
export declare function bnbotRDCommentsBySubreddit(a: SubredditArgs): Promise<unknown>;
export declare function bnbotRDSubredditInfo(subreddit: string): Promise<unknown>;
export declare function bnbotRDSubredditRules(subreddit: string): Promise<unknown>;
export declare function bnbotRDSimilarSubreddits(a: SubredditArgs): Promise<unknown>;
export declare function bnbotRDNewSubreddits(a: LimitArgs): Promise<unknown>;
export declare function bnbotRDPopularSubreddits(a: LimitArgs): Promise<unknown>;
export declare function bnbotRDPostsByUsername(a: UsernameArgs): Promise<unknown>;
export declare function bnbotRDTopPostsByUsername(a: UsernameArgs): Promise<unknown>;
export declare function bnbotRDCommentsByUsername(a: UsernameArgs): Promise<unknown>;
export declare function bnbotRDTopCommentsByUsername(a: UsernameArgs): Promise<unknown>;
export declare function bnbotRDUserOverview(a: UsernameArgs): Promise<unknown>;
export declare function bnbotRDUserPostRankInSubreddit(a: UserSubredditArgs): Promise<unknown>;
export declare function bnbotRDProfile(username: string): Promise<unknown>;
export declare function bnbotRDUserStats(username: string): Promise<unknown>;
export declare function bnbotRDSearchUsers(a: QueryArgs): Promise<unknown>;
export declare function bnbotRDSearchPosts(a: QueryArgs): Promise<unknown>;
export declare function bnbotRDSearchSubreddits(a: QueryArgs): Promise<unknown>;
export declare function bnbotRDPostDetails(a: PostUrlArgs): Promise<unknown>;
export declare function bnbotRDPostComments(a: PostUrlArgs): Promise<unknown>;
export declare function bnbotRDPostCommentsWithSort(a: PostUrlArgs): Promise<unknown>;
export declare function bnbotRDPostDuplicates(a: PostUrlArgs): Promise<unknown>;
