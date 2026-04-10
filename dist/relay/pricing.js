/**
 * API pricing per million tokens (USD).
 * Source: Official pricing pages (April 2026)
 * - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/pricing
 * - OpenAI: https://developers.openai.com/api/docs/pricing
 * - Google: https://ai.google.dev/gemini-api/docs/pricing
 */
export const API_PRICES = {
    // ── Anthropic (Claude) ──
    "claude-opus-4-6": { input: 5, output: 25 },
    "claude-opus-4-5": { input: 5, output: 25 },
    "claude-sonnet-4-6": { input: 3, output: 15 },
    "claude-sonnet-4-5": { input: 3, output: 15 },
    "claude-haiku-4-5": { input: 1, output: 5 },
    // ── OpenAI ──
    "gpt-5.4": { input: 2.50, output: 15 },
    "gpt-5.4-mini": { input: 0.75, output: 4.50 },
    "gpt-5.4-nano": { input: 0.20, output: 1.25 },
    "gpt-5.4-pro": { input: 30, output: 180 },
    "gpt-5.3-codex": { input: 1.75, output: 14 },
    "o3": { input: 5, output: 20 },
    "o4-mini": { input: 4, output: 16 },
    // ── Google (Gemini) ──
    "gemini-2.5-pro": { input: 1.25, output: 10 },
    "gemini-2.5-flash": { input: 0.30, output: 2.50 },
    "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
    "gemini-3-flash-preview": { input: 0.50, output: 3 },
    "gemini-3.1-pro-preview": { input: 2, output: 12 },
};
// Default fallback for unknown models
const DEFAULT_PRICING = { input: 5, output: 25 };
// Relay discount: consumers pay this fraction of API price
export const RELAY_DISCOUNT = 0.30; // 30% of API price
// Platform fee: this fraction goes to the platform
export const PLATFORM_FEE = 0.05; // 5%
export function getModelPricing(model) {
    return API_PRICES[model] ?? DEFAULT_PRICING;
}
export function calculateCost(model, inputTokens, outputTokens) {
    const p = getModelPricing(model);
    const apiCost = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
    const relayCost = apiCost * RELAY_DISCOUNT;
    const providerEarn = relayCost * (1 - PLATFORM_FEE);
    return { apiCost, relayCost, providerEarn };
}
