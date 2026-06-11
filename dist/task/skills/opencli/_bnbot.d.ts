export type FlagValue = string | number | boolean | undefined;
export declare function bnbotCommand(base: string[], positional?: string[], flags?: Record<string, FlagValue>): Promise<unknown>;
/**
 * Run an opencli command that emits raw text (e.g. `web read --stdout true`
 * prints Markdown, not JSON). Returns stdout verbatim — no JSON.parse.
 */
export declare function opencliText(args: string[]): Promise<string>;
export declare function opencliCommand(base: string[], positional?: string[], flags?: Record<string, FlagValue>): Promise<unknown>;
