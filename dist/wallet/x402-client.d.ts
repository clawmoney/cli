import type { WalletProvider } from './provider.js';
export interface X402PaymentRequirement {
    scheme: string;
    network: string;
    maxAmountRequired: string;
    resource: string;
    description?: string;
    mimeType?: string;
    payTo: string;
    maxTimeoutSeconds: number;
    asset: string;
    extra?: {
        name?: string;
        version?: string;
    };
}
export interface X402Challenge {
    x402Version: number;
    accepts: X402PaymentRequirement[];
    error?: string;
}
export interface X402PayOptions {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    maxAmountAtomic?: string;
}
/**
 * Execute an x402-protected HTTP request, handling the 402 challenge
 * by signing a EIP-3009 TransferWithAuthorization via the wallet
 * provider and retrying with an X-Payment header.
 *
 * Returns the final (paid) Response. If the server does not challenge
 * with 402, returns the original response unchanged.
 */
export declare function x402Fetch(wallet: WalletProvider, url: string, options?: X402PayOptions): Promise<Response>;
/**
 * Convenience: run x402Fetch and return parsed JSON body.
 * Throws on non-2xx after payment.
 */
export declare function x402PayJson<T = unknown>(wallet: WalletProvider, url: string, options?: X402PayOptions): Promise<T>;
