import type { ProviderConfig, ServiceCallEvent } from "./types.js";
export type PollCallback = (event: ServiceCallEvent) => void;
export declare class Poller {
    private config;
    private onServiceCall;
    private isWsConnected;
    private timer;
    private stopping;
    constructor(config: ProviderConfig, onServiceCall: PollCallback, isWsConnected: () => boolean);
    start(): void;
    stop(): void;
    private scheduleNext;
    private poll;
}
