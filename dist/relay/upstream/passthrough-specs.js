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
import { registerPassthroughSpec } from "./passthrough-api.js";
// Helper: pick env override first, otherwise use the provided default.
function envOr(name, fallback) {
    const v = process.env[name];
    return v && v.length > 0 ? v : fallback;
}
// ── Z.AI / GLM ────────────────────────────────────────────────────────────
// Two coding-plan variants (global + cn) and two general-API variants,
// all sharing the `zai` openclaw provider id and the `ZAI_API_KEY` env var.
// cli_type is the only field distinguishing them on the relay side.
registerPassthroughSpec({
    cliType: "zai-coding",
    openclawProvider: "zai",
    envVarName: "ZAI_API_KEY",
    baseUrl: envOr("ZAI_CODING_BASE_URL", "https://api.z.ai/api/coding/paas/v4"),
    api: "openai-completions",
    label: "Z.AI Coding Plan",
});
registerPassthroughSpec({
    cliType: "zai",
    openclawProvider: "zai",
    envVarName: "ZAI_API_KEY",
    baseUrl: envOr("ZAI_BASE_URL", "https://api.z.ai/api/paas/v4"),
    api: "openai-completions",
    label: "Z.AI General",
});
// ── Moonshot / Kimi K2 ────────────────────────────────────────────────────
registerPassthroughSpec({
    cliType: "moonshot",
    openclawProvider: "moonshot",
    envVarName: "MOONSHOT_API_KEY",
    baseUrl: envOr("MOONSHOT_BASE_URL", "https://api.moonshot.ai/v1"),
    api: "openai-completions",
    label: "Moonshot (Kimi K2)",
});
// Kimi Coding is a separate product from Moonshot's public API: different
// key, different endpoint, different catalog. Per openclaw docs the keys
// are not interchangeable.
registerPassthroughSpec({
    cliType: "kimi-coding",
    openclawProvider: "kimi",
    envVarName: "KIMI_API_KEY",
    baseUrl: envOr("KIMI_CODING_BASE_URL", "https://api.moonshot.ai/v1"),
    api: "openai-completions",
    label: "Kimi Coding",
});
// ── Qwen / Alibaba ModelStudio Coding Plan ────────────────────────────────
// Qwen's OAuth free tier was killed 2026-04-15; paid usage goes through
// the ModelStudio Coding Plan (BAILIAN_CODING_PLAN_API_KEY, OpenAI-compat).
registerPassthroughSpec({
    cliType: "qwen-coding",
    openclawProvider: "qwen",
    envVarName: "BAILIAN_CODING_PLAN_API_KEY",
    baseUrl: envOr("QWEN_CODING_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1"),
    api: "openai-completions",
    label: "Qwen Coding Plan",
});
// ── OpenAI API key (distinct from cli_type "codex" which uses subscription OAuth) ──
registerPassthroughSpec({
    cliType: "openai",
    openclawProvider: "openai",
    envVarName: "OPENAI_API_KEY",
    baseUrl: envOr("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    api: "openai-completions",
    label: "OpenAI API",
});
// Catalog of every cli_type served by the passthrough engine. Exported so
// provider.ts can switch on membership in one line instead of per-cli-type
// cases. These are INTERNAL cli_type names — the Hub sees all of them
// under the single "api-key" cli_type (see `ApiKeyInternalRoute` below).
export const PASSTHROUGH_CLI_TYPES = new Set([
    "zai-coding",
    "zai",
    "moonshot",
    "kimi-coding",
    "qwen-coding",
    "openai",
]);
// ── Hub-side cli_type mapping ─────────────────────────────────────────────
//
// bnbot-api only recognizes a closed set of cli_types (see
// backend/app/core/relay_catalog.py:_ALL_CLI_TYPES). For static-key and
// bearer-passthrough upstreams the canonical value is `api-key` — the
// fine-grained internal names above (zai-coding, moonshot, etc.) are
// clawmoney-cli concepts only and must be folded to `api-key` on the wire
// when registering providers and when dispatching inbound requests.
//
// Routing from `api-key` back to an internal spec is done by model prefix
// via `resolveSpecByModel()`. Model namespaces don't overlap across the
// supported upstreams (glm-* is zai, kimi-k2* is moonshot, MiniMax-* is
// minimax, …) so the mapping is unambiguous. gpt-5.x is the one shared
// namespace — when the Hub sends `cli_type="codex"` it's subscription
// OAuth; `cli_type="api-key"` is the OpenAI API-key route.
export const HUB_CLI_TYPE_FOR_PASSTHROUGH = "api-key";
/**
 * Map an internal upstream id (what relay-setup shows in the wizard) to
 * the Hub-recognized cli_type. Used when building the `/providers/batch`
 * registration payload.
 */
export function hubCliTypeFor(internalCli) {
    if (PASSTHROUGH_CLI_TYPES.has(internalCli))
        return HUB_CLI_TYPE_FOR_PASSTHROUGH;
    if (internalCli === "minimax")
        return HUB_CLI_TYPE_FOR_PASSTHROUGH;
    // claude / codex / gemini / antigravity pass through unchanged.
    return internalCli;
}
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
export function resolveSpecByModel(model) {
    if (!model)
        return null;
    if (model.startsWith("MiniMax-"))
        return "minimax";
    if (model.startsWith("glm-") || model.startsWith("zai-"))
        return "zai-coding";
    if (model.startsWith("kimi-k2"))
        return "moonshot";
    if (model === "kimi-code")
        return "kimi-coding";
    if (model.startsWith("qwen"))
        return "qwen-coding";
    // OpenAI API-key path serves the same gpt-* / o-series catalog the
    // codex OAuth path does, but dispatch comes in under cli_type="api-key"
    // so there's no ambiguity at this point — codex traffic never reaches
    // the resolver.
    if (model.startsWith("gpt-") || model === "o3" || model === "o4-mini") {
        return "openai";
    }
    return null;
}
