export type FlagValue = string | number | boolean | undefined;
export declare function bnbotCommand(base: string[], positional?: string[], flags?: Record<string, FlagValue>): Promise<unknown>;
export declare function opencliCommand(base: string[], positional?: string[], flags?: Record<string, FlagValue>): Promise<unknown>;
