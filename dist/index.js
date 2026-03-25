#!/usr/bin/env node
import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { browseCommand } from './commands/browse.js';
import { promoteSubmitCommand, promoteVerifyCommand } from './commands/promote.js';
import { walletStatusCommand, walletBalanceCommand, walletAddressCommand, walletSendCommand, } from './commands/wallet.js';
import { tweetCommand } from './commands/tweet.js';
import { hubStartCommand, hubStopCommand, hubStatusCommand, hubSearchCommand, hubCallCommand, hubRegisterCommand, hubSkillsCommand, } from './commands/hub.js';
const program = new Command();
program
    .name('clawmoney')
    .description('ClawMoney CLI -- Earn rewards with your AI agent')
    .version('0.8.7');
// setup
program
    .command('setup')
    .description('One-click agent onboarding: wallet + registration')
    .action(async () => {
    try {
        await setupCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
// browse
program
    .command('browse')
    .description('Browse available tasks')
    .option('-t, --type <type>', 'Task type: engage, promote, or all', 'engage')
    .option('-s, --status <status>', 'Task status filter', 'active')
    .option('-l, --limit <limit>', 'Number of results', '10')
    .action(async (options) => {
    try {
        await browseCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
// promote
const promote = program.command('promote').description('Promote task commands');
promote
    .command('submit <task-id>')
    .description('Submit a proof for a promote task')
    .requiredOption('-u, --url <url>', 'Proof URL (tweet, post, etc.)')
    .option('-p, --platform <platform>', 'Platform (auto-detected from task)')
    .option('--text <content>', 'Optional text content')
    .action(async (taskId, options) => {
    try {
        await promoteSubmitCommand(taskId, options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
promote
    .command('verify <submission-id>')
    .description('Verify a promote submission')
    .option('-w, --witness', 'Use x402 witness verification ($0.01)')
    .requiredOption('-r, --relevance <score>', 'Relevance score (1-10)')
    .requiredOption('-q, --quality <score>', 'Quality score (1-10)')
    .option('-v, --vote <vote>', 'Vote: approve or reject', 'approve')
    .action(async (taskId, options) => {
    try {
        await promoteVerifyCommand(taskId, options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
// wallet
const wallet = program.command('wallet').description('Wallet commands (via awal)');
wallet
    .command('status')
    .description('Show wallet authentication status')
    .action(async () => {
    try {
        await walletStatusCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
wallet
    .command('balance')
    .description('Show wallet balance')
    .action(async () => {
    try {
        await walletBalanceCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
wallet
    .command('address')
    .description('Show wallet address')
    .action(async () => {
    try {
        await walletAddressCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
wallet
    .command('send <amount> <to>')
    .description('Send tokens to an address')
    .action(async (amount, to) => {
    try {
        await walletSendCommand(amount, to);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
// tweet
program
    .command('tweet <text>')
    .description('Post a tweet via BNBot Chrome Extension')
    .option('-m, --media <path>', 'Path to media file')
    .option('-d, --draft', 'Draft mode: fill tweet composer without posting')
    .action(async (text, options) => {
    try {
        await tweetCommand(text, options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
// hub
const hub = program
    .command('hub')
    .description('Agent Hub: provide services, register skills');
hub
    .command('start')
    .description('Start Hub Provider (background process)')
    .option('--cli <command>', 'CLI command for task execution (default: from config or openclaw)')
    .action(async (options) => {
    try {
        await hubStartCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
hub
    .command('stop')
    .description('Stop Hub Provider')
    .action(async () => {
    try {
        await hubStopCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
hub
    .command('status')
    .description('Check Hub Provider status')
    .action(async () => {
    try {
        await hubStatusCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
hub
    .command('register')
    .description('Register a skill on the Hub')
    .requiredOption('-n, --name <name>', 'Skill name')
    .requiredOption('-c, --category <category>', 'Category (e.g., generation/image)')
    .requiredOption('-d, --description <desc>', 'Description')
    .requiredOption('-p, --price <price>', 'Price per call in USD')
    .action(async (options) => {
    try {
        await hubRegisterCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
hub
    .command('skills')
    .description('List my registered skills')
    .action(async () => {
    try {
        await hubSkillsCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
hub
    .command('search')
    .description('Search for agent services on the Hub')
    .option('-q, --query <query>', 'Keyword search')
    .option('-c, --category <category>', 'Category filter (e.g., generation/image)')
    .option('-s, --sort <sort>', 'Sort by: rating, price, response_time', 'rating')
    .option('-l, --limit <limit>', 'Number of results', '10')
    .option('--max-price <price>', 'Maximum price filter')
    .action(async (options) => {
    try {
        await hubSearchCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
hub
    .command('call')
    .description('Call another agent\'s service')
    .requiredOption('-a, --agent <agent>', 'Target agent slug or ID')
    .requiredOption('-s, --skill <skill>', 'Skill name to invoke')
    .option('-i, --input <json>', 'Input parameters as JSON')
    .option('-t, --timeout <seconds>', 'Timeout in seconds', '60')
    .action(async (options) => {
    try {
        await hubCallCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
program.parse();
