import { bytesToHex } from 'viem';
import type { WalletProvider, Eip712TypedData } from './provider.js';

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
  extra?: { name?: string; version?: string };
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

const CHAIN_IDS: Record<string, number> = {
  base: 8453,
  'base-sepolia': 84532,
  ethereum: 1,
  'ethereum-sepolia': 11155111,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  avalanche: 43114,
};

const EIP3009_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

function randomNonce32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function pickAccepts(challenge: X402Challenge): X402PaymentRequirement {
  const exact = challenge.accepts.filter((a) => a.scheme === 'exact');
  if (exact.length === 0) {
    throw new Error(
      `No supported x402 scheme. Server accepts: ${challenge.accepts.map((a) => a.scheme).join(', ')}`
    );
  }
  // Prefer Base mainnet; otherwise first match.
  return exact.find((a) => a.network === 'base') ?? exact[0];
}

async function signPaymentAuthorization(
  wallet: WalletProvider,
  req: X402PaymentRequirement,
  fromAddress: string
): Promise<{ signature: string; authorization: Record<string, string | number> }> {
  const chainId = CHAIN_IDS[req.network];
  if (!chainId) {
    throw new Error(`Unsupported x402 network: ${req.network}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const validAfter = "0";
  const validBefore = String(now + req.maxTimeoutSeconds);
  const nonce = randomNonce32();

  // x402 spec (and facilitator Zod schemas) require uint256 fields as
  // JSON strings, not numbers. CDP's sign_typed_data accepts either for
  // the signing input, but the X-Payment payload must be stringified.
  const authorization = {
    from: fromAddress,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter,
    validBefore,
    nonce,
  };

  const typed: Eip712TypedData = {
    domain: {
      name: req.extra?.name ?? 'USD Coin',
      version: req.extra?.version ?? '2',
      chainId,
      verifyingContract: req.asset,
    },
    types: {
      TransferWithAuthorization: EIP3009_TYPES.TransferWithAuthorization,
    },
    primary_type: 'TransferWithAuthorization',
    message: authorization,
  };

  // Idempotency key: random UUID (36 chars, CDP SDK's documented limit).
  // We can't use keccak(authorization) because its 66-char hex output
  // exceeds CDP's x_idempotency_key length cap. Since `nonce` inside
  // the authorization is already unique per request, a random UUID
  // here is sufficient to dedupe client-side retries.
  const idempotencyKey = crypto.randomUUID();

  const signed = await wallet.signTypedData(typed, idempotencyKey);
  return { signature: signed.signature, authorization };
}

function encodePaymentHeader(params: {
  scheme: string;
  network: string;
  signature: string;
  authorization: Record<string, string | number>;
}): string {
  const payload = {
    x402Version: 1,
    scheme: params.scheme,
    network: params.network,
    payload: {
      signature: params.signature,
      authorization: params.authorization,
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

/**
 * Execute an x402-protected HTTP request, handling the 402 challenge
 * by signing a EIP-3009 TransferWithAuthorization via the wallet
 * provider and retrying with an X-Payment header.
 *
 * Returns the final (paid) Response. If the server does not challenge
 * with 402, returns the original response unchanged.
 */
export async function x402Fetch(
  wallet: WalletProvider,
  url: string,
  options: X402PayOptions = {}
): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const body = options.body === undefined ? undefined
    : typeof options.body === 'string' ? options.body
    : JSON.stringify(options.body);

  if (body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const initialRes = await fetch(url, { method, headers, body });
  if (initialRes.status !== 402) {
    return initialRes;
  }

  const challenge = (await initialRes.json()) as X402Challenge;
  const requirement = pickAccepts(challenge);

  if (options.maxAmountAtomic) {
    const cap = BigInt(options.maxAmountAtomic);
    const asked = BigInt(requirement.maxAmountRequired);
    if (asked > cap) {
      throw new Error(
        `x402 payment ${asked} exceeds --max-amount cap ${cap} (network=${requirement.network})`
      );
    }
  }

  const fromAddress = await wallet.getAddress();
  const { signature, authorization } = await signPaymentAuthorization(
    wallet,
    requirement,
    fromAddress
  );
  const paymentHeader = encodePaymentHeader({
    scheme: requirement.scheme,
    network: requirement.network,
    signature,
    authorization,
  });

  const retryRes = await fetch(url, {
    method,
    headers: { ...headers, 'X-Payment': paymentHeader },
    body,
  });
  return retryRes;
}

/**
 * Convenience: run x402Fetch and return parsed JSON body.
 * Throws on non-2xx after payment.
 */
export async function x402PayJson<T = unknown>(
  wallet: WalletProvider,
  url: string,
  options: X402PayOptions = {}
): Promise<T> {
  const res = await x402Fetch(wallet, url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`x402 request failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}
