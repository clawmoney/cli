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
    input: number;
    output: number;
}
export declare const API_PRICES: Record<string, ModelPricing>;
export declare const RELAY_DISCOUNT = 0.2;
export declare const PLATFORM_FEE = 0.05;
export declare function getModelPricing(model: string): ModelPricing;
export interface CostBreakdown {
    inputCost: number;
    cacheCreationCost: number;
    cacheReadCost: number;
    outputCost: number;
    apiCost: number;
    relayCost: number;
    providerEarn: number;
}
export declare function calculateCost(model: string, inputTokens: number, outputTokens: number, cacheCreationTokens?: number, cacheReadTokens?: number): CostBreakdown;
