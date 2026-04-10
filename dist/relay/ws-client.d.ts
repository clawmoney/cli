import type { RelayProviderConfig, RelayIncomingEvent, RelayOutgoingEvent } from "./types.js";
export type RelayEventCallback = (event: RelayIncomingEvent) => void;
export declare class RelayWsClient {
    private config;
    private onEvent;
    private ws;
    private heartbeatTimer;
    private reconnectDelay;
    private reconnectTimer;
    private _connected;
    private wsFailLogged;
    private stopping;
    constructor(config: RelayProviderConfig, onEvent: RelayEventCallback);
    get connected(): boolean;
    start(): void;
    stop(): void;
    send(event: RelayOutgoingEvent): boolean;
    private connect;
    private scheduleReconnect;
    private startHeartbeat;
    private stopHeartbeat;
    private clearTimers;
}
