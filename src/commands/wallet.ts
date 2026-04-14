import chalk from 'chalk';
import ora from 'ora';
import { awalExec, awalExecSafe } from '../utils/awal.js';
import { apiGet } from '../utils/api.js';
import { loadConfig, saveConfig } from '../utils/config.js';

// Base mainnet USDC contract + balanceOf(address) ABI selector.
// Keeping on-chain reads as a first-class path lets `wallet balance`
// skip the awal Electron bridge entirely, which is notorious for
// cold-starting slowly or hanging if the daemon isn't warm.
const BASE_RPC_URL = 'https://mainnet.base.org';
const BASE_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BALANCE_OF_SELECTOR = '0x70a08231';
const USDC_DECIMALS = 1_000_000;

async function readBaseUsdcBalance(walletAddress: string, timeoutMs = 8000): Promise<number> {
  const paddedAddr = walletAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = BALANCE_OF_SELECTOR + paddedAddr;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: BASE_USDC_CONTRACT, data }, 'latest'],
      }),
      signal: ctrl.signal,
    });
    const json = (await resp.json()) as { result?: string; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message || 'RPC error');
    if (!json.result) throw new Error('empty RPC result');
    const atomic = BigInt(json.result);
    return Number(atomic) / USDC_DECIMALS;
  } finally {
    clearTimeout(timer);
  }
}

export async function walletStatusCommand(): Promise<void> {
  const spinner = ora('Getting wallet status...').start();
  try {
    // Read-only, safe to auto-retry after killing a wedged awal.
    const result = await awalExecSafe(['status'], { timeoutMs: 8_000 });
    spinner.succeed('Wallet Status');
    console.log('');
    const data = result.data as Record<string, unknown>;
    for (const [key, value] of Object.entries(data)) {
      console.log(`  ${chalk.dim(key + ':')} ${value}`);
    }
    console.log('');
  } catch (err) {
    spinner.fail('Failed to get wallet status');
    console.error(chalk.red((err as Error).message));
  }
}

interface RelayProviderRow {
  id?: string;
  cli_type?: string;
  model?: string;
  total_earned_usd?: number;
  total_withdrawn_usd?: number;
  total_requests?: number;
}

