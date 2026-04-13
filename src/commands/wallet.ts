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

export async function walletBalanceCommand(): Promise<void> {
  const spinner = ora('Getting wallet balance...').start();

  // Kick off both calls in parallel. Relay earnings are loaded from
  // the clawmoney backend per-agent; the on-chain balance is awal's
  // native `balance` RPC. We don't block on-chain display if relay
  // fetching fails — the on-chain balance is the authoritative "real
  // money" view.
  const config = loadConfig();
  const relayPromise: Promise<RelayProviderRow[] | null> = config?.api_key
    ? apiGet<RelayProviderRow[]>("/api/v1/relay/providers/me", config.api_key)
        .then((resp) => (resp.ok && Array.isArray(resp.data) ? resp.data : null))
        .catch(() => null)
    : Promise.resolve(null);

  let awalResult;
  try {
    awalResult = await awalExec(['balance']);
  } catch (err) {
    spinner.fail('Failed to get wallet balance');
    console.error(chalk.red((err as Error).message));
    return;
  }

  const relayRows = await relayPromise;
  spinner.succeed('Wallet');
  console.log('');

  console.log(chalk.bold('  On-chain (awal)'));
  const data = awalResult.data as Record<string, unknown>;
  if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data)) {
      console.log(`    ${chalk.dim(key + ':').padEnd(22)} ${chalk.green(String(value))}`);
    }
  } else {
    console.log(`    ${awalResult.raw}`);
  }

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

    console.log('');
    console.log(chalk.bold('  Relay earnings'));
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
