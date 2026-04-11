// ── Relay request from server ──

export interface RelayRequest {
  event: "relay_request";
  request_id: string;
  prompt?: string;
  messages?: Array<{ role: string; content: string }>;
  cli_type?: string;
  session_id?: string;           // relay session UUID
  cli_session_id?: string | null; // CLI-side session id (for --resume)
  stateful?: boolean;
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

export interface RelayResponseSessionWindow {
  // UNIX ms when the rolling 5h window resets (upstream's reset header).
  reset_at_ms: number;
  // 0-100 if upstream surfaces utilization, else undefined.
  utilization?: number;
  // upstream status string ("allowed", "surpassed", etc.) if surfaced.
  status?: string;
}

export interface RelayResponse {
  event: "relay_response";
  request_id: string;
  content: string;
  session_id?: string;       // relay session (passed through)
  cli_session_id?: string;   // CLI-side session id (returned for --resume next turn)
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_tokens?: number;
    cache_read_tokens?: number;
  };
  model_used?: string;
  cost_usd?: number;
  error?: string;
  // Opt-in session-window telemetry piggy-backed on the response envelope.
  // Only populated in execution_mode="api" when the upstream surfaces its
  // rolling 5h window reset headers (currently Claude). Hub uses this to
  // avoid claim-scheduling providers whose window is nearly saturated.
  session_window?: RelayResponseSessionWindow;
}

export type RelayOutgoingEvent = RelayResponse;

// ── Parsed CLI output ──

export interface ParsedOutput {
  text: string;
  sessionId: string;
  usage: {
    input_tokens: number;          // base (non-cached) input
    output_tokens: number;
    cache_creation_tokens: number;  // tokens written to cache
    cache_read_tokens: number;      // tokens read from cache
  };
  model: string;
  costUsd: number;
}

// ── Relay provider config ──

export interface RelayRateGuardConfig {
  max_concurrency?: number;
  quiet_hours_max_concurrency?: number;
  quiet_hours?: number[];
  min_request_gap_ms?: number;
  jitter_ms?: number;
  daily_budget_usd?: number;
}

export interface RelayProviderSettings {
  cli_type: string;          // "claude", "codex", "gemini"
  // Execution mode. "cli" spawns the local CLI per request (default, stable,
  // works for all cli_types). "api" calls the upstream provider's HTTPS API
  // directly using the locally-cached OAuth token — ~10x faster, supported
  // for cli_type="claude" | "codex" | "gemini". Each type has its own
  // fingerprint bootstrap script under scripts/capture-<type>-request.mjs.
  execution_mode?: "cli" | "api";
  // Anti-ban rate-guard settings. Only applied in execution_mode="api".
  rate_guard?: RelayRateGuardConfig;
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
