export interface LinkedInJobSearchArgs {
    query: string;
    limit?: number;
    location?: string;
    experienceLevel?: string;
    jobType?: string;
    datePosted?: string;
    remote?: string;
}
export declare function bnbotLIJobSearch(a: LinkedInJobSearchArgs): Promise<unknown>;
