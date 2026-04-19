/**
 * Registry of every passthrough cli_type we expose.
 *
 * One spec per cli_type. All of these target OpenAI-compatible upstreams
 * with static Bearer auth; the actual HTTP plumbing is in `passthrough-api.ts`.
 *
 * Naming follows openclaw's own provider ids so `openclaw onboard` profiles
 * drop in without a mapping table. Regional variants (global vs CN) are
 * handled at the baseUrl level rather than by multiplying cli_types —
 * callers who want the CN endpoint set the `<CLI>_BASE_URL` env var before
 * starting the daemon (or leave the openclaw-resolved baseUrl in place).
 */
export declare const PASSTHROUGH_CLI_TYPES: Set<string>;
