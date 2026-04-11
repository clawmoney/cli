/**
 * API pricing per million tokens (USD).
 *
 * Source: cross-referenced against the LiteLLM community pricing database
 * (`backend/resources/model-pricing/model_prices_and_context_window.json`
 * inside sub2api at commit ~April 2026). LiteLLM is the most actively
 * maintained open pricing source for AI models and stays in sync with
 * Anthropic / OpenAI / Google public pricing pages.
 *
 * When a model appears in a CLI's supported list but is absent from LiteLLM
 * (typically pre-release or deprecated models), we either fall back to the
 * closest known variant (documented in `resolveFallback()`) or keep the
 * last manually-verified number and mark it with a comment.
 *
 * If you update these values, also update the LiteLLM reference timestamp
 * in the header above so future ops know when the last sync happened.
 */

export interface ModelPricing {
  input: number;   // $ per 1M input tokens
  output: number;  // $ per 1M output tokens
}

export const API_PRICES: Record<string, ModelPricing> = {
  // ── Anthropic (Claude) ──
  // Verified against LiteLLM pricing DB. cache_read = 0.1x input,
  // cache_write = 1.25x input (Anthropic ephemeral cache).
  "claude-opus-4-6":   { input: 5,    output: 25 },
  "claude-opus-4-5":   { input: 5,    output: 25 },
  "claude-sonnet-4-6": { input: 3,    output: 15 },
  "claude-sonnet-4-5": { input: 3,    output: 15 },
  "claude-haiku-4-5":  { input: 1,    output: 5 },

  // ── OpenAI (ChatGPT Plus / Codex subscriptions) ──
  // Verified against LiteLLM. Codex CLI may expose any of these depending
  // on the user's subscription tier and which models ChatGPT enables.
  "gpt-5.4":              { input: 2.50, output: 15 },
  "gpt-5.4-mini":         { input: 0.75, output: 4.50 },
  "gpt-5.4-nano":         { input: 0.20, output: 1.25 },
  // gpt-5.4-pro is not in LiteLLM as of April 2026. Keeping the manually
  // verified values from OpenAI's enterprise pricing page.
  "gpt-5.4-pro":          { input: 30,   output: 180 },
  "gpt-5.3-codex":        { input: 1.75, output: 14 },
  // gpt-5.3-codex-spark is not in LiteLLM — sub2api falls back to
  // gpt-5.1-codex pricing (see pricing_service.go SparkBilling handling).
  "gpt-5.3-codex-spark":  { input: 1.25, output: 10 },
  "gpt-5.2":              { input: 1.75, output: 14 },
  "gpt-5.2-codex":        { input: 1.75, output: 14 },
  "gpt-5.1":              { input: 1.25, output: 10 },
  "gpt-5.1-codex":        { input: 1.25, output: 10 },
  "gpt-5.1-codex-mini":   { input: 0.25, output: 2 },
  "gpt-5.1-codex-max":    { input: 1.25, output: 10 },
  "gpt-5":                { input: 1.25, output: 10 },
  // Reasoning models (o-series). Previously had incorrect values — LiteLLM
  // confirms o3 is $2/$8 (not $5/$20) and o4-mini is $1.1/$4.4 (not $4/$16).
  "o3":                   { input: 2,    output: 8 },
  "o4-mini":              { input: 1.1,  output: 4.4 },

  // ── Google Antigravity (Ultra-bundled IDE quota pool) ──
  // Antigravity is the only path that exposes Claude to Google-OAuth users.
  // We price these at the public Anthropic / Google API rates (providers earn
  // the same per-request as if they were serving via Anthropic/Google direct),
  // even though their real cost is zero — the quota is a sunk cost of the
  // Ultra subscription.
  "antigravity-gemini-3-pro":           { input: 2,    output: 12 },
  "antigravity-gemini-3.1-pro":         { input: 2,    output: 12 },
  "antigravity-gemini-3-flash":         { input: 0.50, output: 3 },
  "antigravity-gemini-2.5-pro":         { input: 1.25, output: 10 },
  "antigravity-gemini-2.5-flash":       { input: 0.30, output: 2.50 },
  "antigravity-claude-opus-4-6":        { input: 5,    output: 25 },
  "antigravity-claude-opus-4-6-thinking": { input: 5,  output: 25 },
  "antigravity-claude-sonnet-4-6":      { input: 3,    output: 15 },
  "antigravity-claude-sonnet-4-5":      { input: 3,    output: 15 },

  // ── Google (Gemini) ──
  // Verified against LiteLLM pricing DB.
  "gemini-3.1-pro-preview":  { input: 2,    output: 12 },
  "gemini-3-pro-preview":    { input: 2,    output: 12 },
  // gemini-3.1-flash-preview is not in LiteLLM — fall back to
  // gemini-3-flash-preview pricing.
  "gemini-3.1-flash-preview": { input: 0.50, output: 3 },
  "gemini-3-flash-preview":  { input: 0.50, output: 3 },
  "gemini-2.5-pro":          { input: 1.25, output: 10 },
  "gemini-2.5-flash":        { input: 0.30, output: 2.50 },
  "gemini-2.5-flash-lite":   { input: 0.10, output: 0.40 },
  "gemini-2.0-flash":        { input: 0.10, output: 0.40 },
};

