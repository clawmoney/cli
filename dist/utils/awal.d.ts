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
/**
 * Kill a wedged awal server process using the pattern documented in
 * clawmoney-skill's SKILL.md. Reads the pid from `awal status --json`
 * and SIGKILLs it. Safe to call even when awal isn't running (the
 * inner command fails, kill -9 gets nothing, we swallow both).
 *
 * awal's Electron "Payments MCP" wrapper occasionally wedges on
 * macOS (GPU render hang, stdin/stdout pipe full, or upstream
 * Coinbase MCP endpoint unreachable). A hard kill lets the next
 * `awal status` cold-start a fresh process.
 */
export declare function killAwal(): Promise<void>;
/**
 * Execute an awal command with timeout + one automatic retry on
 * failure. On the first failure we kill any wedged awal process
 * (using the SKILL-documented kill pattern) and re-run.
 *
 * Safe ONLY for READ operations (status, address, balance, etc).
 * Do NOT use for writes (send, x402 pay, auth verify) — those
 * either cost money twice on retry, or consume a single-use OTP
 * and fail the second time. For writes, use awalExec directly
 * and let the failure surface to the user.
 */
export declare function awalExecSafe(args: string[], opts?: {
    timeoutMs?: number;
}): Promise<AwalResult>;
