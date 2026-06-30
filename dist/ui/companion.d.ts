/** Start the companion if it isn't already running. Idempotent. */
export declare function ensureCompanionRunning(dashboardUrl?: string): Promise<void>;
/** Open the menu-bar UI: the installed Desktop app if present, else the companion. */
export declare function openCompanion(dashboardUrl?: string): Promise<'desktop' | 'companion'>;
