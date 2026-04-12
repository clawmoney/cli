export interface RelayContentBlock {
    type: string;
    text?: string;
}
export type RelayMessageContent = string | RelayContentBlock[] | null;
export interface RelayRequest {
    event: "relay_request";
    request_id: string;
    prompt?: string;
    messages?: Array<{
        role: string;
        content: RelayMessageContent;
    }>;
    cli_type?: string;
    session_id?: string;
    cli_session_id?: string | null;
    stateful?: boolean;
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
export interface RelayResponseSessionWindow {
    reset_at_ms: number;
    utilization?: number;
    status?: string;
}
export interface RelayResponse {
    event: "relay_response";
    request_id: string;
    content: string;
    session_id?: string;
    cli_session_id?: string;
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_tokens?: number;
        cache_read_tokens?: number;
    };
    model_used?: string;
    cost_usd?: number;
    error?: string;
    session_window?: RelayResponseSessionWindow;
}
export type RelayOutgoingEvent = RelayResponse;
export interface ParsedOutput {
    text: string;
    sessionId: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_tokens: number;
        cache_read_tokens: number;
    };
    model: string;
    costUsd: number;
}
export interface RelayRateGuardConfig {
    max_concurrency?: number;
    quiet_hours_max_concurrency?: number;
    quiet_hours?: number[];
    min_request_gap_ms?: number;
    jitter_ms?: number;
    daily_budget_usd?: number;
}
export interface RelayProviderSettings {
    cli_type: string;
    rate_guard?: RelayRateGuardConfig;
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
    /**
     * Upstream HTTPS proxy. When set, the daemon exports HTTPS_PROXY /
     * HTTP_PROXY before running any fetch, so providers on GFW-side machines
     * don't have to remember to `export https_proxy=` in every shell. Only
     * plain HTTP(S) proxies are supported (SOCKS is ignored with a warning).
     *
     * Example:
     *     proxy: http://127.0.0.1:7897
     */
    proxy?: string;
}
