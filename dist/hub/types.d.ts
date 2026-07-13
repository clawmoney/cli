export interface ServiceCallEvent {
    event: "service_call";
    order_id: string;
    from: string;
    skill: string;
    category: string;
    input: Record<string, unknown>;
    price: number;
    timeout: number;
    payment_method: string;
}
export interface TestCallEvent {
    event: "test_call";
    order_id: string;
    input: Record<string, unknown>;
}
export interface ConnectedEvent {
    event: "connected";
    agent_id: string;
    agent_name: string;
    hub_level: number;
}
export interface ErrorEvent {
    event: "error";
    message: string;
}
export interface HeartbeatAckEvent {
    event: "heartbeat_ack";
}
export interface EscrowTaskEvent {
    id: string;
    title: string;
    description: string;
    category: string;
    requirements: string | null;
    budget: number;
    mode: string;
    funded: boolean;
    status: string;
    submission_count: number;
    creator_agent_name: string | null;
    creator_agent_slug: string | null;
}
export interface PendingTasksResponse {
    service_calls: ServiceCallEvent[];
    escrow_tasks: EscrowTaskEvent[];
    social_tasks: unknown[];
    total: number;
}
export type IncomingEvent = ServiceCallEvent | TestCallEvent | ConnectedEvent | ErrorEvent | HeartbeatAckEvent;
export interface DeliverEvent {
    event: "deliver";
    order_id: string;
    output?: Record<string, unknown>;
    error?: string;
}
export interface TestResponseEvent {
    event: "test_response";
    order_id: string;
    output: Record<string, unknown>;
}
/**
 * Live in-flight progress reported back to backend during a service_call.
 * Backend stashes the text at hub:progress:<order_id> in Redis with a
 * 10-minute TTL; spareai-web's playground poll picks it up via the
 * HubOrderPublic.progress field. Fire-and-forget — backend doesn't
 * ack, so dropped progress messages just mean the UI sees a slightly
 * stale stage label.
 */
export interface ProgressEvent {
    event: "progress";
    order_id: string;
    progress: string;
}
export type OutgoingEvent = DeliverEvent | TestResponseEvent | ProgressEvent;
export interface ProviderSettings {
    cli_command: string;
    max_concurrent: number;
    auto_accept: boolean;
    ws_url: string;
    api_base_url: string;
    polling: {
        connected_interval: number;
        disconnected_interval: number;
    };
    reconnect: {
        initial: number;
        max: number;
        multiplier: number;
    };
    skills?: Record<string, {
        prompt_template?: string;
    }>;
    /** Skill names the user has opted out of auto-registering / kept off the marketplace. */
    disabled_skills?: string[];
}
export interface ProviderConfig {
    api_key: string;
    agent_id?: string;
    agent_slug?: string;
    provider: ProviderSettings;
}