// Wrap a promise in a hard timeout so a hung awal process can't
// swallow the whole command. On timeout we surface a specific
// error string the caller can tell apart from generic spawn errors.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export async function walletBalanceCommand(): Promise<void> {
  const spinner = ora('Getting wallet balance...').start();

  // Source of truth for on-chain balance: direct JSON-RPC to Base
  // mainnet USDC, not `awal balance`. Reasons:
  //   - awal is an Electron app; cold-starting it via `npx` takes 3-10s
  //     and occasionally wedges under load (see GH issues around
  //     DEP0190 / pipe buffers).
  //   - We already store the wallet address in ~/.clawmoney/config.yaml
  //     at setup time, so we don't need awal to look it up.
  //   - RPC reads are idempotent, cacheable, and cost nothing.
  // Relay earnings are fetched in parallel from the clawmoney backend.
  // Either half is allowed to fail — we print "(unavailable)" for the
  // broken section and keep going.
  const config = loadConfig();

  // Wallet address lookup order:
  //   1. ~/.clawmoney/config.yaml cache (instant)
  //   2. Backend /api/v1/claw-agents/me (authoritative, ~200ms)
  //   3. awal address (Electron cold-start, last resort, 5s cap)
  // After a successful #2 we write the result back to the config so
  // every future `wallet balance` hits path #1.
  let walletAddress: string | null = config?.wallet_address ?? null;
  let addressSource = 'config';
  let addressError: string | null = null;

  if (!walletAddress && config?.api_key) {
    try {
      const resp = await apiGet<{ wallet_address?: string }>(
        '/api/v1/claw-agents/me',
        config.api_key
      );
      if (resp.ok && typeof resp.data?.wallet_address === 'string' && resp.data.wallet_address) {
        walletAddress = resp.data.wallet_address;
        addressSource = 'api';
        // Cache it so the next run is instant.
        try {
          saveConfig({ wallet_address: walletAddress });
        } catch {
          // Non-fatal — we still have the address for THIS run.
        }
      }
    } catch (err) {
      addressError = (err as Error).message;
    }
  }

  if (!walletAddress) {
    // Last resort: cold-start awal. Uses awalExecSafe so a wedged
    // Electron is automatically killed + retried before surfacing
    // the error. Capped at 6s per attempt.
    try {
      const awalResult = await awalExecSafe(['address'], { timeoutMs: 6_000 });
      const data = awalResult.data as Record<string, unknown>;
      if (typeof data?.address === 'string' && data.address) {
        walletAddress = data.address;
        addressSource = 'awal';
      }
    } catch (err) {
      addressError = (err as Error).message;
    }
  }

  const relayPromise: Promise<RelayProviderRow[] | null> = config?.api_key
    ? apiGet<RelayProviderRow[]>("/api/v1/relay/providers/me", config.api_key)
        .then((resp) => (resp.ok && Array.isArray(resp.data) ? resp.data : null))
        .catch(() => null)
    : Promise.resolve(null);

  let usdcBalance: number | null = null;
  let onchainError: string | null = null;
  if (walletAddress) {
    try {
      usdcBalance = await readBaseUsdcBalance(walletAddress);
    } catch (err) {
      onchainError = (err as Error).message;
    }
  } else {
    onchainError = addressError ?? 'no wallet address in config';
  }
  void addressSource;  // reserved for future debug display

  const relayRows = await relayPromise;
  spinner.stop();
  console.log('');
  console.log(chalk.bold('  Wallet'));
  console.log('');

  console.log(chalk.bold('  On-chain (Base USDC)'));
  if (walletAddress) {
    console.log(`    ${chalk.dim('Address:').padEnd(22)} ${chalk.cyan(walletAddress)}`);
  }
  if (usdcBalance !== null) {
    console.log(
      `    ${chalk.dim('USDC:').padEnd(22)} ${chalk.green('$' + usdcBalance.toFixed(2))}`
    );
  } else {
    console.log(
      `    ${chalk.yellow('unavailable')} ${chalk.dim('(' + (onchainError ?? 'unknown') + ')')}`
    );
  }

  console.log('');
  console.log(chalk.bold('  Pending payout (Relay)'));
  if (relayRows && relayRows.length > 0) {
    // "Earned lifetime" is vanity — the only thing that matters for
    // the wallet view is: how much is already in the on-chain wallet
    // (shown above as USDC), and how much is still owed to the user
    // (pending = earned - withdrawn). Those two numbers together
    // tell the full story; showing "earned" separately would double-
    // count the wallet USDC that came from relay payouts.
    const earned = relayRows.reduce((s, p) => s + (p.total_earned_usd ?? 0), 0);
    const withdrawn = relayRows.reduce(
      (s, p) => s + (p.total_withdrawn_usd ?? 0),
      0
    );
    const pending = Math.max(0, earned - withdrawn);
    const requests = relayRows.reduce(
      (s, p) => s + (p.total_requests ?? 0),
      0
    );
    console.log(
      `    ${chalk.dim('Amount:').padEnd(22)} ${chalk.green('$' + pending.toFixed(2))}`
    );
    console.log(
      chalk.dim(
        `    (${relayRows.length} provider${relayRows.length === 1 ? "" : "s"} · ${requests} request${requests === 1 ? "" : "s"} served)`
      )
    );
  } else if (relayRows && relayRows.length === 0) {
    console.log(`    ${chalk.dim('No providers registered yet. Run `clawmoney relay setup` to start earning.')}`);
  } else {
    console.log(`    ${chalk.yellow('unavailable')} ${chalk.dim('(relay backend unreachable)')}`);
  }

  console.log('');
}

export async function walletAddressCommand(): Promise<void> {
  const spinner = ora('Getting wallet address...').start();
  try {
    // Read-only, safe to auto-retry on awal wedge.
    const result = await awalExecSafe(['address'], { timeoutMs: 8_000 });
    spinner.succeed('Wallet Address');
    console.log('');
    const data = result.data as Record<string, unknown>;
    const address = data.address || result.raw.trim();
    console.log(`  ${chalk.cyan(String(address))}`);
    console.log('');
  } catch (err) {
    spinner.fail('Failed to get wallet address');
    console.error(chalk.red((err as Error).message));
  }
}

export async function walletSendCommand(
  amount: string,
  to: string
): Promise<void> {
  console.log('');
  console.log(chalk.bold('  Send Transaction'));
  console.log(chalk.dim(`  Amount: ${amount}`));
  console.log(chalk.dim(`  To:     ${to}`));
  console.log('');

  const spinner = ora('Sending...').start();
  try {
    const result = await awalExec(['send', amount, to]);
    spinner.succeed('Transaction sent');
    console.log('');
    const data = result.data as Record<string, unknown>;
    if (data.txHash || data.hash || data.transactionHash) {
      const hash = data.txHash || data.hash || data.transactionHash;
      console.log(`  ${chalk.dim('TX Hash:')} ${chalk.cyan(String(hash))}`);
    } else {
      console.log(`  ${result.raw}`);
    }
    console.log('');
  } catch (err) {
    spinner.fail('Send failed');
    console.error(chalk.red((err as Error).message));
  }
}
