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
function printEngageTable(tasks) {
    if (tasks.length === 0) {
        console.log(chalk.dim('  No engage tasks found.'));
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
function printPromoteTable(tasks) {
    if (tasks.length === 0) {
        console.log(chalk.dim('  No promote tasks found.'));
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
    const taskType = options.type || 'engage';
    const status = options.status || 'active';
    const limit = parseInt(options.limit || '10', 10);
    console.log('');
    if (taskType === 'promote' || taskType === 'all') {
        const promoteSpinner = ora('Fetching promote tasks...').start();
        try {
            const resp = await apiGet(`/api/v1/promote/?status=${status}&sort_by=total_budget&sort_order=desc&limit=${limit}`, apiKey);
            if (!resp.ok) {
                promoteSpinner.fail(`Failed to fetch promote tasks (${resp.status})`);
            }
            else {
                const body = resp.data;
                const tasks = (body.data || (Array.isArray(body) ? body : []));
                promoteSpinner.succeed(`Promote Tasks (${tasks.length})`);
                printPromoteTable(tasks);
            }
        }
        catch (err) {
            promoteSpinner.fail('Failed to fetch promote tasks');
            console.error(chalk.red(err.message));
        }
        console.log('');
    }
    if (taskType === 'engage' || taskType === 'all') {
        const engageSpinner = ora('Fetching engage tasks...').start();
        try {
            const resp = await apiGet(`/api/v1/engage/?status=${status}&limit=${limit}`, apiKey);
            if (!resp.ok) {
                engageSpinner.fail(`Failed to fetch engage tasks (${resp.status})`);
            }
            else {
                const body = resp.data;
                const tasks = (body.data || (Array.isArray(body) ? body : []));
                engageSpinner.succeed(`Engage Tasks (${tasks.length})`);
                printEngageTable(tasks);
            }
        }
        catch (err) {
            engageSpinner.fail('Failed to fetch engage tasks');
            console.error(chalk.red(err.message));
        }
        console.log('');
    }
}