// Default fallback for unknown models. Priced at the Claude Opus rate
// intentionally — better to over-charge an unknown model than under-charge
// and lose money. If a Provider sees a real model billed at this rate,
// they should file a bug to add the model to API_PRICES.
const DEFAULT_PRICING: ModelPricing = { input: 5, output: 25 };

// ── Relay economics ──────────────────────────────────────────────────────
//
// Pricing strategy (April 2026):
//   1. Buyer pays RELAY_DISCOUNT × API_price  (currently 20% of official
//      Anthropic / OpenAI / Google API prices — i.e. an 80% discount).
//   2. ClawMoney platform takes PLATFORM_FEE of what the buyer pays.
//   3. Provider keeps the rest.
//
// Concretely, for a 1M-token Claude Sonnet input+output at default rates:
//   API price            = 1M × ($3 input + $15 output) = $18
//   Buyer pays (20%)     = $3.60
//   Platform fee (5%)    = $0.18
//   Provider earns       = $3.42
//
// Why 20% flat across all platforms:
//   - The Provider's subscription fee is a sunk cost; their marginal cost
//     per relayed request is zero (modulo rate-limit guards).
//   - 80% off the official API is a strong enough discount that most buyers
//     would rather route through ClawMoney than pay Anthropic/OpenAI/Google
//     direct.
//   - Simpler to explain to both sides than a per-platform discount table.
//
// If we later see sustained demand-side hesitation or supply-side complaints
// we can revisit and split into per-cli_type rates.

// Relay discount: consumers pay this fraction of API price
export const RELAY_DISCOUNT = 0.20;  // 20% of API price (buyer saves 80%)

// Platform fee: this fraction of what the buyer pays goes to the platform
export const PLATFORM_FEE = 0.05;    // 5%

export function getModelPricing(model: string): ModelPricing {
  return API_PRICES[model] ?? DEFAULT_PRICING;
}

export interface CostBreakdown {
  inputCost: number;            // base (non-cached) input
  cacheCreationCost: number;    // cache write (1.25x base input)
  cacheReadCost: number;        // cache read (0.1x base input)
  outputCost: number;           // output tokens
  apiCost: number;              // total API cost
  relayCost: number;            // what consumer pays (discount)
  providerEarn: number;         // what provider earns (after platform fee)
}

// Cache pricing multipliers (relative to base input price)
const CACHE_WRITE_MULTIPLIER = 1.25;  // 5-minute cache write
const CACHE_READ_MULTIPLIER = 0.10;   // cache hit

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number = 0,
  cacheReadTokens: number = 0
): CostBreakdown {
  const p = getModelPricing(model);
  const M = 1_000_000;

  const inputCost = (inputTokens * p.input) / M;
  const cacheCreationCost = (cacheCreationTokens * p.input * CACHE_WRITE_MULTIPLIER) / M;
  const cacheReadCost = (cacheReadTokens * p.input * CACHE_READ_MULTIPLIER) / M;
  const outputCost = (outputTokens * p.output) / M;
  const apiCost = inputCost + cacheCreationCost + cacheReadCost + outputCost;
  const relayCost = apiCost * RELAY_DISCOUNT;
  const providerEarn = relayCost * (1 - PLATFORM_FEE);

  return { inputCost, cacheCreationCost, cacheReadCost, outputCost, apiCost, relayCost, providerEarn };
}
