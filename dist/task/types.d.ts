/**
 * Task protocol — wire frames exchanged with spareai-hub (Cloudflare).
 *
 * Mirrors spareai-hub/src/wire.ts. When that file changes, this one
 * must follow. Phase 4 work item: publish `@spareai/wire` and replace
 * both copies with a single dependency.
 *
 * The task protocol is distinct from `src/hub/types.ts` (the legacy
 * bnbot-api market protocol that this module will eventually replace).
 * Both daemons run side by side during the migration window.
 */
export interface TaskRequest {
    event: "task_request";
    request_id: string;
    skill_id: string;
    /** Skill-defined schema. */
    input: unknown;
    buyer_id: string | null;
    timeout_ms: number;
}
export interface HubHello {
    event: "connected";
    agent_id: string;
    agent_name: string;
    provider_id: string;
}
export interface HubHeartbeatAck {
    event: "heartbeat_ack";
}
export interface HubError {
    event: "error";
    message: string;
}
export type HubFrame = TaskRequest | HubHello | HubHeartbeatAck | HubError;
export interface TaskProgress {
    event: "task_progress";
    request_id: string;
    stage?: string;
    percent?: number;
    note?: string;
    partial?: unknown;
}
export interface TaskResponse {
    event: "task_response";
    request_id: string;
    output?: unknown;
    error?: string;
    cost_usd: number;
    duration_ms: number;
}
export interface Heartbeat {
    event: "heartbeat";
}
export type ProviderFrame = TaskProgress | TaskResponse | Heartbeat;
/**
 * Helper handed to each skill handler. The handler calls
 * `report(progress)` zero or more times before returning the final
 * output (or throwing for error). The daemon serializes those into
 * task_progress + task_response frames on the WebSocket.
 */
export interface SkillContext {
    request_id: string;
    buyer_id: string | null;
    /** Emit a progress frame. Fields are all optional — pass whatever's
     *  meaningful for the skill at hand. */
    report(progress: {
        stage?: string;
        percent?: number;
        note?: string;
        partial?: unknown;
    }): void;
}
export interface SkillHandler {
    /** Per-call price in USD (provider-declared). Phase 4 will replace
     *  with a hub-validated rate card. */
    price_usd: number | ((input: unknown) => number);
    /** Skill-defined input handler. Returns the final `output`. Throw
     *  on failure — daemon converts the error to task_response.error. */
    run(input: unknown, ctx: SkillContext): Promise<unknown>;
}
export interface TaskDaemonConfig {
    /** Hub WSS URL — e.g. wss://api.spareapi.ai/ws/relay */
    hub_url: string;
    /** API key for the provider account on bnbot-api. Hub resolves it
     *  on upgrade to derive agent_id. Bypass with agent_id below for
     *  local dev against `wrangler dev`. */
    api_key: string;
    /** Local-dev shortcut: skip bnbot-api auth and pin a specific id. */
    agent_id?: string;
    agent_name?: string;
    /** Skill IDs to advertise on connect. Must be a subset of the
     *  registered handlers. */
    skills: string[];
    /** Concurrent in-flight task ceiling. Defaults to 5. */
    max_concurrency?: number;
    /** Heartbeat cadence (ms). Hub refreshes KV skill_idx TTL on each
     *  heartbeat, so keep this well below SKILL_IDX_TTL (10 min). */
    heartbeat_ms?: number;
    reconnect?: {
        initial_ms: number;
        max_ms: number;
        multiplier: number;
    };
}
