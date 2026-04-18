import type { Asset, Balance, Eip712TypedData, SendResult, SignedTypedData, WalletProvider } from './provider.js';
/**
 * CdpProvider: routes all wallet operations through bnbot-api's
 * /api/v1/claw-agents/me/wallet/* endpoints. The underlying keys live
 * in Coinbase CDP (Server Wallet v2) — this CLI never sees them.
 */
export declare class CdpProvider implements WalletProvider {
    private readonly apiKey;
    constructor(apiKey: string);
    getAddress(): Promise<string>;
    getBalance(asset?: Asset): Promise<Balance>;
    signTypedData(typed: Eip712TypedData, idempotencyKey?: string): Promise<SignedTypedData>;
    send(to: string, amount: string, asset?: Asset, network?: string): Promise<SendResult>;
    getOnrampUrl(amountUsd?: number, network?: string): Promise<string>;
}
