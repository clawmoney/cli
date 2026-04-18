export interface Balance {
    asset: string;
    amount: string;
    decimals: number;
}
export interface SendResult {
    transaction_hash: string;
    transaction_link?: string;
    network?: string;
}
export interface SignedTypedData {
    signature: string;
    address: string;
}
export type Eip712TypedData = {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primary_type: string;
    message: Record<string, unknown>;
};
export type Asset = 'usdc' | 'eth';
export interface WalletProvider {
    getAddress(): Promise<string>;
    getBalance(asset?: Asset): Promise<Balance>;
    signTypedData(typed: Eip712TypedData, idempotencyKey?: string): Promise<SignedTypedData>;
    send(to: string, amount: string, asset?: Asset, network?: string): Promise<SendResult>;
    getOnrampUrl(amountUsd?: number, network?: string): Promise<string>;
}
