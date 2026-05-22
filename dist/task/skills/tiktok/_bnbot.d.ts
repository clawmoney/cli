export declare function bnbotTTSearchVideo(query: string, limit?: number): Promise<unknown>;
export declare function bnbotTTSearchAccount(query: string, limit?: number): Promise<unknown>;
export declare function bnbotTTUserInfo(uniqueId: string): Promise<unknown>;
export interface UserPostsArgs {
    user: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTUserPosts(a: UserPostsArgs): Promise<unknown>;
export interface UserFollowersArgs {
    user: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTUserFollowers(a: UserFollowersArgs): Promise<unknown>;
export declare function bnbotTTPostDetail(video: string): Promise<unknown>;
export interface PostCommentsArgs {
    video: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTPostComments(a: PostCommentsArgs): Promise<unknown>;
export declare function bnbotTTTrending(limit?: number): Promise<unknown>;
