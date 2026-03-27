import type { ProviderConfig, ServiceCallEvent, TestCallEvent, EscrowTaskEvent, DeliverEvent, TestResponseEvent } from "./types.js";
type SendFn = (event: DeliverEvent | TestResponseEvent) => boolean;
export declare class Executor {
    private config;
    private send;
    private activeTasks;
    constructor(config: ProviderConfig, send: SendFn);
    get activeCount(): number;
    handleServiceCall(call: ServiceCallEvent): void;
    handleEscrowTask(task: EscrowTaskEvent): void;
    private executeEscrowTask;
    handleTestCall(call: TestCallEvent): void;
    private executeTask;
}
export {};
