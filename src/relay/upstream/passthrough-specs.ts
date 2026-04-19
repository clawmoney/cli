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
function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

// ── Design note: subscription-only catalog ───────────────────────────────
//
// clawmoney relay only supports upstreams where the provider is selling
// *idle capacity from a fixed monthly subscription*. Pay-per-token API
// keys (Moonshot Open Platform, generic Z.AI API, openai.com API, raw
// DashScope) are deliberately NOT registered here: a provider would spend
// real money per request while the buyer only pays 20% of the API price
// (RELAY_DISCOUNT) — a guaranteed loss on every call. Keeping only
// subscription-backed cli_types means every entry is actually usable.
//
// Anthropic follows the same rule: no "anthropic" api-key spec, only the
// `claude` OAuth subscription path + `antigravity` (Google Ultra quota
// that also serves Claude models).

// ── Z.AI GLM Coding Plan ──────────────────────────────────────────────────
// Z.AI sells a monthly Coding Plan subscription separately from their
// token-priced general API. Only the subscription endpoint is routable
// from clawmoney.

registerPassthroughSpec({
  cliType: "zai-coding",
  openclawProvider: "zai",
  envVarName: "ZAI_API_KEY",
  baseUrl: envOr("ZAI_CODING_BASE_URL", "https://api.z.ai/api/coding/paas/v4"),
  api: "openai-completions",
  label: "Z.AI Coding Plan",
});

// kimi-coding + minimax are subscription-based too but have OAuth flows
// that need refresh handling, so they ship as dedicated adapters
// (kimi-coding-api.ts, minimax-api.ts) and are dispatched directly from
// provider.ts rather than through this passthrough engine.

// ── Qwen / Alibaba ModelStudio Coding Plan ────────────────────────────────
// Paid subscription (the OAuth free tier was killed 2026-04-15). Uses a
// static BAILIAN_CODING_PLAN_API_KEY against an OpenAI-compat endpoint,
// so it fits the passthrough engine cleanly.

registerPassthroughSpec({
  cliType: "qwen-coding",
  openclawProvider: "qwen",
  envVarName: "BAILIAN_CODING_PLAN_API_KEY",
  baseUrl: envOr("QWEN_CODING_BASE_URL", "https://coding.dashscope.aliyuncs.com/v1"),
  api: "openai-completions",
  label: "Qwen Coding Plan",
});

// Catalog of every cli_type served by the passthrough engine. Exported so
// provider.ts can switch on membership in one line instead of per-cli-type
// cases. These are INTERNAL cli_type names — the Hub sees all of them
// under the single "api-key" cli_type (see `ApiKeyInternalRoute` below).
export const PASSTHROUGH_CLI_TYPES = new Set<string>([
  "zai-coding",
  "qwen-coding",
  // Note: "kimi-coding" and "minimax" are NOT here — they have dedicated
  // OAuth-aware adapters in kimi-coding-api.ts and minimax-api.ts.
  // Pay-per-token cli_types (moonshot, zai, openai) were removed because
  // they guarantee a loss to the provider under the flat RELAY_DISCOUNT.
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
export function hubCliTypeFor(internalCli: string): string {
  if (PASSTHROUGH_CLI_TYPES.has(internalCli)) return HUB_CLI_TYPE_FOR_PASSTHROUGH;
  // minimax + kimi-coding have dedicated adapters but still register as
  // Hub-canonical "api-key" — to the Hub they're just Bearer-auth
  // OpenAI-compat providers, the OAuth + refresh lives entirely in the
  // daemon.
  if (internalCli === "minimax" || internalCli === "kimi-coding") {
    return HUB_CLI_TYPE_FOR_PASSTHROUGH;
  }
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
export function resolveSpecByModel(model: string): string | null {
  if (!model) return null;
  if (model.startsWith("MiniMax-")) return "minimax";
  if (model.startsWith("glm-") || model.startsWith("zai-")) return "zai-coding";
  if (model.startsWith("kimi-k2") || model === "kimi-code") return "kimi-coding";
  if (model.startsWith("qwen")) return "qwen-coding";
  // Intentionally nothing for gpt-*/o3/o4-mini — codex OAuth subscription
  // is the only sanctioned path; raw openai.com API-key passthrough was
  // removed because the provider would lose money on every buyer request.
  return null;
}
