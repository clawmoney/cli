/**
 * Bridge — WebSocket server + client for Chrome Extension communication.
 * Auto-starts server if none running, waits for extension to connect.
 */
export declare class BridgeServer {
    private wss;
    private extensionClient;
    private pendingRequests;
    private extensionVersion;
    private port;
    constructor(port?: number);
    start(): Promise<void>;
    private handleMessage;
    stop(): void;
    isExtensionConnected(): boolean;
    getExtensionVersion(): string | null;
    getPort(): number;
}
/**
 * Send an action to the Chrome Extension.
 * Auto-starts bridge if needed, waits for extension connection.
 */
export declare function sendAction(actionType: string, params: Record<string, unknown>, port?: number): Promise<{
    success: boolean;
    data?: unknown;
    error?: string;
}>;
