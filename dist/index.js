#!/usr/bin/env node
import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { browseCommand } from './commands/browse.js';
import { promoteSubmitCommand, promoteVerifyCommand } from './commands/promote.js';
import { startAutoVerify } from './promote/auto-verify.js';
import { walletStatusCommand, walletBalanceCommand, walletAddressCommand, walletSendCommand, } from './commands/wallet.js';
import { tweetCommand } from './commands/tweet.js';
import { gigCreateCommand, gigBrowseCommand, gigDetailCommand, gigAcceptCommand, gigDeliverCommand, gigApproveCommand, gigDisputeCommand, } from './commands/gig.js';
import { hubStartCommand, hubStopCommand, hubStatusCommand, hubSearchCommand, hubCallCommand, hubRegisterCommand, hubSkillsCommand, hubOrderCommand, hubHistoryCommand, } from './commands/hub.js';
import { relayRegisterCommand, relayStartCommand, relayStopCommand, relayStatusCommand, relayModelsCommand, relayLogsCommand, relayPreflightCommand, } from './commands/relay.js';
import { antigravityLoginCommand, antigravityStatusCommand, } from './commands/antigravity.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const program = new Command();
program
    .name('clawmoney')
    .description('ClawMoney CLI -- Earn rewards with your AI agent')
    .version(pkg.version);
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
// account
program
    .command('account')
    .description('Show current agent info (wallet, email, slug)')
    .action(async () => {
    try {
        const { requireConfig } = await import('./utils/config.js');
        const { apiGet } = await import('./utils/api.js');
        const chalk = (await import('chalk')).default;
        const ora = (await import('ora')).default;
        const config = requireConfig();
        const spinner = ora('Fetching account info...').start();
        const resp = await apiGet('/api/v1/claw-agents/me', config.api_key);
        if (!resp.ok) {
            spinner.fail(`Failed: ${resp.status}`);
            process.exit(1);
        }
        const a = resp.data;
        spinner.succeed('Account');
        console.log('');
        console.log(`  ${chalk.bold('Agent:')}    ${a.name ?? '-'} (${a.slug ?? '-'})`);
        console.log(`  ${chalk.bold('ID:')}       ${a.id ?? '-'}`);
        console.log(`  ${chalk.bold('Email:')}    ${a.email ?? '-'}`);
        console.log(`  ${chalk.bold('Wallet:')}   ${a.wallet_address ?? 'not set'}`);
        console.log(`  ${chalk.bold('Status:')}   ${a.status ?? '-'}`);
        // Query Base mainnet USDC balance directly via JSON-RPC (no awal
        // dependency — works even if awal wallet bridge is down). Base USDC
        // is 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, balanceOf(address)
        // selector = 0x70a08231.
        if (a.wallet_address && typeof a.wallet_address === 'string') {
            try {
                const walletLower = a.wallet_address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
                const data = '0x70a08231' + walletLower;
                const rpcResp = await fetch('https://mainnet.base.org', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'eth_call',
                        params: [
                            {
                                to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                                data,
                            },
                            'latest',
                        ],
                    }),
                });
                const rpcData = (await rpcResp.json());
                if (rpcData.result) {
                    const atomic = BigInt(rpcData.result);
                    const usdc = Number(atomic) / 1_000_000;
                    console.log(`  ${chalk.bold('On-chain:')} $${usdc.toFixed(2)} USDC (Base)`);
                }
            }
            catch (err) {
                console.log(`  ${chalk.bold('On-chain:')} ${chalk.dim('(fetch failed)')}`);
            }
        }
        console.log('');
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
promote
    .command('auto-verify')
    .description('Start auto-verifier daemon (witness mode, $0.01/verification)')
    .action(async () => {
    try {
        await startAutoVerify();
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
// market
const market = program
    .command('market')
    .description('Agent Market: provide services, register skills');
market
    .command('start')
    .description('Start Market Provider (background process)')
    .option('--cli <command>', 'CLI command for task execution (default: from config or openclaw)')
    .option('--auto-accept', 'Auto-accept escrow tasks from the marketplace')
    .action(async (options) => {
    try {
        await hubStartCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
market
    .command('stop')
    .description('Stop Market Provider')
    .action(async () => {
    try {
        await hubStopCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
market
    .command('status')
    .description('Check Market Provider status')
    .action(async () => {
    try {
        await hubStatusCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
market
    .command('register')
    .description('Register a skill on the Market')
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
market
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
market
    .command('order <orderId>')
    .description('Check the status of a Market order')
    .action(async (orderId) => {
    try {
        await hubOrderCommand(orderId);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
market
    .command('history')
    .description('View Market activity: escrow tasks, orders, and provider log')
    .option('-t, --type <type>', 'Filter: all, escrow, orders, log', 'all')
    .option('-l, --limit <n>', 'Number of items to show', '10')
    .action(async (options) => {
    try {
        await hubHistoryCommand({ type: options.type, limit: parseInt(options.limit ?? '10', 10) });
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
market
    .command('search')
    .description('Search for agent services on the Market')
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
market
    .command('call')
    .description('Call another agent\'s service')
    .requiredOption('-a, --agent <agent>', 'Target agent slug or ID')
    .requiredOption('-s, --skill <skill>', 'Skill name to invoke')
    .option('-i, --input <json>', 'Input parameters as JSON')
    .option('-t, --timeout <seconds>', 'Timeout in seconds', '60')
    .option('--pay', 'Pay with USDC via x402 (default: ledger/free)')
    .action(async (options) => {
    try {
        await hubCallCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
// gig (escrow tasks)
const gig = program.command('gig').description('Gig marketplace: post and accept freelance tasks');
gig
    .command('create')
    .description('Post a new gig')
    .requiredOption('-t, --title <title>', 'Gig title')
    .requiredOption('-d, --description <desc>', 'What needs to be done')
    .requiredOption('-c, --category <category>', 'Category (e.g., generation/video, coding/review)')
    .requiredOption('-b, --budget <budget>', 'Budget in USD')
    .option('-r, --requirements <req>', 'Specific requirements')
    .action(async (options) => {
    try {
        await gigCreateCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
gig
    .command('browse')
    .description('Browse available gigs')
    .option('-c, --category <category>', 'Filter by category')
    .option('-s, --status <status>', 'Filter by status (open, assigned, delivered)')
    .option('-l, --limit <limit>', 'Number of results', '10')
    .action(async (options) => {
    try {
        await gigBrowseCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
gig
    .command('detail <task-id>')
    .description('View gig details')
    .action(async (taskId) => {
    try {
        await gigDetailCommand(taskId);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
gig
    .command('accept <task-id>')
    .description('Accept a gig')
    .action(async (taskId) => {
    try {
        await gigAcceptCommand(taskId);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
gig
    .command('deliver <task-id>')
    .description('Submit delivery for a gig')
    .option('-c, --content <text>', 'Delivery content (text)')
    .option('-u, --url <url>', 'Delivery URL (file, link, etc.)')
    .action(async (taskId, options) => {
    try {
        await gigDeliverCommand(taskId, options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
gig
    .command('approve <task-id>')
    .description('Approve delivery and release funds')
    .action(async (taskId) => {
    try {
        await gigApproveCommand(taskId);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
gig
    .command('dispute <task-id>')
    .description('Dispute a delivery')
    .action(async (taskId) => {
    try {
        await gigDisputeCommand(taskId);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
// relay (AI subscription resale)
const relay = program
    .command('relay')
    .description('Relay marketplace: sell idle AI subscription capacity');
relay
    .command('setup')
    .description('Interactive: detect installed CLIs, pick models, register all in one go (recommended for first-time setup)')
    .action(async () => {
    try {
        const { relaySetupCommand } = await import('./commands/relay-setup.js');
        await relaySetupCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
relay
    .command('register')
    .description('Register as a relay provider')
    .requiredOption('--cli <type>', 'Backend CLI: claude, codex, gemini, antigravity')
    .requiredOption('--model <model>', 'Model to offer (e.g., claude-opus-4-6)')
    .option('--mode <mode>', 'Safety mode: chat, search, code, full', 'chat')
    .option('--concurrency <n>', 'Max concurrent requests', '5')
    .option('--daily-limit <usd>', 'Max daily spend in USD', '20')
    .option('--price-input <usd>', 'Override input price per 1M (auto-populated from pricing.ts)')
    .option('--price-output <usd>', 'Override output price per 1M (auto-populated from pricing.ts)')
    .action(async (options) => {
    try {
        await relayRegisterCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
relay
    .command('start')
    .description('Start accepting relay requests')
    .option('--cli <type>', 'Override CLI type (claude, codex, gemini, antigravity)')
    .action(async (options) => {
    try {
        await relayStartCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
relay
    .command('stop')
    .description('Stop relay provider')
    .action(async () => {
    try {
        await relayStopCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
relay
    .command('status')
    .description('Check relay provider status')
    .action(async () => {
    try {
        await relayStatusCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
relay
    .command('logs')
    .description('Tail the daemon log in real time (like `tail -f ~/.clawmoney/relay.log`)')
    .option('-n, --lines <n>', 'Lines of history to show before following', '50')
    .option('--no-follow', "Print and exit instead of following")
    .action(async (options) => {
    try {
        await relayLogsCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
relay
    .command('models')
    .description('List available relay models')
    .action(async () => {
    try {
        await relayModelsCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
relay
    .command('preflight')
    .description('Validate upstream credentials without starting the daemon (useful for verifying openclaw fallback, keychain state, etc.)')
    .option('--cli <type>', 'Check a single cli_type (claude, codex, gemini, antigravity, minimax, zai, zai-coding, moonshot, kimi-coding, qwen-coding, openai). Default: claude+codex+gemini+antigravity.')
    .action(async (options) => {
    try {
        await relayPreflightCommand(options);
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
// antigravity (Google Antigravity IDE OAuth — separate quota pool + Claude access)
const antigravity = program
    .command('antigravity')
    .description('Google Antigravity IDE OAuth: link a Google account so the relay daemon can serve Claude + Gemini via the Antigravity quota pool');
antigravity
    .command('login')
    .description('OAuth browser flow to link a Google account')
    .action(async () => {
    try {
        await antigravityLoginCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
antigravity
    .command('status')
    .description('Show linked Antigravity accounts')
    .action(async () => {
    try {
        await antigravityStatusCommand();
    }
    catch (err) {
        console.error(err.message);
        process.exit(1);
    }
});
program.parse();
