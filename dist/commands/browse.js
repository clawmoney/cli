import chalk from 'chalk';
import ora from 'ora';
import { apiGet } from '../utils/api.js';
import { loadConfig } from '../utils/config.js';
function formatUsd(amount, decimals = 6) {
    if (amount === undefined || amount === null)
        return '-';
    const num = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(num))
        return '-';
    const usd = num / Math.pow(10, decimals);
    return `$${usd.toFixed(2)}`;
}
function truncate(str, maxLen) {
    if (!str)
        return '-';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '...' : str;
}
function printBoostTable(tasks) {
    if (tasks.length === 0) {
        console.log(chalk.dim('  No boost tasks found.'));
        return;
    }
    // Header
    console.log(chalk.bold(`  ${'ID'.padEnd(8)} ${'Title'.padEnd(30)} ${'Reward'.padEnd(10)} ${'Budget'.padEnd(10)} ${'Joined'.padEnd(8)} ${'Status'.padEnd(10)}`));
    console.log(chalk.dim('  ' + '-'.repeat(80)));
    for (const task of tasks) {
        const id = String(task.id).slice(0, 7);
        const title = truncate(task.title || task.tweet_url, 28);
        const reward = formatUsd(task.reward_per_user);
        const budget = formatUsd(task.total_budget);
        const joined = String(task.participants_count ?? '-');
        const status = task.status || '-';
        console.log(`  ${chalk.cyan(id.padEnd(8))} ${title.padEnd(30)} ${chalk.green(reward.padEnd(10))} ${budget.padEnd(10)} ${joined.padEnd(8)} ${status.padEnd(10)}`);
    }
}
function printHireTable(tasks) {
    if (tasks.length === 0) {
        console.log(chalk.dim('  No hire tasks found.'));
        return;
    }
    // Header
    console.log(chalk.bold(`  ${'ID'.padEnd(8)} ${'Title'.padEnd(30)} ${'Budget'.padEnd(10)} ${'Subs'.padEnd(6)} ${'Platform'.padEnd(10)} ${'Ends'.padEnd(12)}`));
    console.log(chalk.dim('  ' + '-'.repeat(78)));
    for (const task of tasks) {
        const id = String(task.id).slice(0, 7);
        const title = truncate(task.title, 28);
        const budget = formatUsd(task.total_budget);
        const subs = String(task.submission_count ?? '-');
        const platform = task.platform || 'twitter';
        const ends = task.end_time ? new Date(task.end_time).toLocaleDateString() : '-';
        console.log(`  ${chalk.cyan(id.padEnd(8))} ${title.padEnd(30)} ${chalk.green(budget.padEnd(10))} ${subs.padEnd(6)} ${platform.padEnd(10)} ${ends.padEnd(12)}`);
    }
}
export async function browseCommand(options) {
    const config = loadConfig();
    const apiKey = config?.api_key;
    const taskType = options.type || 'boost';
    const status = options.status || 'active';
    const limit = parseInt(options.limit || '10', 10);
    console.log('');
    if (taskType === 'hire' || taskType === 'all') {
        const hireSpinner = ora('Fetching hire tasks...').start();
        try {
            const resp = await apiGet(`/api/v1/hire/?status=${status}&sort_by=total_budget&sort_order=desc&limit=${limit}`, apiKey);
            if (!resp.ok) {
                hireSpinner.fail(`Failed to fetch hire tasks (${resp.status})`);
            }
            else {
                const body = resp.data;
                const tasks = (body.data || (Array.isArray(body) ? body : []));
                hireSpinner.succeed(`Hire Tasks (${tasks.length})`);
                printHireTable(tasks);
            }
        }
        catch (err) {
            hireSpinner.fail('Failed to fetch hire tasks');
            console.error(chalk.red(err.message));
        }
        console.log('');
    }
    if (taskType === 'boost' || taskType === 'all') {
        const boostSpinner = ora('Fetching boost tasks...').start();
        try {
            const resp = await apiGet(`/api/v1/tasks/?status=${status}&sort=reward&limit=${limit}`, apiKey);
            if (!resp.ok) {
                boostSpinner.fail(`Failed to fetch boost tasks (${resp.status})`);
            }
            else {
                const body = resp.data;
                const tasks = (body.data || (Array.isArray(body) ? body : []));
                boostSpinner.succeed(`Boost Tasks (${tasks.length})`);
                printBoostTable(tasks);
            }
        }
        catch (err) {
            boostSpinner.fail('Failed to fetch boost tasks');
            console.error(chalk.red(err.message));
        }
        console.log('');
    }
}
