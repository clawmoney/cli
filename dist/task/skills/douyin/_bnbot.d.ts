export declare function bnbotDYUserInfo(secUid: string): Promise<unknown>;
export interface UserCursorArgs {
    secUid: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotDYUserPosts(a: UserCursorArgs): Promise<unknown>;
export declare function bnbotDYUserLiked(a: UserCursorArgs): Promise<unknown>;
export interface UserMaxTimeArgs {
    secUid: string;
    limit?: number;
    max_time?: string;
}
export declare function bnbotDYUserFollowers(a: UserMaxTimeArgs): Promise<unknown>;
export declare function bnbotDYUserFollowing(a: UserMaxTimeArgs): Promise<unknown>;
export interface PostCommentsArgs {
    video: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotDYPostComments(a: PostCommentsArgs): Promise<unknown>;
export interface PostCommentRepliesArgs {
    video: string;
    commentId: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotDYPostCommentReplies(a: PostCommentRepliesArgs): Promise<unknown>;
export interface SearchOffsetArgs {
    query: string;
    limit?: number;
    offset?: number;
}
export declare function bnbotDYSearchGeneral(a: SearchOffsetArgs): Promise<unknown>;
export declare function bnbotDYSearchVideo(a: SearchOffsetArgs): Promise<unknown>;
export interface SearchCursorArgs {
    query: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotDYSearchAccount(a: SearchCursorArgs): Promise<unknown>;
export declare function bnbotDYSearchLive(a: SearchOffsetArgs): Promise<unknown>;
export interface ChallengePostsArgs {
    hashtag: string;
    limit?: number;
    offset?: number;
}
export declare function bnbotDYChallengePosts(a: ChallengePostsArgs): Promise<unknown>;
export interface MusicPostsArgs {
    musicId: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotDYMusicPosts(a: MusicPostsArgs): Promise<unknown>;
