// ── Relay request from server ──

export interface RelayRequest {
  event: "relay_request";
  request_id: string;
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  cli_type?: string;
  session_id?: string;
  model?: string;
  max_budget_usd?: number;
}

// ── Events received from server ──

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

export type RelayIncomingEvent =
  | RelayRequest
  | RelayConnectedEvent
  | RelayErrorEvent;

// ── Response sent back to server ──

export interface RelayResponse {
  event: "relay_response";
  request_id: string;
  content: string;
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

// ── Parsed CLI output ──

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

// ── Relay provider config ──

export interface RelayProviderSettings {
  cli_type: string;          // "claude", "codex", "gemini"
  model: string;
  mode: string;              // "chat", "search", "code", "full"
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
