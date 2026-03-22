interface BrowseOptions {
    type?: string;
    status?: string;
    limit?: string;
}
export declare function browseCommand(options: BrowseOptions): Promise<void>;
export {};
