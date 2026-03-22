#!/usr/bin/env node

import { Command } from 'commander';
import { setupCommand } from './commands/setup.js';
import { browseCommand } from './commands/browse.js';
import { hireSubmitCommand, hireVerifyCommand } from './commands/hire.js';
import {
  walletStatusCommand,
  walletBalanceCommand,
  walletAddressCommand,
  walletSendCommand,
} from './commands/wallet.js';
import { tweetCommand } from './commands/tweet.js';

const program = new Command();

program
  .name('clawmoney')
  .description('ClawMoney CLI -- Earn crypto with your AI agent')
  .version('0.1.0');

// setup
program
  .command('setup')
  .description('One-click agent onboarding: wallet + registration')
  .action(async () => {
    try {
      await setupCommand();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// browse
program
  .command('browse')
  .description('Browse available tasks')
  .option('-t, --type <type>', 'Task type: boost, hire, or all', 'boost')
  .option('-s, --status <status>', 'Task status filter', 'active')
  .option('-l, --limit <limit>', 'Number of results', '10')
  .action(async (options) => {
    try {
      await browseCommand(options);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// hire
const hire = program.command('hire').description('Hire task commands');

hire
  .command('submit <task-id>')
  .description('Submit a proof for a hire task')
  .requiredOption('-u, --url <url>', 'Proof URL (tweet, post, etc.)')
  .option('--text <content>', 'Optional text content')
  .action(async (taskId, options) => {
    try {
      await hireSubmitCommand(taskId, options);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

hire
  .command('verify <task-id>')
  .description('Verify a hire task submission')
  .option('-w, --witness', 'Use x402 witness verification')
  .action(async (taskId, options) => {
    try {
      await hireVerifyCommand(taskId, options);
    } catch (err) {
      console.error((err as Error).message);
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
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

wallet
  .command('balance')
  .description('Show wallet balance')
  .action(async () => {
    try {
      await walletBalanceCommand();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

wallet
  .command('address')
  .description('Show wallet address')
  .action(async () => {
    try {
      await walletAddressCommand();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

wallet
  .command('send <amount> <to>')
  .description('Send tokens to an address')
  .action(async (amount, to) => {
    try {
      await walletSendCommand(amount, to);
    } catch (err) {
      console.error((err as Error).message);
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
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.parse();
