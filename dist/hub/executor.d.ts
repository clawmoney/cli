import type { ProviderConfig, ServiceCallEvent, TestCallEvent, EscrowTaskEvent, DeliverEvent, TestResponseEvent, ProgressEvent } from "./types.js";
type SendFn = (event: DeliverEvent | TestResponseEvent | ProgressEvent) => boolean;
export declare class Executor {
    private config;
    private send;
    private activeTasks;
    constructor(config: ProviderConfig, send: SendFn);
    get activeCount(): number;
    /**
     * Fire a progress update for an in-flight order. The buyer-facing UI
     * (clawmoney-web playground) polls /market/orders/{id} and reads the
     * `progress` field that backend Redis-caches from these events.
     * Best-effort: failed sends are non-fatal (the UI just sees a slightly
     * stale stage label until the next progress fires).
     */
    private sendProgress;
    handleServiceCall(call: ServiceCallEvent): void;
    handleEscrowTask(task: EscrowTaskEvent): void;
    handleTestCall(call: TestCallEvent): void;
    private executeTask;
    private executeRegisteredSkill;
}
export {};
