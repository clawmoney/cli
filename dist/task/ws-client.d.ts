import type { HubFrame, ProviderFrame, TaskDaemonConfig } from "./types.js";
export type FrameCallback = (frame: HubFrame) => void;
/**
 * WebSocket client for the spareai-hub task protocol. Reconnects with
 * exponential backoff; emits heartbeats at the configured cadence so
 * the hub's KV skill_idx TTL stays fresh. Decoupled from the daemon's
 * skill-handling logic — frames in, frames out.
 */
export declare class TaskWsClient {
    private readonly config;
    private readonly onFrame;
    private ws;
    private heartbeatTimer;
    private reconnectTimer;
    private reconnectDelayMs;
    private stopping;
    private _connected;
    constructor(config: TaskDaemonConfig, onFrame: FrameCallback);
    get connected(): boolean;
    start(): void;
    stop(): void;
    send(frame: ProviderFrame): boolean;
    private connect;
    private buildUrl;
    private scheduleReconnect;
    private startHeartbeat;
    private stopHeartbeat;
    private clearTimers;
}
