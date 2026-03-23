#!/usr/bin/env node
import { Command } from 'commander';
import { tweetCommand, closeCommand, likeCommand, retweetCommand, replyCommand, followCommand, serveCommand, statusCommand } from './commands/actions.js';
const program = new Command();
program
    .name('bnbot')
    .description('BNBot CLI — Automate Twitter/X from your terminal')
    .version('2.1.0');
// tweet subcommand group
const tweet = program.command('tweet').description('Tweet commands');
tweet
    .command('post <text>')
    .description('Post a tweet')
    .option('-m, --media <url>', 'Media URL to attach')
    .option('-d, --draft', 'Draft mode: fill composer without posting')
    .action(tweetCommand);
tweet
    .command('close')
    .description('Close tweet composer')
    .option('-s, --save', 'Save as draft instead of discarding')
    .action(closeCommand);
// engagement commands
program
    .command('like <url>')
    .description('Like a tweet')
    .action(likeCommand);
program
    .command('retweet <url>')
    .description('Retweet a tweet')
    .action(retweetCommand);
program
    .command('reply <url> <text>')
    .description('Reply to a tweet')
    .option('-m, --media <url>', 'Media URL to attach')
    .action(replyCommand);
program
    .command('follow <username>')
    .description('Follow a user')
    .action(followCommand);
// utility commands
program
    .command('status')
    .description('Check browser extension connection')
    .action(statusCommand);
program
    .command('serve')
    .description('Start bridge server (usually auto-started)')
    .option('-p, --port <port>', 'WebSocket port', '18900')
    .action(serveCommand);
program.parse();
