import chalk from 'chalk';
import ora from 'ora';
import { awalExec } from '../utils/awal.js';
export async function walletStatusCommand() {
    const spinner = ora('Getting wallet status...').start();
    try {
        const result = await awalExec(['status']);
        spinner.succeed('Wallet Status');
        console.log('');
        const data = result.data;
        for (const [key, value] of Object.entries(data)) {
            console.log(`  ${chalk.dim(key + ':')} ${value}`);
        }
        console.log('');
    }
    catch (err) {
        spinner.fail('Failed to get wallet status');
        console.error(chalk.red(err.message));
    }
}
export async function walletBalanceCommand() {
    const spinner = ora('Getting wallet balance...').start();
    try {
        const result = await awalExec(['balance']);
        spinner.succeed('Wallet Balance');
        console.log('');
        const data = result.data;
        if (typeof data === 'object' && data !== null) {
            for (const [key, value] of Object.entries(data)) {
                console.log(`  ${chalk.dim(key + ':')} ${chalk.green(String(value))}`);
            }
        }
        else {
            console.log(`  ${result.raw}`);
        }
        console.log('');
    }
    catch (err) {
        spinner.fail('Failed to get wallet balance');
        console.error(chalk.red(err.message));
    }
}
export async function walletAddressCommand() {
    const spinner = ora('Getting wallet address...').start();
    try {
        const result = await awalExec(['address']);
        spinner.succeed('Wallet Address');
        console.log('');
        const data = result.data;
        const address = data.address || result.raw.trim();
        console.log(`  ${chalk.cyan(String(address))}`);
        console.log('');
    }
    catch (err) {
        spinner.fail('Failed to get wallet address');
        console.error(chalk.red(err.message));
    }
}
export async function walletSendCommand(amount, to) {
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
        const data = result.data;
        if (data.txHash || data.hash || data.transactionHash) {
            const hash = data.txHash || data.hash || data.transactionHash;
            console.log(`  ${chalk.dim('TX Hash:')} ${chalk.cyan(String(hash))}`);
        }
        else {
            console.log(`  ${result.raw}`);
        }
        console.log('');
    }
    catch (err) {
        spinner.fail('Send failed');
        console.error(chalk.red(err.message));
    }
}
