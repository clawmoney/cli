// ── Relay request from server ──

// A content block as Anthropic/Claude Code sends it. We only care about
// text blocks; other types (image, tool_use, tool_result) are ignored when
// flattening to a string prompt.
export interface RelayContentBlock {
  type: string;
  text?: string;
}

// Message content can be either a plain string (OpenAI-style, legacy Claude)
// or an array of content blocks (Claude Code / real Anthropic API shape).
export type RelayMessageContent = string | RelayContentBlock[] | null;

export interface RelayRequest {
  event: "relay_request";
  request_id: string;
  prompt?: string;
  messages?: Array<{ role: string; content: RelayMessageContent }>;
  cli_type?: string;
  session_id?: string;           // relay session UUID
  cli_session_id?: string | null; // CLI-side session id (for --resume)
  stateful?: boolean;
  model?: string;
  max_budget_usd?: number;
  // Passthrough mode — when set, the Hub is forwarding a real Claude
  // Code request body verbatim and wants the daemon to send it to
  // Anthropic almost unchanged (only metadata.user_id / billing header /
  // model normalization applied). Used for drop-in ANTHROPIC_BASE_URL
  // replacement so tools, multi-turn messages, thinking config, etc.
  // all survive the relay hop. Ignored for non-claude cli_types.
  passthrough_body?: Record<string, unknown>;
  // Buyer's `anthropic-beta` header value, merged with our required
  // betas when passthrough_body is set. Ignored in template mode.
  anthropic_beta?: string;
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

// One-way notice pushed by the Hub when something needs the provider's
// attention — today only "model_mismatch_quarantine" is defined. The
// daemon logs a WARN with the full message so the human operator sees
// it without having to poll /providers/me.
export interface RelayNoticeEvent {
  event: "relay_notice";
  notice_type: string;       // "model_mismatch_quarantine"
  cli_type?: string;
  expected_model?: string;
  got_model?: string;
  message: string;
}

export type RelayIncomingEvent =
  | RelayRequest
  | RelayConnectedEvent
  | RelayErrorEvent
  | RelayNoticeEvent;

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
  // Session-window telemetry piggy-backed on the response envelope.
  // Populated when the upstream surfaces rolling 5h window reset headers
  // (currently Claude). Hub uses this to avoid claim-scheduling providers
  // whose window is nearly saturated.
  session_window?: RelayResponseSessionWindow;
}

// Intermediate streaming frame — one raw Anthropic SSE frame forwarded
// from the daemon to the Hub while the upstream response is still being
// generated. Hubs that want real streaming forward the `sse` payload
// verbatim to the end client; Hubs that don't, ignore these events and
// use the final relay_response.content instead.
export interface RelayStreamChunkEvent {
  event: "relay_stream_chunk";
  request_id: string;
  sse: string;
}

export type RelayOutgoingEvent = RelayResponse | RelayStreamChunkEvent;

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
  cli_type: string;          // "claude", "codex", "gemini", "antigravity"
  // Anti-ban rate-guard settings for direct upstream API calls.
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
