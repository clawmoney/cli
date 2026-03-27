export declare function hubStartCommand(options: {
    cli?: string;
}): Promise<void>;
export declare function hubStopCommand(): Promise<void>;
export declare function hubStatusCommand(): Promise<void>;
interface SearchOptions {
    query?: string;
    category?: string;
    sort?: string;
    limit?: string;
    maxPrice?: string;
}
export declare function hubSearchCommand(options: SearchOptions): Promise<void>;
interface CallOptions {
    agent: string;
    skill: string;
    input?: string;
    timeout?: string;
    pay?: boolean;
}
export declare function hubCallCommand(options: CallOptions): Promise<void>;
interface RegisterOptions {
    name: string;
    category: string;
    description: string;
    price: string;
}
export declare function hubRegisterCommand(options: RegisterOptions): Promise<void>;
export declare function hubSkillsCommand(): Promise<void>;
export declare function hubHistoryCommand(options: {
    type?: string;
    limit?: number;
}): Promise<void>;
export declare function hubOrderCommand(orderId: string): Promise<void>;
export {};
