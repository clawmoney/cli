export interface RelayRequest {
    event: "relay_request";
    request_id: string;
    prompt: string;
    session_id?: string;
    model?: string;
    max_budget_usd?: number;
}
export interface RelayConnectedEvent {
    event: "connected";
    agent_id: string;
    agent_name: string;
    provider_id: string;
}
export interface RelayErrorEvent {
    event: "error";
    message: string;
}
export type RelayIncomingEvent = RelayRequest | RelayConnectedEvent | RelayErrorEvent;
export interface RelayResponse {
    event: "relay_response";
    request_id: string;
    result: string;
    session_id?: string;
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cached_tokens?: number;
    };
    model_used?: string;
    cost_usd?: number;
    error?: string;
}
export type RelayOutgoingEvent = RelayResponse;
export interface ParsedOutput {
    text: string;
    sessionId: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cached_tokens?: number;
    };
    model: string;
    costUsd: number;
}
export interface RelayProviderSettings {
    cli_type: string;
    model: string;
    mode: string;
    concurrency: number;
    daily_limit_usd: number;
    ws_url: string;
    reconnect: {
        initial: number;
        max: number;
        multiplier: number;
    };
}
export interface RelayProviderConfig {
    api_key: string;
    agent_id?: string;
    agent_slug?: string;
    relay: RelayProviderSettings;
}
