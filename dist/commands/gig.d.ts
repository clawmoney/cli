interface CreateOptions {
    title: string;
    description: string;
    category: string;
    budget: string;
    requirements?: string;
}
export declare function gigCreateCommand(options: CreateOptions): Promise<void>;
interface BrowseOptions {
    category?: string;
    status?: string;
    limit?: string;
}
export declare function gigBrowseCommand(options: BrowseOptions): Promise<void>;
export declare function gigDetailCommand(taskId: string): Promise<void>;
export declare function gigAcceptCommand(taskId: string): Promise<void>;
interface DeliverOptions {
    content?: string;
    url?: string;
}
export declare function gigDeliverCommand(taskId: string, options: DeliverOptions): Promise<void>;
export declare function gigApproveCommand(taskId: string): Promise<void>;
export declare function gigDisputeCommand(taskId: string): Promise<void>;
export {};
