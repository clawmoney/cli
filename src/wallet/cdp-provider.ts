import { apiGet, apiPost } from '../utils/api.js';
import type {
  Asset,
  Balance,
  Eip712TypedData,
  SendResult,
  SignedTypedData,
  WalletProvider,
} from './provider.js';

/**
 * CdpProvider: routes all wallet operations through bnbot-api's
 * /api/v1/claw-agents/me/wallet/* endpoints. The underlying keys live
 * in Coinbase CDP (Server Wallet v2) — this CLI never sees them.
 */
export class CdpProvider implements WalletProvider {
  constructor(private readonly apiKey: string) {}

  async getAddress(): Promise<string> {
    const res = await apiGet<{ wallet_address?: string }>(
      '/api/v1/claw-agents/me',
      this.apiKey
    );
    if (!res.ok || !res.data?.wallet_address) {
      throw new Error(
        res.ok
          ? 'Agent has no wallet yet; claim your agent via the link sent to your email.'
          : `Failed to fetch agent: ${res.status}`
      );
    }
    return res.data.wallet_address;
  }

  async getBalance(asset: Asset = 'usdc'): Promise<Balance> {
    const res = await apiGet<Balance>(
      `/api/v1/claw-agents/me/wallet/balance?asset=${asset}`,
      this.apiKey
    );
    if (!res.ok) {
      throw new Error(`Failed to get balance: ${res.status}`);
    }
    return res.data;
  }

  async signTypedData(
    typed: Eip712TypedData,
    idempotencyKey?: string
  ): Promise<SignedTypedData> {
    const res = await apiPost<SignedTypedData>(
      '/api/v1/claw-agents/me/wallet/sign-typed-data',
      { ...typed, idempotency_key: idempotencyKey },
      this.apiKey
    );
    if (!res.ok) {
      const err = (res.data as { detail?: string })?.detail ?? `HTTP ${res.status}`;
      throw new Error(`signTypedData failed: ${err}`);
    }
    return res.data;
  }

  async send(
    to: string,
    amount: string,
    asset: Asset = 'usdc',
    network?: string
  ): Promise<SendResult> {
    const res = await apiPost<SendResult>(
      '/api/v1/claw-agents/me/wallet/send',
      { to, amount, asset, network },
      this.apiKey
    );
    if (!res.ok) {
      const err = (res.data as { detail?: string })?.detail ?? `HTTP ${res.status}`;
      throw new Error(`send failed: ${err}`);
    }
    return res.data;
  }

  async getOnrampUrl(amountUsd: number = 5, network: string = 'base'): Promise<string> {
    const res = await apiPost<{ url: string }>(
      '/api/v1/claw-agents/me/wallet/onramp-url',
      { amount_usd: amountUsd, network },
      this.apiKey
    );
    if (!res.ok) {
      const err = (res.data as { detail?: string })?.detail ?? `HTTP ${res.status}`;
      throw new Error(`onramp url failed: ${err}`);
    }
    return res.data.url;
  }
}
