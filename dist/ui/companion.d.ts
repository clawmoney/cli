/** Start the companion if it isn't already running. Idempotent. */
export declare function ensureCompanionRunning(dashboardUrl?: string): Promise<void>;
/** Open (or focus) the companion window. */
export declare function openCompanion(dashboardUrl?: string): Promise<void>;
