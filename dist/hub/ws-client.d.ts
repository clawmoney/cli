import type { ProviderConfig, IncomingEvent, OutgoingEvent } from "./types.js";
export type EventCallback = (event: IncomingEvent) => void;
export declare class WsClient {
    private config;
    private onEvent;
    private ws;
    private heartbeatTimer;
    private reconnectDelay;
    private reconnectTimer;
    private _connected;
    private wsFailLogged;
    private stopping;
    constructor(config: ProviderConfig, onEvent: EventCallback);
    get connected(): boolean;
    start(): void;
    stop(): void;
    send(event: OutgoingEvent): boolean;
    private connect;
    private scheduleReconnect;
    private startHeartbeat;
    private stopHeartbeat;
    private clearTimers;
}
