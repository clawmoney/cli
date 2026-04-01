import chalk from 'chalk';
import { spawn } from 'node:child_process';
/**
 * Post a tweet by delegating to bnbot-cli.
 */
export async function tweetCommand(text, options) {
    const args = ['bnbot', 'x', 'post', text];
    if (options.draft)
        args.push('--draft');
    if (options.media)
        args.push('--media', options.media);
    try {
        const code = await new Promise((resolve, reject) => {
            const child = spawn('npx', args, {
                stdio: 'inherit',
                shell: true,
            });
            child.on('close', (code) => resolve(code || 0));
            child.on('error', reject);
        });
        if (code !== 0)
            process.exit(code);
    }
    catch (err) {
        console.error(chalk.red(err.message));
        console.log(chalk.dim('  Make sure @bnbot/cli is installed: npm install -g @bnbot/cli'));
        process.exit(1);
    }
}
