export declare function bnbotYTVideoDetails(idOrUrl: string): Promise<unknown>;
export declare function bnbotYTChannelDetails(idOrHandle: string): Promise<unknown>;
export interface ChannelVideosArgs {
    id: string;
    filter?: string;
    limit?: number;
    cursor?: string;
}
export declare function bnbotYTChannelVideos(a: ChannelVideosArgs): Promise<unknown>;
export declare function bnbotYTTrending(limit?: number): Promise<unknown>;
export declare function bnbotYTChannelSearch(channelId: string, query: string, limit?: number): Promise<unknown>;
export declare function bnbotYTStreamingData(idOrUrl: string): Promise<unknown>;
export declare function bnbotYTRelated(idOrUrl: string, limit?: number): Promise<unknown>;
export declare function bnbotYTComments(idOrUrl: string, limit?: number): Promise<unknown>;
export declare function bnbotYTTranscript(idOrUrl: string, lang?: string): Promise<unknown>;
