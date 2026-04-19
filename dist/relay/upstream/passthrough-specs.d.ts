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
export declare const HUB_CLI_TYPE_FOR_PASSTHROUGH = "api-key";
/**
 * Map an internal upstream id (what relay-setup shows in the wizard) to
 * the Hub-recognized cli_type. Used when building the `/providers/batch`
 * registration payload.
 */
export declare function hubCliTypeFor(internalCli: string): string;
/**
 * Resolve a model id back to the daemon-internal spec key. Returns `null`
 * when the model doesn't match any known passthrough family — callers then
 * throw a clear "unknown api-key model" error so provider.ts doesn't
 * silently route mystery models to the wrong upstream.
 *
 * Special case: "minimax" is not a passthrough spec (MiniMax has its own
 * OAuth-aware adapter in minimax-api.ts) but we surface it from this
 * function so provider.ts only has one switch to read.
 */
export declare function resolveSpecByModel(model: string): string | null;
