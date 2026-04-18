import { apiGet, apiPost } from '../utils/api.js';
/**
 * CdpProvider: routes all wallet operations through bnbot-api's
 * /api/v1/claw-agents/me/wallet/* endpoints. The underlying keys live
 * in Coinbase CDP (Server Wallet v2) — this CLI never sees them.
 */
export class CdpProvider {
    apiKey;
    constructor(apiKey) {
        this.apiKey = apiKey;
    }
    async getAddress() {
        const res = await apiGet('/api/v1/claw-agents/me', this.apiKey);
        if (!res.ok || !res.data?.wallet_address) {
            throw new Error(res.ok
                ? 'Agent has no wallet yet; claim your agent via the link sent to your email.'
                : `Failed to fetch agent: ${res.status}`);
        }
        return res.data.wallet_address;
    }
    async getBalance(asset = 'usdc') {
        const res = await apiGet(`/api/v1/claw-agents/me/wallet/balance?asset=${asset}`, this.apiKey);
        if (!res.ok) {
            throw new Error(`Failed to get balance: ${res.status}`);
        }
        return res.data;
    }
    async signTypedData(typed, idempotencyKey) {
        const res = await apiPost('/api/v1/claw-agents/me/wallet/sign-typed-data', { ...typed, idempotency_key: idempotencyKey }, this.apiKey);
        if (!res.ok) {
            const err = res.data?.detail ?? `HTTP ${res.status}`;
            throw new Error(`signTypedData failed: ${err}`);
        }
        return res.data;
    }
    async send(to, amount, asset = 'usdc', network) {
        const res = await apiPost('/api/v1/claw-agents/me/wallet/send', { to, amount, asset, network }, this.apiKey);
        if (!res.ok) {
            const err = res.data?.detail ?? `HTTP ${res.status}`;
            throw new Error(`send failed: ${err}`);
        }
        return res.data;
    }
    async getOnrampUrl(amountUsd = 5, network = 'base') {
        const res = await apiPost('/api/v1/claw-agents/me/wallet/onramp-url', { amount_usd: amountUsd, network }, this.apiKey);
        if (!res.ok) {
            const err = res.data?.detail ?? `HTTP ${res.status}`;
            throw new Error(`onramp url failed: ${err}`);
        }
        return res.data.url;
    }
}
