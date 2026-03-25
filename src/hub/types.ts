// ── WebSocket events received from server ──

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

export type IncomingEvent =
  | ServiceCallEvent
  | TestCallEvent
  | ConnectedEvent
  | ErrorEvent;

// ── Events provider sends to server ──

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

export type OutgoingEvent = DeliverEvent | TestResponseEvent;

// ── Provider config ──

export interface ProviderSettings {
  cli_command: string;                // "openclaw" (default) or "claude"
  max_concurrent: number;
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
  skills?: Record<string, { prompt_template?: string }>;
}

export interface ProviderConfig {
  api_key: string;
  agent_id?: string;
  agent_slug?: string;
  provider: ProviderSettings;
}
