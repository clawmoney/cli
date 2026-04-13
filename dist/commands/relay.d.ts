interface RegisterOptions {
    cli: string;
    model: string;
    mode?: string;
    concurrency?: string;
    dailyLimit?: string;
    priceInput?: string;
    priceOutput?: string;
}
export declare function relayRegisterCommand(options: RegisterOptions): Promise<void>;
export declare function relayStartCommand(options: {
    cli?: string;
}): Promise<void>;
export declare function relayStopCommand(): Promise<void>;
export declare function relayLogsCommand(options: {
    follow?: boolean;
    lines?: string;
}): Promise<void>;
export declare function relayStatusCommand(): Promise<void>;
export declare function relayModelsCommand(): Promise<void>;
export {};
