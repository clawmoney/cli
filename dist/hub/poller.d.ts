import type { ProviderConfig, ServiceCallEvent, EscrowTaskEvent } from "./types.js";
export type ServiceCallCallback = (event: ServiceCallEvent) => void;
export type EscrowTaskCallback = (task: EscrowTaskEvent) => void;
export declare class Poller {
    private config;
    private onServiceCall;
    private onEscrowTask;
    private isWsConnected;
    private timer;
    private stopping;
    constructor(config: ProviderConfig, onServiceCall: ServiceCallCallback, onEscrowTask: EscrowTaskCallback, isWsConnected: () => boolean);
    start(): void;
    stop(): void;
    private scheduleNext;
    private poll;
}
