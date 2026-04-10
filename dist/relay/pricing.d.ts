/**
 * API pricing per million tokens (USD).
 * Source: Official pricing pages (April 2026)
 * - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/pricing
 * - OpenAI: https://developers.openai.com/api/docs/pricing
 * - Google: https://ai.google.dev/gemini-api/docs/pricing
 */
export interface ModelPricing {
    input: number;
    output: number;
}
export declare const API_PRICES: Record<string, ModelPricing>;
export declare const RELAY_DISCOUNT = 0.3;
export declare const PLATFORM_FEE = 0.05;
export declare function getModelPricing(model: string): ModelPricing;
export declare function calculateCost(model: string, inputTokens: number, outputTokens: number): {
    apiCost: number;
    relayCost: number;
    providerEarn: number;
};
