import chalk from 'chalk';
import ora from 'ora';
import { apiGet } from '../utils/api.js';
import { loadConfig, requireConfig, saveConfig } from '../utils/config.js';
import { CdpProvider } from '../wallet/cdp-provider.js';
// On-chain balance is read directly over public RPC to avoid a hot-path
// round-trip through the backend for a plain USDC balance query.
const BASE_RPC_URL = 'https://mainnet.base.org';
const BASE_USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BALANCE_OF_SELECTOR = '0x70a08231';
const USDC_DECIMALS = 1_000_000;
async function readBaseUsdcBalance(walletAddress, timeoutMs = 8000) {
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
        const json = (await resp.json());
        if (json.error)
            throw new Error(json.error.message || 'RPC error');
        if (!json.result)
            throw new Error('empty RPC result');
        const atomic = BigInt(json.result);
        return Number(atomic) / USDC_DECIMALS;
    }
    finally {
        clearTimeout(timer);
    }
}
export async function walletStatusCommand() {
    const spinner = ora('Getting wallet status...').start();
    try {
        const config = requireConfig();
        const wallet = new CdpProvider(config.api_key);
        const address = await wallet.getAddress();
        spinner.succeed('Wallet Status');
        console.log('');
        console.log(`  ${chalk.dim('Address:')} ${chalk.cyan(address)}`);
        console.log(`  ${chalk.dim('Custody:')} Coinbase CDP Server Wallet`);
        console.log(`  ${chalk.dim('Network:')} Base`);
        console.log('');
    }
    catch (err) {
        spinner.fail('Failed to get wallet status');
        console.error(chalk.red(err.message));
    }
}
export async function walletBalanceCommand() {
    const spinner = ora('Getting wallet balance...').start();
    // Source of truth for on-chain balance: direct JSON-RPC to Base mainnet
    // USDC. The wallet address comes from config.yaml (set at setup time) or
    // the backend /me endpoint. Relay earnings are fetched in parallel.
    const config = loadConfig();
    let walletAddress = config?.wallet_address ?? null;
    let addressError = null;
    if (!walletAddress && config?.api_key) {
        try {
            const resp = await apiGet('/api/v1/claw-agents/me', config.api_key);
            if (resp.ok && typeof resp.data?.wallet_address === 'string' && resp.data.wallet_address) {
                walletAddress = resp.data.wallet_address;
                try {
                    saveConfig({ wallet_address: walletAddress });
                }
                catch {
                    // Non-fatal — we still have the address for THIS run.
                }
            }
        }
        catch (err) {
            addressError = err.message;
        }
    }
    const relayPromise = config?.api_key
        ? apiGet("/api/v1/relay/providers/me", config.api_key)
            .then((resp) => (resp.ok && Array.isArray(resp.data) ? resp.data : null))
            .catch(() => null)
        : Promise.resolve(null);
    let usdcBalance = null;
    let onchainError = null;
    if (walletAddress) {
        try {
            usdcBalance = await readBaseUsdcBalance(walletAddress);
        }
        catch (err) {
            onchainError = err.message;
        }
    }
    else {
        onchainError = addressError ?? 'no wallet address in config';
    }
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
        console.log(`    ${chalk.dim('USDC:').padEnd(22)} ${chalk.green('$' + usdcBalance.toFixed(2))}`);
    }
    else {
        console.log(`    ${chalk.yellow('unavailable')} ${chalk.dim('(' + (onchainError ?? 'unknown') + ')')}`);
    }
    console.log('');
    console.log(chalk.bold('  Pending payout (Relay)'));
    if (relayRows && relayRows.length > 0) {
        const earned = relayRows.reduce((s, p) => s + (p.total_earned_usd ?? 0), 0);
        const withdrawn = relayRows.reduce((s, p) => s + (p.total_withdrawn_usd ?? 0), 0);
        const pending = Math.max(0, earned - withdrawn);
        const requests = relayRows.reduce((s, p) => s + (p.total_requests ?? 0), 0);
        console.log(`    ${chalk.dim('Amount:').padEnd(22)} ${chalk.green('$' + pending.toFixed(2))}`);
        console.log(chalk.dim(`    (${relayRows.length} provider${relayRows.length === 1 ? "" : "s"} · ${requests} request${requests === 1 ? "" : "s"} served)`));
    }
    else if (relayRows && relayRows.length === 0) {
        console.log(`    ${chalk.dim('No providers registered yet. Run `clawmoney relay setup` to start earning.')}`);
    }
    else {
        console.log(`    ${chalk.yellow('unavailable')} ${chalk.dim('(relay backend unreachable)')}`);
    }
    console.log('');
}
export async function walletAddressCommand() {
    const spinner = ora('Getting wallet address...').start();
    try {
        const config = requireConfig();
        // Fast path: config.yaml cache (written at setup).
        if (config.wallet_address) {
            spinner.succeed('Wallet Address');
            console.log('');
            console.log(`  ${chalk.cyan(config.wallet_address)}`);
            console.log('');
            return;
        }
        const wallet = new CdpProvider(config.api_key);
        const address = await wallet.getAddress();
        // Cache back to config.
        try {
            saveConfig({ wallet_address: address });
        }
        catch {
            // Non-fatal.
        }
        spinner.succeed('Wallet Address');
        console.log('');
        console.log(`  ${chalk.cyan(address)}`);
        console.log('');
    }
    catch (err) {
        spinner.fail('Failed to get wallet address');
        console.error(chalk.red(err.message));
    }
}
export async function walletSendCommand(amount, to) {
    console.log('');
    console.log(chalk.bold('  Send USDC'));
    console.log(chalk.dim(`  Amount: ${amount}`));
    console.log(chalk.dim(`  To:     ${to}`));
    console.log('');
    const spinner = ora('Sending...').start();
    try {
        const config = requireConfig();
        const wallet = new CdpProvider(config.api_key);
        // `amount` is the user-facing decimal (e.g. "1.5"); convert to atomic (6dp for USDC).
        const [whole, frac = ''] = amount.split('.');
        const paddedFrac = (frac + '000000').slice(0, 6);
        const atomic = BigInt(whole || '0') * 1000000n + BigInt(paddedFrac || '0');
        const result = await wallet.send(to, atomic.toString(), 'usdc');
        spinner.succeed('Transaction sent');
        console.log('');
        if (result.transaction_hash) {
            console.log(`  ${chalk.dim('TX Hash:')} ${chalk.cyan(result.transaction_hash)}`);
        }
        if (result.transaction_link) {
            console.log(`  ${chalk.dim('Link:')}    ${chalk.cyan(result.transaction_link)}`);
        }
        console.log('');
    }
    catch (err) {
        spinner.fail('Send failed');
        console.error(chalk.red(err.message));
    }
}
