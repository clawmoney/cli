export interface AwalResult {
    success: boolean;
    data: Record<string, unknown>;
    raw: string;
}
/**
 * Execute an awal CLI command and parse the JSON output.
 * Always appends --json flag for machine-readable output.
 */
export declare function awalExec(args: string[]): Promise<AwalResult>;
/**
 * Execute an awal command that requires interactive stdin (e.g., for OTP).
 * Returns the parsed JSON output.
 */
export declare function awalExecInteractive(args: string[]): Promise<string>;
/**
 * Check if awal is installed and available.
 */
export declare function isAwalAvailable(): Promise<boolean>;
