import chalk from 'chalk';
import ora from 'ora';
import { awalExec } from '../utils/awal.js';
import { apiGet } from '../utils/api.js';
import { loadConfig } from '../utils/config.js';

export async function walletStatusCommand(): Promise<void> {
  const spinner = ora('Getting wallet status...').start();
  try {
    const result = await awalExec(['status']);
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

  // Kick off both calls in parallel. Relay earnings are loaded from
  // the clawmoney backend per-agent; the on-chain balance is awal's
  // native `balance` RPC. Either half is allowed to fail — we print
  // a dim "(unavailable)" note for that section and keep going.
  const config = loadConfig();
  const relayPromise: Promise<RelayProviderRow[] | null> = config?.api_key
    ? apiGet<RelayProviderRow[]>("/api/v1/relay/providers/me", config.api_key)
        .then((resp) => (resp.ok && Array.isArray(resp.data) ? resp.data : null))
        .catch(() => null)
    : Promise.resolve(null);

  // 10s is generous — awal balance usually returns in 1-2s. Beyond
  // that the wallet process is probably wedged and the user wants
  // the rest of the output immediately.
  let awalResult: Awaited<ReturnType<typeof awalExec>> | null = null;
  let awalError: string | null = null;
  try {
    awalResult = await withTimeout(awalExec(['balance']), 10_000, 'awal balance');
  } catch (err) {
    awalError = (err as Error).message;
  }

  const relayRows = await relayPromise;
  spinner.stop();
  console.log('');
  console.log(chalk.bold('  Wallet'));
  console.log('');

  console.log(chalk.bold('  On-chain (awal)'));
  if (awalResult) {
    const data = awalResult.data as Record<string, unknown>;
    if (typeof data === 'object' && data !== null && Object.keys(data).length > 0) {
      for (const [key, value] of Object.entries(data)) {
        console.log(`    ${chalk.dim(key + ':').padEnd(22)} ${chalk.green(String(value))}`);
      }
    } else {
      console.log(`    ${chalk.dim(awalResult.raw || '(empty)')}`);
    }
  } else {
    console.log(`    ${chalk.yellow('unavailable')} ${chalk.dim('(' + (awalError ?? 'unknown error') + ')')}`);
    console.log(
      chalk.dim('    Try:  npx awal status   |   clawmoney wallet status')
    );
  }

  console.log('');
  console.log(chalk.bold('  Relay earnings'));
  if (relayRows && relayRows.length > 0) {
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
      `    ${chalk.dim('Earned:').padEnd(22)} ${chalk.green('$' + earned.toFixed(2))}`
    );
    console.log(
      `    ${chalk.dim('Pending payout:').padEnd(22)} ${chalk.green('$' + pending.toFixed(2))}`
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
    const result = await awalExec(['address']);
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
