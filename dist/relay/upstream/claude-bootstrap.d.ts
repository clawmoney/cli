/**
 * Programmatic Claude fingerprint capture.
 *
 * Mirrors scripts/capture-claude-request.mjs but runs as a library so the
 * setup wizard can bootstrap the fingerprint automatically instead of
 * asking the user to run a two-terminal dance.
 *
 * Flow:
 *   1. Listen on a random localhost port.
 *   2. Spawn `claude -p "hi"` with ANTHROPIC_BASE_URL pointing at us.
 *   3. When the first POST /v1/messages arrives, extract device_id,
 *      account_uuid, user_agent, cc_version, cc_entrypoint from the
 *      body + headers, persist to ~/.clawmoney/claude-fingerprint.json,
 *      and forward the request to api.anthropic.com so the claude CLI
 *      still sees a real response.
 *   4. Clean up proxy server + claude subprocess.
 *
 * The forwarded request costs 1-2 cents' worth of tokens on the
 * provider's real Claude Max subscription — acceptable for a one-time
 * bootstrap that otherwise blocks every subsequent relay request.
 */
export interface ClaudeFingerprint {
    device_id: string;
    account_uuid: string;
    user_agent: string;
    cc_version: string;
    cc_entrypoint: string;
}
export declare function hasClaudeFingerprint(): boolean;
export declare function bootstrapClaudeFingerprint(opts?: {
    timeoutMs?: number;
}): Promise<ClaudeFingerprint>;
