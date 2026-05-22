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
export declare function bnbotTTChallengeInfo(challengeName: string): Promise<unknown>;
export interface ChallengePostsArgs {
    challengeId: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTChallengePosts(a: ChallengePostsArgs): Promise<unknown>;
export declare function bnbotTTMusicInfo(musicId: string): Promise<unknown>;
export interface MusicPostsArgs {
    musicId: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTMusicPosts(a: MusicPostsArgs): Promise<unknown>;
export interface MusicUnlimitedArgs {
    page?: number;
    pageSize?: number;
    orderBy?: string;
}
export declare function bnbotTTMusicUnlimitedSounds(a?: MusicUnlimitedArgs): Promise<unknown>;
export declare function bnbotTTUserInfoRegion(uniqueId: string): Promise<unknown>;
export declare function bnbotTTUserInfoById(userId: string): Promise<unknown>;
export interface UserFollowingsArgs {
    user: string;
    limit?: number;
    max_time?: string;
}
export declare function bnbotTTUserFollowings(a: UserFollowingsArgs): Promise<unknown>;
export interface UserCursorArgs {
    user: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTUserLikedPosts(a: UserCursorArgs): Promise<unknown>;
export declare function bnbotTTUserPlaylist(a: UserCursorArgs): Promise<unknown>;
export declare function bnbotTTUserRepost(a: UserCursorArgs): Promise<unknown>;
export interface UserStoryArgs {
    userId: string;
    maxCursor?: string;
}
export declare function bnbotTTUserStory(a: UserStoryArgs): Promise<unknown>;
export interface QueryCursorArgs {
    query: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTSearchGeneral(a: QueryCursorArgs): Promise<unknown>;
export declare function bnbotTTSearchLive(a: QueryCursorArgs): Promise<unknown>;
export declare function bnbotTTSearchSuggestions(keyword: string): Promise<unknown>;
export interface PostRelatedArgs {
    video: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTPostRelated(a: PostRelatedArgs): Promise<unknown>;
export interface PostExploreArgs {
    limit?: number;
    categoryType?: string;
}
export declare function bnbotTTPostExplore(a?: PostExploreArgs): Promise<unknown>;
export interface PostDiscoverArgs {
    keyword: string;
    page?: number;
}
export declare function bnbotTTPostDiscover(a: PostDiscoverArgs): Promise<unknown>;
export declare function bnbotTTAdsDetail(adsId: string): Promise<unknown>;
export interface AdsTopArgs {
    page?: number;
    period?: number;
    limit?: number;
    country?: string;
    order_by?: string;
}
export declare function bnbotTTAdsTop(a?: AdsTopArgs): Promise<unknown>;
export interface TrendingCreatorArgs {
    page?: number;
    limit?: number;
    sort_by?: string;
    country?: string;
}
export declare function bnbotTTTrendingCreator(a?: TrendingCreatorArgs): Promise<unknown>;
export interface TrendingVideoArgs {
    page?: number;
    limit?: number;
    period?: number;
    order_by?: string;
    country?: string;
}
export declare function bnbotTTTrendingVideo(a?: TrendingVideoArgs): Promise<unknown>;
export interface TrendingHashtagArgs {
    page?: number;
    limit?: number;
    period?: number;
    country?: string;
    sort_by?: string;
}
export declare function bnbotTTTrendingHashtag(a?: TrendingHashtagArgs): Promise<unknown>;
export interface TrendingSongArgs {
    page?: number;
    limit?: number;
    period?: number;
    rank_type?: string;
    country?: string;
}
export declare function bnbotTTTrendingSong(a?: TrendingSongArgs): Promise<unknown>;
export interface TrendingKeywordArgs {
    page?: number;
    limit?: number;
    period?: number;
    country?: string;
}
export declare function bnbotTTTrendingKeyword(a?: TrendingKeywordArgs): Promise<unknown>;
export interface TrendingKeywordPostsArgs {
    keyword: string;
    country?: string;
    limit?: number;
    period?: number;
}
export declare function bnbotTTTrendingKeywordPosts(a: TrendingKeywordPostsArgs): Promise<unknown>;
export interface TrendingKeywordSentenceArgs {
    keyword: string;
    page?: number;
    limit?: number;
    period?: number;
    country?: string;
    order_type?: string;
}
export declare function bnbotTTTrendingKeywordSentence(a: TrendingKeywordSentenceArgs): Promise<unknown>;
export interface CommercialMusicArgs {
    page?: number;
    limit?: number;
    region?: string;
    scenarios?: number;
    duration?: number;
    placements?: string;
    themes?: string;
    genres?: string;
    moods?: string;
}
export declare function bnbotTTCommercialMusic(a?: CommercialMusicArgs): Promise<unknown>;
export interface CommercialPlaylistsArgs {
    limit?: number;
    region?: string;
}
export declare function bnbotTTCommercialPlaylists(a?: CommercialPlaylistsArgs): Promise<unknown>;
export interface CommercialPlaylistDetailArgs {
    playlist_id: string;
    page?: number;
    limit?: number;
    region?: string;
}
export declare function bnbotTTCommercialPlaylistDetail(a: CommercialPlaylistDetailArgs): Promise<unknown>;
export interface TopProductsArgs {
    page?: number;
    last?: number;
    order_by?: string;
    order_type?: string;
}
export declare function bnbotTTTopProducts(a?: TopProductsArgs): Promise<unknown>;
export declare function bnbotTTTopProductDetail(productId: string): Promise<unknown>;
export declare function bnbotTTTopProductMetrics(productId: string): Promise<unknown>;
export declare function bnbotTTPlaceInfo(placeId: string): Promise<unknown>;
export interface PlacePostsArgs {
    placeId: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTPlacePosts(a: PlacePostsArgs): Promise<unknown>;
export declare function bnbotTTEffectInfo(effectId: string): Promise<unknown>;
export interface EffectPostsArgs {
    effectId: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTEffectPosts(a: EffectPostsArgs): Promise<unknown>;
export declare function bnbotTTCollectionInfo(collectionId: string): Promise<unknown>;
export interface CollectionPostsArgs {
    collectionId: string;
    limit?: number;
}
export declare function bnbotTTCollectionPosts(a: CollectionPostsArgs): Promise<unknown>;
export interface PostCommentRepliesArgs {
    video: string;
    comment_id: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotTTPostCommentReplies(a: PostCommentRepliesArgs): Promise<unknown>;
