/**
 * Prompt the user for input via stdin.
 */
export declare function prompt(question: string): Promise<string>;
/**
 * Prompt for a yes/no confirmation.
 */
export declare function confirm(question: string, defaultYes?: boolean): Promise<boolean>;
