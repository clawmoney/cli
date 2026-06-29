/** Returns the companion PID if it's alive, else null. */
export declare function getCompanionPid(): number | null;
/** Send one request to the companion and await its response. */
export declare function sendIpc<T = unknown>(channel: string, data?: unknown, timeoutMs?: number): Promise<T>;
